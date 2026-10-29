import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { generateArchPackage } from "./arch_agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "arch_generation", "mcp_server&functions", "customfun.ts");

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

function toolJson(result: any): any {
  const text = result.content?.map((item: any) => item.text).join("\n") || "";
  if (result.isError) throw new Error(text || "Architecture Jira MCP tool returned an error.");
  const value = JSON.parse(text);
  if (value && value.error) throw new Error(value.details ? `${value.error}: ${value.details}` : value.error);
  return value;
}

async function collectJiraContext(issueKey: string): Promise<any> {
  const sourceKey = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(sourceKey)) throw new Error("issue_key must be a valid Jira key, for example KAN-4.");

  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", SERVER_SCRIPT] });
  const client = new Client({ name: "arch-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  let epicKey = "";
  let epic: any = null;
  const source = toolJson(await client.callTool({ name: "get_jira_issue", arguments: { issue_key: sourceKey } }));

  if (source.issuetype?.toLowerCase() === "epic") {
    epicKey = sourceKey;
    epic = source;
  } else if (source.parent_issuetype?.toLowerCase() === "epic") {
    epicKey = source.parent_issue_key || "";
    epic = toolJson(await client.callTool({ name: "get_jira_issue", arguments: { issue_key: epicKey } }));
  } else {
    throw new Error(`${sourceKey} is not an Epic or its direct child.`);
  }

  const frdDoc = toolJson(await client.callTool({ name: "get_frd_markdown", arguments: { issue_key: epicKey } }));
  const markdown = frdDoc.markdown_content;
  if (!markdown || !markdown.trim()) throw new Error("The Jira FRD attachment is empty.");

  const frdDocuments = toolJson(await client.callTool({
    name: "search_jira_issues",
    arguments: { jql_query: `parent = "${epicKey}" AND labels in ("frd-output-document", "frd-document") ORDER BY key`, max_results: 10 }
  }));
  frdDocuments.sort((a: any, b: any) => (a.labels?.includes("frd-output-document") ? -1 : 1));
  const frdTaskKey = frdDocuments.length > 0 ? frdDocuments[0].key : null;

  const relatedStories: any[] = [];
  const parentKeys = [...new Set([frdTaskKey, epicKey].filter(Boolean))];
  
  for (const parentKey of parentKeys) {
    const stories = toolJson(await client.callTool({
      name: "search_jira_issues",
      arguments: { jql_query: `parent = "${parentKey}" AND labels = "frd-output-story" ORDER BY key`, max_results: 100 }
    }));
    relatedStories.push(...stories);
  }
  
  const uniqueStories = Object.values(Object.fromEntries(relatedStories.map(s => [s.key, s])));
  await transport.close();

  return {
    business_vision_epic: epic,
    source_issue: source,
    frd_attachment: { filename: frdDoc.attachment_name, markdown },
    frd_user_stories: uniqueStories,
  };
}

async function publishArch(epicKey: string, archMarkdown: string, inputIssueKeys: string[], components: any[], integrationContracts: any[]): Promise<any> {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", SERVER_SCRIPT] });
  const client = new Client({ name: "arch-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const result = toolJson(await client.callTool({
    name: "publish_arch_to_jira",
    arguments: {
      epic_issue_key: epicKey,
      arch_markdown: archMarkdown,
      input_issue_keys: inputIssueKeys,
      components_json: JSON.stringify(components),
      integration_contracts_json: JSON.stringify(integrationContracts),
    },
  }));

  await transport.close();
  return result;
}

async function run(issueKey: string, provider: "gemini" | "local", outputPath?: string, modelName?: string) {
  const context = await collectJiraContext(issueKey);
  const archResult = await generateArchPackage(context, provider, modelName);
  const archMarkdown = archResult.arch_markdown;
  
  const epicKey = context.business_vision_epic?.key || issueKey.trim().toUpperCase();
  const destination = outputPath ? path.resolve(outputPath) : path.join(PROJECT_ROOT, "generated_arch", `ARCH_${epicKey}.md`);
  
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, archMarkdown.trim() + "\n", "utf-8");

  const inputKeys = context.frd_user_stories.map((s: any) => String(s.key).trim()).filter(Boolean);

  const publishResult = await publishArch(epicKey, archMarkdown, inputKeys, archResult.components, archResult.integration_contracts);

  console.log(JSON.stringify({ arch_path: destination, jira_publish: publishResult }, null, 2));
  return destination;
}

program
  .description("Fetch Jira FRD context and generate a System Architecture Document.")
  .argument("<jira_key>", "Business Vision Epic or child issue key")
  .option("--provider <provider>", "Provider (gemini or local)", "gemini")
  .option("--model <modelName>", "Override the configured model name")
  .option("--output <outputPath>", "Architecture Markdown output path")
  .action(async (jiraKey, options) => {
    try {
      await run(jiraKey, options.provider, options.output, options.model);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

program.parse();
