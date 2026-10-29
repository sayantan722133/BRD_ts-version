import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { program } from "commander";

// Resolve __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __dirname;

// Define paths to the individual module clients
const BRD_CLIENT = path.join(PROJECT_ROOT, "brd_generation", "mcp_clients&llms", "brd_client.ts");
const REQUIREMENTS_CLIENT = path.join(PROJECT_ROOT, "brd_retri_parse", "mcp_clients&llms", "brd_retri_client.ts");
const FRD_CLIENT = path.join(PROJECT_ROOT, "frd_generation", "mcp_clients&llms", "frd_client.ts");
const ARCH_CLIENT = path.join(PROJECT_ROOT, "arch_generation", "mcp_clients&llms", "arch_client.ts");

/**
 * Runs a child process synchronously using `tsx` to execute the TypeScript files.
 */
function runStep(name: string, commandArgs: string[]): number {
    console.log(`\n=== ${name} ===`);
    
    // Spawn the process inheriting stdio so console logs and errors stream to the terminal
    const result = spawnSync("npx", ["tsx", ...commandArgs], {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
    });
    
    if (result.status !== 0) {
        console.error(`${name} failed with exit code ${result.status ?? "unknown"}; stopping workflow.`);
    }
    
    return result.status ?? 1;
}

program
    .description("Generate and publish a Jira BRD, create requirement Tasks, then generate the FRD and system architecture with their Jira tasks.")
    .argument("<jira_key>", "Business Vision Jira issue key, for example KAN-4")
    .option("--provider <provider>", "BRD generation provider", "gemini")
    .action((jiraKey, options) => {
        const provider = options.provider;

        // Step 1: BRD Generation and Upload
        const brdResult = runStep("BRD generation and upload", [BRD_CLIENT, jiraKey, "--provider", provider]);
        if (brdResult !== 0) process.exit(brdResult);

        // Step 2: Parse BRD and Create Tasks
        const reqResult = runStep("BRD requirement parsing and Jira task creation", [REQUIREMENTS_CLIENT, jiraKey]);
        if (reqResult !== 0) process.exit(reqResult);

        // Step 3: FRD Generation and Upload
        const frdResult = runStep("FRD generation and Jira publication", [FRD_CLIENT, jiraKey, "--provider", provider]);
        if (frdResult !== 0) process.exit(frdResult);

        // Step 4: Architecture Generation and Upload
        const archResult = runStep("Architecture generation and Jira publication", [ARCH_CLIENT, jiraKey, "--provider", provider]);
        if (archResult !== 0) process.exit(archResult);

        console.log("\nEnd-to-end BRD-to-architecture workflow completed.");
    });

program.parse();
