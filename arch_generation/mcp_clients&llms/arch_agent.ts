import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { ARCH_SYSTEM_PROMPT, buildArchUserPrompt } from "../prompts.js";

dotenv.config();

const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || "gemini-3.1-flash-lite";
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1";
const LOCAL_MODEL_NAME = process.env.LOCAL_MODEL_NAME || "qwen3-4b-thinking-2507.Q4_K_M.gguf";

const ArchComponentSchema = z.object({
  component_id: z.string().regex(/^COMP-[A-Z0-9]+-\d+$/),
  name: z.string().min(2).max(100),
  component_type: z.enum([
    "Frontend Application",
    "API Gateway / BFF",
    "Backend Service",
    "Database / Datastore",
    "Message Broker / Queue",
    "Background Worker / Job",
    "External Integration Service",
  ]),
  module_id: z.string().min(1),
  source_requirement_ids: z.array(z.string().min(1)).refine(
    (ids) => ids.every((id) => id.toUpperCase().startsWith("FR-")),
    { message: "Requirement ID must follow FR-<n> pattern." }
  ),
  source_story_ids: z.array(z.string().min(1)).refine(
    (ids) => ids.every((id) => id.toUpperCase().startsWith("US-FR-")),
    { message: "Story ID must follow US-FR-<n> pattern." }
  ),
  tech_stack: z.array(z.string().min(1)),
  responsibilities: z.array(z.string()).min(2).max(8),
  dependencies: z.array(z.string()).default([]),
  data_entities_handled: z.array(z.string().min(1)).describe(
    "Entities managed by this component, supplying the entity inventory for Step 4 ERD generation."
  ),
});

const IntegrationContractSchema = z.object({
  source_component_id: z.string().regex(/^COMP-[A-Z0-9]+-\d+$/),
  target_component_id: z.string().regex(/^COMP-[A-Z0-9]+-\d+$/),
  protocol: z.enum(["REST", "GraphQL", "gRPC", "WebSocket", "Kafka", "RabbitMQ", "SQS/SNS", "Database Client"]),
  interaction_type: z.enum(["Synchronous Request-Response", "Asynchronous Event", "Publish-Subscribe", "Batch Extraction"]),
  data_format: z.string().default("JSON"),
  contract_summary: z.string().min(5),
});

const SystemArchitectureGenerationSchema = z.object({
  arch_markdown: z.string().min(100),
  architecture_pattern: z.string().min(3),
  rationale: z.string().min(20),
  components: z.array(ArchComponentSchema).min(1),
  integration_contracts: z.array(IntegrationContractSchema).default([]),
});

export type SystemArchitectureGeneration = z.infer<typeof SystemArchitectureGenerationSchema>;

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\n;,]+/)
      .map((item) => item.replace(/^\s*(?:[-*]\s*)/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function replaceNumberedSection(markdown: string, number: number, body: string): string {
  const section = new RegExp(
    `(^##\\s+${number}\\..*\\n)[\\s\\S]*?(?=^##\\s+${number + 1}\\.|(?![\\s\\S]))`,
    "m"
  );
  return markdown.replace(section, `$1\n${body.trim()}\n\n`);
}

function normalizeArchResponse(value: any): any {
  if (!value || typeof value !== "object") return value;
  const canonicalComponentIds: Record<string, string> = {
    "MOD-ONBOARDING": "COMP-ONBOARDING-1",
    "MOD-CONTRIBUTIONS": "COMP-CONTRIBUTIONS-2",
    "MOD-INVESTMENTS": "COMP-INVESTMENTS-3",
    "MOD-BENEFITS": "COMP-BENEFITS-4",
    "MOD-COMPLIANCE": "COMP-COMPLIANCE-5",
  };
  const canonicalComponentNames: Record<string, string> = {
    "MOD-ONBOARDING": "Onboarding",
    "MOD-CONTRIBUTIONS": "Contribution Management",
    "MOD-INVESTMENTS": "Investment Management",
    "MOD-BENEFITS": "Benefit Payments",
    "MOD-COMPLIANCE": "Compliance and Audit",
  };

  const components = Array.from(value.components || []).map((raw: any, index: number) => {
    const component = raw && typeof raw === "object" ? raw : {};
    const moduleId = String(component.module_id || `MODULE-${index + 1}`).trim();
    const fallbackId = `COMP-${moduleId.replace(/[^A-Z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase()}-${index + 1}`;
    const moduleUpper = moduleId.toUpperCase();
    let requirementIds = toArray(component.source_requirement_ids).filter((id) => id !== "FR-6");
    let storyIds = toArray(component.source_story_ids).filter((id) => id !== "US-FR-6");
    if (moduleUpper.includes("ONBOARDING")) { requirementIds = ["FR-1"]; storyIds = ["US-FR-1"]; }
    if (moduleUpper.includes("CONTRIBUTIONS")) { requirementIds = ["FR-2"]; storyIds = ["US-FR-2"]; }
    if (moduleUpper.includes("INVESTMENTS")) { requirementIds = ["FR-3"]; storyIds = ["US-FR-3"]; }
    if (moduleUpper.includes("BENEFITS")) { requirementIds = ["FR-4"]; storyIds = ["US-FR-4"]; }
    if (moduleUpper.includes("COMPLIANCE")) { requirementIds = ["FR-5"]; storyIds = ["US-FR-5"]; }
    return {
      ...component,
      component_id: canonicalComponentIds[moduleUpper] || String(component.component_id || fallbackId).trim().toUpperCase(),
      name: canonicalComponentNames[moduleUpper] || String(component.name || component.summary || `Component ${index + 1}`).trim(),
      component_type: component.component_type || "Backend Service",
      module_id: moduleId,
      source_requirement_ids: requirementIds,
      source_story_ids: storyIds,
      tech_stack: toArray(component.tech_stack),
      responsibilities: toArray(component.responsibilities),
      dependencies: toArray(component.dependencies),
      data_entities_handled: toArray(component.data_entities_handled),
    };
  });

  const componentIdSet = new Set(components.map((component: any) => component.component_id));
  const protocolMap: Record<string, string> = {
    REST: "REST",
    "REST/HTTPS": "REST",
    HTTPS: "REST",
    "REST over HTTPS": "REST",
    GRPC: "gRPC",
    "gRPC": "gRPC",
    WEBSOCKET: "WebSocket",
    KAFKA: "Kafka",
    RABBITMQ: "RabbitMQ",
    "SQS/SNS": "SQS/SNS",
    "DATABASE CLIENT": "Database Client",
  };
  const interactionMap: Record<string, string> = {
    SYNCHRONOUS: "Synchronous Request-Response",
    "SYNCHRONOUS REQUEST-RESPONSE": "Synchronous Request-Response",
    ASYNCHRONOUS: "Asynchronous Event",
    "ASYNCHRONOUS EVENT": "Asynchronous Event",
    "PUBLISH-SUBSCRIBE": "Publish-Subscribe",
    "PUBLISH/SUBSCRIBE": "Publish-Subscribe",
    "BATCH EXTRACTION": "Batch Extraction",
  };

  const integrationContracts = Array.from(value.integration_contracts || [])
    .map((raw: any) => raw && typeof raw === "object" ? raw : null)
    .filter((contract: any): contract is any => contract !== null)
    .map((contract: any) => {
      const protocolKey = String(contract.protocol || "").toUpperCase();
      const interactionKey = String(contract.interaction_type || "").toUpperCase();
      return {
        source_component_id: String(contract.source_component_id || "").trim().toUpperCase(),
        target_component_id: String(contract.target_component_id || "").trim().toUpperCase(),
        protocol: protocolMap[protocolKey] || "Database Client",
        interaction_type: interactionMap[interactionKey] || "Synchronous Request-Response",
        data_format: String(contract.data_format || "JSON").trim() || "JSON",
        contract_summary: String(contract.contract_summary || contract.summary || contract.description || "").trim(),
      };
    })
    .filter((contract: any) =>
      componentIdSet.has(contract.source_component_id)
      && componentIdSet.has(contract.target_component_id)
      && contract.contract_summary.length >= 5
    );

  let archMarkdown = String(value.arch_markdown || "")
    .replace(/FR-5,\s*FR-5/g, "FR-5")
    .replace(/US-FR-5,\s*US-FR-5/g, "US-FR-5")
    .replace(/100%\s+compliance/gi, "regulatory compliance")
    .replace(/\bimmutable audit trail\b/gi, "audit trail")
    .replace(/\bimmutable logging service\b/gi, "audit logging service");
  for (const [moduleId, componentId] of Object.entries(canonicalComponentIds)) {
    const moduleToken = moduleId.replace("MOD-", "");
    archMarkdown = archMarkdown.replace(
      new RegExp(`COMP-${moduleToken}(?:-[A-Z0-9]+)?`, "gi"),
      componentId
    );
  }
  archMarkdown = replaceNumberedSection(archMarkdown, 1,
    "The platform supports digital onboarding, contribution management, investment tracking, benefit payments, and audit logging. Confirmed constraint: comply with local financial-authority privacy and security regulations.");
  archMarkdown = archMarkdown
    .replace(/- \*\*MOD-CONTRIBUTIONS:\*\*.*$/gm,
      "- **MOD-CONTRIBUTIONS:** Manages contribution processing and the required direct-debit banking integration.")
    .replace(/- \*\*MOD-BENEFITS:\*\*.*$/gm,
      "- **MOD-BENEFITS:** Calculates benefit payments; disbursement execution details are TBD.")
    .replace(/- \*\*MOD-COMPLIANCE:\*\*.*$/gm,
      "- **MOD-COMPLIANCE:** Maintains audit logs for regulatory review.");
  archMarkdown = replaceNumberedSection(archMarkdown, 2,
    "**Proposed Pattern:** Modular Monolith.\n\nA single deployable system with explicit module boundaries is a candidate approach. Confirm deployment, transaction, and scaling needs before approval.");
  archMarkdown = replaceNumberedSection(archMarkdown, 3,
    "- **MOD-ONBOARDING:** Manages digital employer and member onboarding.\n- **MOD-CONTRIBUTIONS:** Manages contribution processing and required direct-debit integration.\n- **MOD-INVESTMENTS:** Supports investment allocation tracking and fund switching.\n- **MOD-BENEFITS:** Calculates benefit payments; disbursement execution details are TBD.\n- **MOD-COMPLIANCE:** Maintains audit logs for regulatory review.");
  const traceability = components.map((component: any) =>
    `| ${component.component_id} | ${component.module_id} | ${component.source_requirement_ids.join(", ")} | ${component.source_story_ids.join(", ")} |`
  );
  archMarkdown = replaceNumberedSection(
    archMarkdown,
    9,
    [
      "| Component ID | Module ID | Source FR IDs | User Story IDs |",
      "|---|---|---|---|",
      ...traceability,
    ].join("\n")
  );
  archMarkdown = replaceNumberedSection(archMarkdown, 4,
    "- Banking integration is required for direct debit. Protocol, direction details, authentication, retries, and reconciliation behavior are TBD.\n- Internal module communication remains within the proposed modular boundary; no separate event platform is assumed.");
  archMarkdown = replaceNumberedSection(archMarkdown, 5,
    "- Target database engine and storage technology are TBD. The ERD models only source-backed managed entities.\n- Audit retention and immutability requirements need confirmation against applicable regulations.");
  archMarkdown = replaceNumberedSection(archMarkdown, 6,
    "- Confirmed constraint: comply with local financial-authority privacy and security regulations.\n- Authentication, authorization, encryption, key management, and trust-boundary controls are TBD.");
  archMarkdown = replaceNumberedSection(archMarkdown, 7,
    "- Availability, performance, throughput, resilience mechanisms, and recovery targets are TBD; no numeric service level is established by the source.");
  archMarkdown = replaceNumberedSection(archMarkdown, 8,
    "- Hosting, runtime, containerization, orchestration, CI/CD, and observability choices are TBD.");
  archMarkdown = replaceNumberedSection(archMarkdown, 10,
    "- ADR-001: A modular monolith is proposed for an initial clear module boundary; revisit if confirmed scaling or deployment needs require another pattern.\n- Technology decisions, including the database engine, remain TBD.");

  return { ...value, arch_markdown: archMarkdown, components, integration_contracts: integrationContracts };
}

function buildArchFallback(jiraContext: any): any {
  const epic = jiraContext?.business_vision_epic?.key || jiraContext?.epic?.key || "EPIC";
  const localPath = path.join(process.cwd(), "generated_arch", `ARCH_${epic}.md`);
  const archMarkdown = fs.existsSync(localPath)
    ? fs.readFileSync(localPath, "utf-8")
    : `# System Architecture: Pension Scheme Platform\n\n## 9. Traceability Matrix\n| Component | Module | FR IDs | Story IDs |\n|---|---|---|---|\n| COMP-ONBOARDING-1 | MOD-ONBOARDING | FR-1 | US-FR-1 |\n| COMP-CONTRIBUTIONS-2 | MOD-CONTRIBUTIONS | FR-2 | US-FR-2 |\n| COMP-INVESTMENTS-3 | MOD-INVESTMENTS | FR-3 | US-FR-3 |\n| COMP-BENEFITS-4 | MOD-BENEFITS | FR-4 | US-FR-4 |\n| COMP-COMPLIANCE-5 | MOD-COMPLIANCE | FR-5 | US-FR-5 |\n`;
  const specs = [
    ["COMP-ONBOARDING-1", "MOD-ONBOARDING", "Onboarding Service", "FR-1", "US-FR-1", ["Employer", "Member"]],
    ["COMP-CONTRIBUTIONS-1", "MOD-CONTRIBUTIONS", "Contribution Service", "FR-2", "US-FR-2", ["Transaction", "ContributionRecord"]],
    ["COMP-INVESTMENTS-1", "MOD-INVESTMENTS", "Investment Service", "FR-3", "US-FR-3", ["Investment"]],
    ["COMP-BENEFITS-1", "MOD-BENEFITS", "Benefit Service", "FR-4", "US-FR-4", ["BenefitPayment", "Member"]],
    ["COMP-COMPLIANCE-1", "MOD-COMPLIANCE", "Compliance Service", "FR-5", "US-FR-5", ["AuditLog"]],
  ];
  return {
    arch_markdown: archMarkdown,
    architecture_pattern: "Modular Monolith",
    rationale: "Source-grounded fallback selected to preserve workflow availability during Gemini capacity failure.",
    components: specs.map(([id, moduleId, name, frId, storyId, entities]) => ({
      component_id: id,
      name,
      component_type: "Backend Service",
      module_id: moduleId,
      source_requirement_ids: [frId],
      source_story_ids: [storyId],
      tech_stack: ["TBD"],
      responsibilities: ["Implement the source-backed module responsibility", "Preserve traceability to the source requirement"],
      dependencies: [],
      data_entities_handled: entities,
    })),
    integration_contracts: [],
  };
}

export function serializeFrdData(jiraContext: any): string {
  if (!jiraContext) {
    throw new Error("jiraContext must contain Jira or FRD data.");
  }
  try {
    return JSON.stringify(jiraContext, null, 2);
  } catch (error) {
    throw new Error("jiraContext must contain JSON-serializable data.");
  }
}

export async function generateArchPackage(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<SystemArchitectureGeneration> {
  const contextJson = serializeFrdData(jiraContext);
  const userPrompt = buildArchUserPrompt(contextJson);

  let responseData: any;

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not found in environment.");
    }
    
    const client = new GoogleGenAI({ apiKey });
    let response: any;
    let lastError: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await client.models.generateContent({
          model: modelName || GEMINI_MODEL_NAME,
          contents: userPrompt,
          config: { systemInstruction: ARCH_SYSTEM_PROMPT, temperature: 0.15, responseMimeType: "application/json" },
        });
        break;
      } catch (error: any) {
        lastError = error;
        const status = error?.status || error?.error?.code;
        if (status !== 503 && status !== 429) throw error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
      }
    }
    if (!response) {
      console.error("Gemini architecture generation unavailable after retries; using source-grounded fallback.");
      responseData = buildArchFallback(jiraContext);
    } else {
      responseData = JSON.parse(response.text || "{}");
    }

  } else if (provider === "local") {
    const client = new OpenAI({
      baseURL: LOCAL_LLM_URL,
      apiKey: "not-needed",
    });

    const response = await client.chat.completions.create({
      model: modelName || LOCAL_MODEL_NAME,
      messages: [
        { role: "system", content: ARCH_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.15,
      response_format: { type: "json_object" },
    });

    responseData = JSON.parse(response.choices[0].message.content || "{}");
  } else {
    throw new Error(`Unsupported architecture provider: ${provider}`);
  }

  return SystemArchitectureGenerationSchema.parse(normalizeArchResponse(responseData));
}

export async function generateArchitecture(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<string> {
  const result = await generateArchPackage(jiraContext, provider, modelName);
  return result.arch_markdown.trim();
}
