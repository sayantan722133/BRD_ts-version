import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getJiraIssue, searchJiraIssues } from "./bvision_fetch.js";
import { saveBrdFile, publishBrdToJira } from "./brd_upsave.js";

dotenv.config();

export const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

export function getJiraHeaders(): Record<string, string> {
  if (!JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Missing JIRA_USER_EMAIL or JIRA_API_TOKEN in environment.");
  }
  const token = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return {
    "Authorization": `Basic ${token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

export function getJiraAuthHeaders(): Record<string, string> {
  const headers = getJiraHeaders();
  delete headers["Content-Type"];
  headers["X-Atlassian-Token"] = "no-check";
  return headers;
}

export function normalizeBrdFilename(fileName: string): string {
  let safeName = path.basename(fileName.trim());
  if (!safeName) throw new Error("file_name must not be empty.");
  if (!safeName.endsWith(".md")) safeName += ".md";
  return safeName;
}

export function saveBrdContent(fileName: string, markdownContent: string): string {
  const safeName = normalizeBrdFilename(fileName);
  const outputDir = "generated_brds";
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, safeName);
  fs.writeFileSync(filePath, markdownContent, "utf-8");
  return path.resolve(filePath);
}

export function extractAdfText(adfNode: any): string {
  if (!adfNode) return "";
  if (typeof adfNode === "string") return adfNode;
  if (Array.isArray(adfNode)) return adfNode.map(extractAdfText).join("\n");

  const textChunks: string[] = [];
  if (adfNode.type === "text") textChunks.push(adfNode.text || "");
  
  if (adfNode.content) {
    for (const child of adfNode.content) {
      textChunks.push(extractAdfText(child));
    }
  }
  return textChunks.filter(Boolean).join(" ");
}

const server = new Server({ name: "Jira-BRD-Server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_jira_issue",
      description: "Fetch summary, type, description, status, and recent comments for a Jira issue.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "search_jira_issues",
      description: "Search for related Jira issues using Jira Query Language.",
      inputSchema: { type: "object", properties: { jql_query: { type: "string" }, max_results: { type: "number" } }, required: ["jql_query"] },
    },
    {
      name: "save_brd_file",
      description: "Save the generated BRD as a local Markdown file.",
      inputSchema: { type: "object", properties: { file_name: { type: "string" }, markdown_content: { type: "string" } }, required: ["file_name", "markdown_content"] },
    },
    {
      name: "publish_brd_to_jira",
      description: "Save or replace the BRD attachment without duplicate files or comments.",
      inputSchema: { 
        type: "object", 
        properties: { issue_key: { type: "string" }, file_name: { type: "string" }, markdown_content: { type: "string" }, comment: { type: "string" } }, 
        required: ["issue_key", "file_name", "markdown_content"] 
      },
    }
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  try {
    let resultText = "";
    if (name === "get_jira_issue") {
      resultText = await getJiraIssue(args.issue_key as string);
    } else if (name === "search_jira_issues") {
      resultText = await searchJiraIssues(args.jql_query as string, (args.max_results as number) || 5);
    } else if (name === "save_brd_file") {
      resultText = await saveBrdFile(args.file_name as string, args.markdown_content as string);
    } else if (name === "publish_brd_to_jira") {
      resultText = await publishBrdToJira(args.issue_key as string, args.file_name as string, args.markdown_content as string, (args.comment as string) || "");
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: resultText }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => console.error("Jira BRD MCP Server running on stdio")).catch(console.error);
}
