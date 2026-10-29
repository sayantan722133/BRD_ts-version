import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import { getJiraIssue, searchJiraIssues, getFrdMarkdown } from "./jira_fetch.js";
import { publishArchToJira } from "./jira_publish.js";

dotenv.config();

export const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
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

const server = new Server({ name: "Jira-Arch-Context", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_jira_issue",
      description: "Fetch issue details, description, comments, and parent hierarchy.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "search_jira_issues",
      description: "Search related Jira issues and return descriptions and labels for context.",
      inputSchema: { type: "object", properties: { jql_query: { type: "string" }, max_results: { type: "number" } }, required: ["jql_query"] },
    },
    {
      name: "get_frd_markdown",
      description: "Download FRD Markdown from the Epic or its [FRD] child output task.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "publish_arch_to_jira",
      description: "Create an Architecture Task and discrete component sub-tasks beneath it.",
      inputSchema: { 
        type: "object", 
        properties: { 
          epic_issue_key: { type: "string" },
          arch_markdown: { type: "string" },
          input_issue_keys: { type: "array", items: { type: "string" } },
          components_json: { type: "string" },
          integration_contracts_json: { type: "string" }
        }, 
        required: ["epic_issue_key", "arch_markdown", "input_issue_keys", "components_json"] 
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
      resultText = await searchJiraIssues(args.jql_query as string, (args.max_results as number) || 50);
    } else if (name === "get_frd_markdown") {
      resultText = await getFrdMarkdown(args.issue_key as string);
    } else if (name === "publish_arch_to_jira") {
      resultText = await publishArchToJira(
        args.epic_issue_key as string,
        args.arch_markdown as string,
        args.input_issue_keys as string[],
        args.components_json as string,
        (args.integration_contracts_json as string) || "[]"
      );
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
  server.connect(transport).then(() => console.error("Jira Arch MCP Server running on stdio")).catch(console.error);
}
