import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getJiraIssue, searchJiraIssues, getBrdMarkdown } from "./jira_fetch.js";
import { publishFrdToJira } from "./jira_publish.js";
import * as dotenv from "dotenv";

dotenv.config();

const server = new Server({ name: "Jira-FRD-Context", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_jira_issue",
      description: "Fetch issue details, description, comments, and parent hierarchy.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "get_brd_markdown",
      description: "Download the BRD_<EPIC_KEY>.md attachment from a Business Vision Epic.",
      inputSchema: { type: "object", properties: { issue_key: { type: "string" } }, required: ["issue_key"] },
    },
    {
      name: "search_jira_issues",
      description: "Search related Jira issues and return descriptions and status for context.",
      inputSchema: { 
        type: "object", 
        properties: { jql_query: { type: "string" }, max_results: { type: "number" } }, 
        required: ["jql_query"] 
      },
    },
    {
      name: "publish_frd_to_jira",
      description: "Create or update an FRD Task and its story sub-tasks.",
      inputSchema: { 
        type: "object", 
        properties: { 
          epic_issue_key: { type: "string" }, 
          frd_markdown: { type: "string" },
          input_issue_keys: { type: "array", items: { type: "string" } },
          user_stories_json: { type: "string" } 
        }, 
        required: ["epic_issue_key", "frd_markdown", "input_issue_keys", "user_stories_json"] 
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
    } else if (name === "get_brd_markdown") {
      resultText = await getBrdMarkdown(args.issue_key as string);
    } else if (name === "search_jira_issues") {
      resultText = await searchJiraIssues(args.jql_query as string, (args.max_results as number) || 50);
    } else if (name === "publish_frd_to_jira") {
      resultText = await publishFrdToJira(
        args.epic_issue_key as string, 
        args.frd_markdown as string, 
        args.input_issue_keys as string[], 
        args.user_stories_json as string
      );
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: resultText }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jira FRD MCP Server running on stdio");
}

main().catch(console.error);
