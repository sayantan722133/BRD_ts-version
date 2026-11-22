import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { generateErdPackage } from "./erd_agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "ERD_generation", "mcp_server&functions", "customfun.ts");
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

function toolJson(result: any): any {
  const text = result.content?.map((item: any) => item.text).join("\n") || "";
  if (result.isError) throw new Error(text || "ERD Jira MCP tool returned an error.");
  const value = JSON.parse(text);
  if (value && value.error) throw new Error(value.details ? `${value.error}: ${value.details}` : value.error);
  return value;
}

async function collectArchContext(issueKey: string): Promise<any> {
  const key = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(key)) throw new Error("jiraKey must be a valid Jira key, for example KAN-4.");
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", SERVER_SCRIPT] });
  const client = new Client({ name: "erd-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const result = toolJson(await client.callTool({ name: "get_arch_context", arguments: { epic_key: key } }));
  await transport.close();
  if (!Array.isArray(result.architecture_components) || !result.architecture_components.length) {
    throw new Error("Jira architecture context contains no ERD component precursors.");
  }
  return result;
}

async function publishErd(epicKey: string, markdown: string, entities: any[]): Promise<any> {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", SERVER_SCRIPT] });
  const client = new Client({ name: "erd-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const result = toolJson(await client.callTool({
    name: "publish_erd_to_jira",
    arguments: { epic_issue_key: epicKey, erd_markdown: markdown, entities_json: JSON.stringify(entities) },
  }));
  await transport.close();
  return result;
}

async function run(issueKey: string, provider: "gemini" | "local", outputPath?: string, modelName?: string) {
  const context = await collectArchContext(issueKey);
  const erd = await generateErdPackage(context, provider, modelName);
  const epicKey = context.epic?.key || issueKey.trim().toUpperCase();
  const destination = outputPath ? path.resolve(outputPath) : path.join(PROJECT_ROOT, "generated_erd", `ERD_${epicKey}.md`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, erd.erd_markdown.trim() + "\n", "utf-8");
  const jiraPublish = await publishErd(epicKey, erd.erd_markdown, erd.entities);
  console.log(JSON.stringify({ erd_path: destination, jira_publish: jiraPublish }, null, 2));
  return destination;
}

program
  .description("Fetch Jira architecture and FRD context and generate a database ERD.")
  .argument("<jira_key>", "Business Vision Epic or direct child issue key")
  .option("--provider <provider>", "Provider (gemini or local)", "gemini")
  .option("--model <modelName>", "Override the configured model name")
  .option("--output <outputPath>", "ERD Markdown output path")
  .action(async (jiraKey, options) => {
    try {
      await run(jiraKey, options.provider, options.output, options.model);
    } catch (error: any) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
