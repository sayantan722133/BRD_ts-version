import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import { getArchContext, getJiraIssue, searchJiraIssues } from "./jira_fetch.js";
import { publishErdToJira } from "./jira_publish.js";

dotenv.config();

export const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

export function getJiraHeaders(): Record<string, string> {
  if (!JIRA_BASE_URL) throw new Error("Missing JIRA_BASE_URL in environment.");
  if (!JIRA_USER_EMAIL || !JIRA_API_TOKEN) throw new Error("Missing JIRA_USER_EMAIL or JIRA_API_TOKEN in environment.");
  return {
    Authorization: `Basic ${Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
    Accept: "application/json",
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
  const chunks: string[] = [];
  if (node.type === "text") chunks.push(node.text || "");
  if (Array.isArray(node.content)) chunks.push(...node.content.map(adfToText));
  return chunks.filter(Boolean).join(node.type === "text" ? "" : " ");
}

export function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const server = new Server({ name: "Jira-ERD-Context", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "get_jira_issue", description: "Fetch issue details and parent hierarchy.", inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] } },
    { name: "search_jira_issues", description: "Search Jira issues.", inputSchema: { type: "object", properties: { jql_query: { type: "string" }, max_results: { type: "number" } }, required: ["jql_query"] } },
    { name: "get_arch_context", description: "Fetch FRD and architecture component context for ERD generation.", inputSchema: { type: "object", properties: { epic_key: { type: "string" } }, required: ["epic_key"] } },
    { name: "publish_erd_to_jira", description: "Create or update an ERD document task and entity subtasks.", inputSchema: { type: "object", properties: { epic_issue_key: { type: "string" }, erd_markdown: { type: "string" }, entities_json: { type: "string" } }, required: ["epic_issue_key", "erd_markdown", "entities_json"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments ?? {};
    let text = "";
    switch (request.params.name) {
      case "get_jira_issue":
        text = await getJiraIssue(args.issue_key as string);
        break;
      case "search_jira_issues":
        text = await searchJiraIssues(args.jql_query as string, (args.max_results as number) || 50);
        break;
      case "get_arch_context":
        text = await getArchContext(args.epic_key as string);
        break;
      case "publish_erd_to_jira":
        text = await publishErdToJira(args.epic_issue_key as string, args.erd_markdown as string, args.entities_json as string);
        break;
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
    return { content: [{ type: "text", text }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => console.error("Jira ERD MCP Server running on stdio")).catch(console.error);
}
