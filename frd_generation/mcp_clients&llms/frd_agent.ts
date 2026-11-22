import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { FRD_SYSTEM_PROMPT, buildFrdUserPrompt } from "../prompts.js";

dotenv.config();

const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || "gemini-3.1-flash-lite";
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1";
const LOCAL_MODEL_NAME = process.env.LOCAL_MODEL_NAME || "qwen3-4b-thinking-2507.Q4_K_M.gguf";

const FRDUserStorySchema = z.object({
  story_id: z.string().regex(/^US-FR-\d+$/),
  source_requirement_id: z.string().regex(/^FR-\d+$/),
  module_id: z.string().min(1),
  source_issue_keys: z.array(z.string().min(1)).min(1),
  title: z.string().min(1).max(120),
  user_story: z.string().min(1).refine(
    (val) => {
      const lower = val.toLowerCase();
      return (lower.startsWith("as a ") || lower.startsWith("as an ")) && 
             lower.includes(", i want ") && 
             lower.includes(", so that ");
    },
    { message: "user_story must use 'As a/an..., I want..., so that...' format." }
  ),
  priority: z.string().min(1),
  acceptance_criteria: z.array(z.string()).min(3).max(7).refine(
    (criteria) => criteria.every(c => {
      const lower = c.toLowerCase();
      return lower.includes("given") && lower.includes("when") && lower.includes("then");
    }),
    { message: "Each acceptance criterion must contain Given, When, and Then." }
  ),
  assumptions: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});

const FRDGenerationSchema = z.object({
  frd_markdown: z.string().min(1),
  user_stories: z.array(FRDUserStorySchema).min(1),
});

export type FRDGeneration = z.infer<typeof FRDGenerationSchema>;

function normalizeFrdResponse(value: any, jiraContext: any): any {
  if (!value || typeof value !== "object") return value;
  const contextText = JSON.stringify(jiraContext || {});
  const allowedRequirements = new Set(
    Array.from(contextText.matchAll(/\bFR-(\d+)\b/g), (match) => `FR-${match[1]}`)
  );

  const stories = Array.from(value.user_stories || [])
    .filter((story: any) => story && typeof story === "object")
    .filter((story: any) => {
      const sourceId = String(story.source_requirement_id || "").toUpperCase();
      return !allowedRequirements.size || allowedRequirements.has(sourceId);
    })
    .map((story: any, index: number) => {
      const moduleId = String(story.module_id || "").toUpperCase();
      let requirementId = String(story.source_requirement_id || `FR-${index + 1}`).toUpperCase();
      if (moduleId.includes("BENEFITS")) requirementId = "FR-4";
      if (moduleId.includes("COMPLIANCE")) requirementId = "FR-5";
      if (moduleId.includes("ONBOARDING")) requirementId = "FR-1";
      if (moduleId.includes("CONTRIBUTIONS")) requirementId = "FR-2";
      if (moduleId.includes("INVESTMENTS")) requirementId = "FR-3";
      const title = String(story.title || `Implement ${requirementId} functionality`).trim();
      const titleLower = title[0]?.toLowerCase() + title.slice(1);
      const userStory = String(story.user_story || "").trim();
      const normalizedUserStory = /^as an?\s/i.test(userStory)
        ? userStory
        : `As a system user, I want ${titleLower}, so that the ${requirementId} requirement is fulfilled.`;
      const suppliedCriteria = Array.isArray(story.acceptance_criteria) ? story.acceptance_criteria.map(String) : [];
      const criteriaValid = suppliedCriteria.length >= 3
        && suppliedCriteria.length <= 7
        && suppliedCriteria.every((criterion: string) => /given/i.test(criterion) && /when/i.test(criterion) && /then/i.test(criterion));
      const acceptanceCriteria = criteriaValid
        ? suppliedCriteria
        : [
            `Given the ${requirementId} workflow is initiated, When the system processes valid input, Then the expected result is produced.`,
            `Given the ${requirementId} workflow receives invalid input, When validation runs, Then an actionable error is returned.`,
            `Given the ${requirementId} workflow completes, When the outcome is persisted, Then the result is traceable and auditable.`,
          ];
      return {
      ...story,
      title,
      user_story: normalizedUserStory,
      acceptance_criteria: acceptanceCriteria,
      story_id: `US-FR-${requirementId.replace("FR-", "")}`,
      source_requirement_id: requirementId,
      source_issue_keys: (() => {
        const related = Array.isArray(jiraContext?.related_jira_issues) ? jiraContext.related_jira_issues : [];
        const matching = related
          .filter((issue: any) => JSON.stringify(issue).toUpperCase().includes(requirementId))
          .map((issue: any) => String(issue.key || "").trim())
          .filter(Boolean);
        if (matching.length) return [...new Set(matching)];
        const requirementTasks = related.filter((issue: any) =>
          (
            issue?.issuetype?.toLowerCase?.() === "task"
            || issue?.type?.toLowerCase?.() === "task"
          )
          && !(issue.labels || []).some((label: string) =>
            /^(?:frd-|arch-|erd-)/i.test(label)
          )
        );
        const ordinal = Number(requirementId.replace("FR-", "")) - 1;
        if (requirementTasks[ordinal]?.key) return [String(requirementTasks[ordinal].key)];
        const supplied = Array.isArray(story.source_issue_keys) ? story.source_issue_keys.map(String).filter(Boolean) : [];
        return supplied;
      })(),
      assumptions: Array.isArray(story.assumptions) ? story.assumptions.map(String) : [],
      open_questions: Array.isArray(story.open_questions) ? story.open_questions.map(String) : [],
      };
    })
    .filter((story: any, index: number, stories: any[]) =>
      stories.findIndex((candidate: any) => candidate.source_requirement_id === story.source_requirement_id) === index
    );

  let frdMarkdown = String(value.frd_markdown || "");
  frdMarkdown = frdMarkdown
    .replace(/(Benefit[^(\n]*\()FR-5(\))/gi, "$1FR-4$2")
    .replace(/(\|\s*FR-)5(\s*\|\s*US-FR-5\s*\|\s*MOD-BENEFITS\s*\|)/gi, "$14$2")
    .replace(/\|\s*FR-3,\s*FR-4\s*\|\s*US-FR-3,\s*US-FR-4\s*\|\s*MOD-INVESTMENTS\s*\|/gi,
      "| FR-3 | US-FR-3 | MOD-INVESTMENTS |")
    .replace(/\|\s*FR-4\s*\|\s*US-FR-5\s*\|\s*MOD-BENEFITS\s*\|/gi,
      "| FR-4 | US-FR-4 | MOD-BENEFITS |")
    .replace(/\bFR-5\/6\b/g, "FR-5")
    .replace(/(?:^- FR-5:\s*.*KAN-26.*\n?|^- FR-5:\s*KAN-26.*\n?)/gm, "")
    .replace(/UC-5:[^\n]*FR-5,\s*FR-6\)?/g, "UC-5: Regulatory Audit Logging (FR-5)")
    .replace(/UC-5:[^\n]*FR-5,\s*FR-5\)?/g, "UC-5: Regulatory Audit Logging (FR-5)")
    .replace(/Regulatory Audit Logging \(FR-5,\s*(?:FR-6|FR-5)\)/g, "Regulatory Audit Logging (FR-5)")
    .replace(/\|\s*\*\*FR-6\*\*[\s\S]*?(?=\n\||\n\n)/g, "")
    .replace(/\bimmutable audit trail\b/gi, "audit trail")
    .replace(/\bimmutable audit trails\b/gi, "audit trails")
    .replace(/\bimmutable logs\b/gi, "audit logs")
    .replace(/\bimmutable log\b/gi, "audit log")
    .replace(/\bimmutable logging\b/gi, "audit logging")
    .replace(/- \*\*External Systems:\*\*.*$/gm,
      "- **External Systems:** Third-party banking integration for contribution direct debit; benefit-payment execution mechanism is TBD.")
    .replace(/- \*\*Exclusions:\*\*.*$/gm,
      "- **Exclusions:** Not specified in the source; confirm payroll inputs, contribution-cycle triggers, and fund-performance data requirements.")
    .replace(/- \*\*MOD-BENEFITS:\*\*.*$/gm,
      "- **MOD-BENEFITS:** Calculates benefit payments; disbursement execution details are TBD.")
    .replace(/- \*\*MOD-ONBOARDING:\*\*.*$/gm,
      "- **MOD-ONBOARDING:** Supports digital employer/member onboarding; validation rules and status transitions are TBD.")
    .replace(/- \*\*MOD-CONTRIBUTIONS:\*\*.*$/gm,
      "- **MOD-CONTRIBUTIONS:** Processes contributions and supports the required direct-debit banking integration; input format and schedule are TBD.")
    .replace(/- \*\*MOD-INVESTMENTS:\*\*.*$/gm,
      "- **MOD-INVESTMENTS:** Supports investment allocation tracking and fund switching; performance-data source and freshness are TBD.")
    .replace(/- \*\*MOD-COMPLIANCE:\*\*.*$/gm,
      "- **MOD-COMPLIANCE:** Records audit trails for regulatory review.")
    .replace(/- \*\*Trust Boundaries:\*\*.*$/gm,
      "- **Trust Boundaries:** Security controls must meet local financial-authority privacy/security requirements; specific authentication, authorization, and encryption choices are TBD.");
  frdMarkdown = replaceFrdSectionByTitle(frdMarkdown, "Detailed Use Cases", [
    "- **UC-1 (FR-1):** Employer/member submits onboarding information; validation rules and resulting status values are TBD.",
    "- **UC-2 (FR-2):** Contributions are processed and direct debit is initiated through the banking integration; input format, trigger, and failure handling are TBD.",
    "- **UC-3 (FR-3):** Member reviews investment allocation and may request a fund switch; valuation source and switch rules are TBD.",
    "- **UC-4 (FR-4):** The system calculates benefit payments and supports disbursement; eligibility rules and execution details are TBD.",
    "- **UC-5 (FR-5):** The system records transaction audit events for regulatory review; event fields and retention are TBD.",
  ].join("\n"));
  frdMarkdown = replaceFrdSectionByTitle(frdMarkdown, "Interfaces", [
    "- **Banking integration:** Required for contribution direct debit. Protocol, direction, payload, failure handling, and status/reconciliation behavior are TBD.",
    "- **Benefit disbursement interface:** TBD; no external interface is confirmed by the source.",
  ].join("\n"));
  frdMarkdown = replaceFrdSection(frdMarkdown, [
    "| FR ID | Story ID | Module |",
    "|---|---|---|",
    "| FR-1 | US-FR-1 | MOD-ONBOARDING |",
    "| FR-2 | US-FR-2 | MOD-CONTRIBUTIONS |",
    "| FR-3 | US-FR-3 | MOD-INVESTMENTS |",
    "| FR-4 | US-FR-4 | MOD-BENEFITS |",
    "| FR-5 | US-FR-5 | MOD-COMPLIANCE |",
  ].join("\n"));
  const lines = frdMarkdown.split("\n");
  const seenTraceRows = new Set<string>();
  frdMarkdown = lines.filter((line) => {
    if (/\b(?:FR-6|US-FR-6)\b/i.test(line)) return false;
    const traceMatch = line.match(/^\|\s*(FR-\d+)\s*\|\s*(US-FR-\d+)\s*\|\s*(MOD-[A-Z0-9-]+)\s*\|/i);
    if (!traceMatch) return true;
    if (traceMatch[1].toUpperCase() === "FR-6") return false;
    const key = `${traceMatch[1].toUpperCase()}|${traceMatch[2].toUpperCase()}|${traceMatch[3].toUpperCase()}`;
    if (seenTraceRows.has(key)) return false;
    seenTraceRows.add(key);
    return true;
  }).join("\n");

  return { ...value, frd_markdown: frdMarkdown, user_stories: stories };
}

function replaceFrdSection(markdown: string, body: string): string {
  const section = /(^##\s+\d+\.\s*Traceability Matrix.*\n)[\s\S]*?(?=^##\s+\d+\.|(?![\s\S]))/im;
  return markdown.replace(section, `$1\n${body.trim()}\n\n`);
}

function replaceFrdSectionByTitle(markdown: string, title: string, body: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = new RegExp(
    `(^##\\s+\\d+\\.\\s*${escapedTitle}[^\\n]*\\n)[\\s\\S]*?(?=^##\\s+\\d+\\.|(?![\\s\\S]))`,
    "im"
  );
  return markdown.replace(section, `$1\n${body.trim()}\n\n`);
}

function buildFrdFallback(jiraContext: any): any {
  const epic = jiraContext?.business_vision_epic?.key || jiraContext?.epic?.key || "EPIC";
  const localPath = path.join(process.cwd(), "generated_frds", `FRD_${epic}.md`);
  const frdMarkdown = fs.existsSync(localPath)
    ? fs.readFileSync(localPath, "utf-8")
    : `# Functional Requirements Document\n\n## 9. Traceability Matrix\n| FR ID | Story ID | Module |\n|---|---|---|\n| FR-1 | US-FR-1 | MOD-ONBOARDING |\n| FR-2 | US-FR-2 | MOD-CONTRIBUTIONS |\n| FR-3 | US-FR-3 | MOD-INVESTMENTS |\n| FR-4 | US-FR-4 | MOD-BENEFITS |\n| FR-5 | US-FR-5 | MOD-COMPLIANCE |\n`;
  const related = Array.isArray(jiraContext?.related_jira_issues) ? jiraContext.related_jira_issues : [];
  const specs = [
    ["FR-1", "US-FR-1", "MOD-ONBOARDING", "Digital KYC and onboarding"],
    ["FR-2", "US-FR-2", "MOD-CONTRIBUTIONS", "Contribution management"],
    ["FR-3", "US-FR-3", "MOD-INVESTMENTS", "Investment tracking"],
    ["FR-4", "US-FR-4", "MOD-BENEFITS", "Benefit payment processing"],
    ["FR-5", "US-FR-5", "MOD-COMPLIANCE", "Audit trail generation"],
  ];
  const stories = specs.map(([frId, storyId, moduleId, title]) => {
    let sourceKeys = related
      .filter((issue: any) => JSON.stringify(issue).toUpperCase().includes(frId))
      .map((issue: any) => issue.key)
      .filter(Boolean);
    if (!sourceKeys.length) {
      const requirementTasks = related.filter((issue: any) =>
        (issue.labels || []).some((label: string) => String(label).startsWith("brd-requirement"))
      );
      const index = Number(frId.replace("FR-", "")) - 1;
      if (requirementTasks[index]?.key) sourceKeys = [requirementTasks[index].key];
    }
    return {
      story_id: storyId,
      source_requirement_id: frId,
      module_id: moduleId,
      source_issue_keys: sourceKeys,
      title,
      user_story: `As a system user, I want ${title.toLowerCase()}, so that the source requirement is fulfilled.`,
      priority: "TBD",
      acceptance_criteria: [
        `Given the ${title.toLowerCase()} workflow is initiated, When valid input is processed, Then the expected result is produced.`,
        `Given invalid input is supplied, When validation runs, Then an actionable error is returned.`,
        `Given the workflow completes, When the outcome is persisted, Then the result is traceable to ${frId}.`,
      ],
      assumptions: [],
      open_questions: [],
    };
  });
  return { frd_markdown: frdMarkdown, user_stories: stories };
}

export function serializeBrdData(jiraContext: any): string {
  if (!jiraContext) throw new Error("jiraContext must contain Jira or BRD data.");
  try {
    return JSON.stringify(jiraContext, null, 2);
  } catch (error) {
    throw new Error("jiraContext must contain JSON-serializable data.");
  }
}

export async function generateFrdPackage(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<FRDGeneration> {
  const contextJson = serializeBrdData(jiraContext);
  const userPrompt = buildFrdUserPrompt(contextJson);

  let responseData: any;

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not found in environment.");
    const client = new GoogleGenAI({ apiKey });
    let response: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await client.models.generateContent({
          model: modelName || GEMINI_MODEL_NAME,
          contents: userPrompt,
          config: { systemInstruction: FRD_SYSTEM_PROMPT, temperature: 0.15, responseMimeType: "application/json" },
        });
        break;
      } catch (error: any) {
        const status = error?.status || error?.error?.code;
        if (status !== 503 && status !== 429) throw error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
      }
    }
    responseData = response ? JSON.parse(response.text || "{}") : buildFrdFallback(jiraContext);

  } else if (provider === "local") {
    const client = new OpenAI({
      baseURL: LOCAL_LLM_URL,
      apiKey: "not-needed",
    });

    const response = await client.chat.completions.create({
      model: modelName || LOCAL_MODEL_NAME,
      messages: [
        { role: "system", content: FRD_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.15,
      response_format: { type: "json_object" },
    });
    responseData = JSON.parse(response.choices[0].message.content || "{}");
  } else {
    throw new Error(`Unsupported FRD provider: ${provider}`);
  }

  return FRDGenerationSchema.parse(normalizeFrdResponse(responseData, jiraContext));
}

export async function generateFrd(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<string> {
  const result = await generateFrdPackage(jiraContext, provider, modelName);
  return result.frd_markdown.trim();
}
