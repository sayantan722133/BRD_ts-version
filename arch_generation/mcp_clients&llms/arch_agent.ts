import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
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
  integration_contracts: z.array(IntegrationContractSchema).min(1),
});

export type SystemArchitectureGeneration = z.infer<typeof SystemArchitectureGenerationSchema>;

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
    const response = await client.models.generateContent({
      model: modelName || GEMINI_MODEL_NAME,
      contents: userPrompt,
      config: {
        systemInstruction: ARCH_SYSTEM_PROMPT,
        temperature: 0.15,
        responseMimeType: "application/json",
      },
    });

    responseData = JSON.parse(response.text || "{}");

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

  return SystemArchitectureGenerationSchema.parse(responseData);
}

export async function generateArchitecture(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<string> {
  const result = await generateArchPackage(jiraContext, provider, modelName);
  return result.arch_markdown.trim();
}
