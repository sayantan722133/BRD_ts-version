import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
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
    const response = await client.models.generateContent({
      model: modelName || GEMINI_MODEL_NAME,
      contents: userPrompt,
      config: {
        systemInstruction: FRD_SYSTEM_PROMPT,
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

  return FRDGenerationSchema.parse(responseData);
}

export async function generateFrd(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<string> {
  const result = await generateFrdPackage(jiraContext, provider, modelName);
  return result.frd_markdown.trim();
}
