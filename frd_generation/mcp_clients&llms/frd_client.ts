import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { generateFrdPackage } from "./frd_agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "frd_generation", "mcp_server&functions", "customfun.ts");

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

function toolJson(result: any): any {
  const text = result.content?.map((item: any) => item.text).join("\n") || "";
  if (result.isError) throw new Error(text || "FRD Jira MCP tool returned an error.");
  
  const value = JSON.parse(text);
  if (value && value.error) {
    throw new Error(value.details ? `${value.error}: ${value.details}` : value.error);
  }
  return value;
}

async function collectJiraContext(issueKey: string): Promise<any> {
  const sourceKey = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(sourceKey)) throw new Error("issue_key must be a valid Jira key, for example KAN-4.");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_SCRIPT],
  });

  const client = new Client({ name: "frd-client", version: "1.0.0" }, { capabilities: {} });
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
    throw new Error(`${sourceKey} is not a Business Vision Epic or its direct child.`);
  }

  const brd = toolJson(await client.callTool({ name: "get_brd_markdown", arguments: { issue_key: epicKey } }));
  const markdown = brd.markdown_content;
  if (!markdown || !markdown.trim()) throw new Error("The Jira BRD attachment is empty.");

  const related = toolJson(await client.callTool({ name: "search_jira_issues", arguments: { jql_query: `parent = "${epicKey}" ORDER BY key`, max_results: 100 } }));

  await transport.close();

  return {
    business_vision_epic: epic,
    source_issue: source,
    brd_attachment: { filename: brd.attachment_name, markdown },
    related_jira_issues: related,
  };
}

async function publishFrd(epicKey: string, frdMarkdown: string, inputIssueKeys: string[], userStories: any[]): Promise<any> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_SCRIPT],
  });

  const client = new Client({ name: "frd-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const result = toolJson(await client.callTool({
    name: "publish_frd_to_jira",
    arguments: {
      epic_issue_key: epicKey,
      frd_markdown: frdMarkdown,
      input_issue_keys: inputIssueKeys,
      user_stories_json: JSON.stringify(userStories),
    },
  }));

  await transport.close();
  return result;
}

async function run(issueKey: string, provider: "gemini" | "local", outputPath?: string, modelName?: string) {
  const context = await collectJiraContext(issueKey);
  const frdResult = await generateFrdPackage(context, provider, modelName);
  const frdMarkdown = frdResult.frd_markdown;
  
  const epicKey = context.business_vision_epic?.key || issueKey.trim().toUpperCase();
  const destination = outputPath ? path.resolve(outputPath) : path.join(PROJECT_ROOT, "generated_frds", `FRD_${epicKey}.md`);
  
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, frdMarkdown.trim() + "\n", "utf-8");

  const inputIssueKeys: string[] = [];
  const seenInputIssueKeys = new Set<string>();

  for (const item of context.related_jira_issues) {
    const key = (item.key || "").trim();
    if (!key || seenInputIssueKeys.has(key)) continue;
    
    const labels = (item.labels || []).map((l: string) => l.toLowerCase());
    if (labels.some((l: string) => ["frd-document", "frd-output-document", "frd-output-story", "arch-output-document", "arch-output-component"].includes(l) || l.startsWith("frd-story-") || l.startsWith("arch-comp-"))) {
      continue;
    }
    seenInputIssueKeys.add(key);
    inputIssueKeys.push(key);
  }

  const publishResult = await publishFrd(epicKey, frdMarkdown, inputIssueKeys, frdResult.user_stories);

  console.log(JSON.stringify({
    frd_path: destination,
    jira_publish: publishResult,
  }, null, 2));
  
  return destination;
}

program
  .description("Fetch Jira BRD context and generate a Functional Requirements Document.")
  .argument("<jira_key>", "Business Vision Epic or direct child issue key")
  .option("--provider <provider>", "Provider (gemini or local)", "gemini")
  .option("--model <modelName>", "Override the configured Gemini or local model name")
  .option("--output <outputPath>", "FRD Markdown output path")
  .action(async (jiraKey, options) => {
    try {
      await run(jiraKey, options.provider, options.output, options.model);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

program.parse();
