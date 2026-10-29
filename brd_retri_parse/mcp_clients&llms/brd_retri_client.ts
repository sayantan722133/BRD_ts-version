import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { program } from "commander";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseBrdRequirements } from "../mcp_server&functions/brd_retri_parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "brd_retri_parse", "mcp_server&functions", "customfun.ts");

function toolJson(result: any): any {
  const text = result.content?.map((item: any) => item.text).join("\n") || "";
  if (result.isError) throw new Error(text || "MCP tool returned an error.");
  const payload = JSON.parse(text);
  if (payload && payload.error) throw new Error(payload.details ? `${payload.error}: ${payload.details}` : payload.error);
  return payload;
}

async function run(jiraKey: string) {
  const sourceKey = jiraKey.trim().toUpperCase();
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_SCRIPT],
  });

  const client = new Client({ name: "brd-retri-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const source = toolJson(await client.callTool({ name: "get_jira_issue", arguments: { issue_key: sourceKey } }));
  
  let businessVisionKey = sourceKey;
  let businessVisionSummary = source.summary || "";

  if (source.issuetype?.toLowerCase() === "epic") {
    businessVisionKey = sourceKey;
  } else if (source.parent_issuetype?.toLowerCase() === "epic") {
    businessVisionKey = source.parent_issue_key || sourceKey;
    businessVisionSummary = source.parent_summary || "";
  }

  const brdAttachment = toolJson(await client.callTool({ name: "get_brd_markdown", arguments: { issue_key: sourceKey } }));
  const markdown = brdAttachment.markdown_content;
  if (!markdown || !markdown.trim()) throw new Error("The Jira BRD attachment is empty or could not be read as text.");

  const requirements = parseBrdRequirements(markdown, businessVisionKey, businessVisionSummary);

  const jiraResult = toolJson(await client.callTool({
    name: "create_brd_requirement_issues",
    arguments: {
      source_issue_key: businessVisionKey,
      requirements_json: JSON.stringify(requirements, null, 2),
    },
  }));

  await transport.close();

  console.log(JSON.stringify({
    brd_attachment: {
      issue_key: brdAttachment.attachment_issue_key,
      business_vision_key: brdAttachment.business_vision_key,
      filename: brdAttachment.attachment_name,
    },
    parsed_requirements: requirements,
    jira_result: jiraResult,
  }, null, 2));
}

program
  .description("Parse BRD requirements and create one Jira Task per requirement.")
  .argument("<jira_key>", "Source Jira issue key, for example KAN-4")
  .action(async (jiraKey) => {
    try {
      await run(jiraKey);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

program.parse();
