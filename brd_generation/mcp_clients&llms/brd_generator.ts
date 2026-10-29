import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import { buildSystemPrompt, buildGenerationPrompt } from "../prompts.js";

dotenv.config();

function mcpToGeminiDeclarations(mcpTools: any[]) {
  return mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema || {},
  }));
}

function mcpToOpenAiTools(mcpTools: any[]) {
  return mcpTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

export async function generateBrd(session: any, jiraKey: string, mcpTools: any[], provider: string) {
  if (provider === "gemini") {
    await generateWithGemini(session, jiraKey, mcpTools);
  } else if (provider === "local") {
    await generateWithLocalModel(session, jiraKey, mcpTools);
  } else {
    throw new Error(`Unsupported model provider: ${provider}`);
  }
}

async function generateWithGemini(session: any, jiraKey: string, mcpTools: any[]) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not found in environment.");

  const geminiClient = new GoogleGenAI({ apiKey });
  const geminiTools = [{ functionDeclarations: mcpToGeminiDeclarations(mcpTools) }];
  const conversationHistory: any[] = [
    { role: "user", parts: [{ text: buildGenerationPrompt(jiraKey) }] }
  ];

  for (let i = 0; i < 10; i++) {
    const response = await geminiClient.models.generateContent({
      model: process.env.GEMINI_MODEL_NAME || "gemini-3.1-flash-lite",
      contents: conversationHistory,
      config: {
        systemInstruction: buildSystemPrompt(),
        tools: geminiTools,
        temperature: 0.18,
      },
    });

    const functionCalls = response.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      console.log("\n=== Agent Response ===");
      console.log(response.text);
      return;
    }

    const candidateContent = response.candidates?.[0]?.content;
    if (!candidateContent) {
      throw new Error("Gemini returned function calls without candidate content.");
    }
    conversationHistory.push(candidateContent);
    const toolResponseParts = [];

    for (const call of functionCalls) {
      console.log(`-> Executing tool '${call.name}' with args:`, call.args);
      const toolOutput = await session.callTool({ name: call.name, arguments: call.args || {} });
      const textResult = toolOutput.content.map((c: any) => c.text).join("\n");
      
      toolResponseParts.push({
        functionResponse: {
          name: call.name,
          response: { result: textResult },
        },
      });
    }
    conversationHistory.push({ role: "user", parts: toolResponseParts });
  }

  throw new Error("Gemini tool-call limit reached before BRD generation completed.");
}

async function generateWithLocalModel(session: any, jiraKey: string, mcpTools: any[]) {
  const client = new OpenAI({
    baseURL: process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1",
    apiKey: "not-needed",
  });

  const messages: any[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildGenerationPrompt(jiraKey) },
  ];
  const openaiTools = mcpToOpenAiTools(mcpTools);

  for (let i = 0; i < 10; i++) {
    const response = await client.chat.completions.create({
      model: process.env.LOCAL_MODEL_NAME || "qwen3-4b-thinking-2507.Q4_K_M.gguf",
      messages,
      tools: openaiTools,
      tool_choice: "auto",
      temperature: 0.18,
    });

    const responseMessage = response.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      console.log("\n=== Agent Response ===");
      console.log(responseMessage.content);
      return;
    }

    messages.push(responseMessage);

    for (const call of toolCalls) {
      const args = typeof call.function.arguments === "string" 
        ? JSON.parse(call.function.arguments) 
        : call.function.arguments;

      console.log(`-> Executing tool '${call.function.name}' with args:`, args);
      const toolOutput = await session.callTool({ name: call.function.name, arguments: args });
      const textResult = toolOutput.content.map((c: any) => c.text).join("\n");

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: textResult,
      });
    }
  }

  throw new Error("Local model tool-call limit reached before BRD generation completed.");
}
