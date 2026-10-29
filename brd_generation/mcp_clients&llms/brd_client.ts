import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { program } from "commander";
import * as path from "path";
import { fileURLToPath } from "url";
import { generateBrd } from "./brd_generator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "brd_generation", "mcp_server&functions", "customfun.ts");

async function runClient(jiraKey: string, provider: "gemini" | "local") {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_SCRIPT],
  });

  console.log("Connecting to Jira MCP Server via stdio...");
  const client = new Client({ name: "brd-client", version: "1.0.0" }, { capabilities: {} });
  
  await client.connect(transport);
  
  const toolsResult = await client.listTools();
  console.log(`Discovered ${toolsResult.tools.length} tools from MCP server:`, toolsResult.tools.map(t => t.name));

  await generateBrd(client, jiraKey, toolsResult.tools, provider);
  await transport.close();
}

program
  .description("Generate a BRD from a Jira business vision.")
  .argument("<jira_key>", "Jira issue key, for example PROJ-12")
  .option("--provider <provider>", "Language model provider (gemini or local)", "gemini")
  .action(async (jiraKey, options) => {
    try {
      await runClient(jiraKey, options.provider);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

program.parse();
