import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import { getJiraIssue, searchJiraIssues, getBrdMarkdown } from "./bvision_fetch.js";
import { createBrdRequirementIssues } from "./brd_upsave.js";

dotenv.config();

export const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
export const BRD_MASTER_ISSUE_KEY = (process.env.BRD_MASTER_ISSUE_KEY || "KAN-4").trim().toUpperCase();
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

export function getJiraHeaders(): Record<string, string> {
  if (!JIRA_BASE_URL) throw new Error("Missing JIRA_BASE_URL in environment.");
  if (!JIRA_USER_EMAIL || !JIRA_API_TOKEN) throw new Error("Missing JIRA_USER_EMAIL or JIRA_API_TOKEN in environment.");
  const token = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return {
    "Authorization": `Basic ${token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

export function getAttachmentHeaders(): Record<string, string> {
  const headers = getJiraHeaders();
  delete headers["Content-Type"];
  headers["X-Atlassian-Token"] = "no-check";
  return headers;
}

export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("\n");
  
  const chunks = node.type === "text" ? [node.text || ""] : [];
  if (node.content && Array.isArray(node.content)) {
    chunks.push(...node.content.map(adfToText));
  }
  return chunks.filter(Boolean).join(" ");
}

const server = new Server({ name: "BRD-Requirements-Parser", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_jira_issue",
      description: "Fetch issue details and its parent metadata from Jira.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "search_jira_issues",
      description: "Search Jira and return issue keys, summaries, and types.",
      inputSchema: { type: "object", properties: { jql_query: { type: "string" }, max_results: { type: "number" } }, required: ["jql_query"] },
    },
    {
      name: "get_brd_markdown",
      description: "Download the BRD attachment directly from the configured Business Vision Epic.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "create_brd_requirement_issues",
      description: "Create or reuse one Task per FR under the Business Vision Epic.",
      inputSchema: { 
        type: "object", 
        properties: { source_issue_key: { type: "string" }, requirements_json: { type: "string" } }, 
        required: ["source_issue_key", "requirements_json"] 
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
      resultText = await searchJiraIssues(args.jql_query as string, (args.max_results as number) || 20);
    } else if (name === "get_brd_markdown") {
      resultText = await getBrdMarkdown(args.issue_key as string);
    } else if (name === "create_brd_requirement_issues") {
      resultText = await createBrdRequirementIssues(args.source_issue_key as string, args.requirements_json as string);
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
  server.connect(transport).then(() => console.error("BRD Parser MCP Server running on stdio")).catch(console.error);
}
