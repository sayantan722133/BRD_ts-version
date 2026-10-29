# BRD-to-Architecture Jira Workflow

This TypeScript project generates a Business Requirements Document (BRD) from a Jira Business Vision Epic, creates Jira issues for its functional requirements, then generates and publishes a Functional Requirements Document (FRD) and system architecture.

## Requirements

- Node.js 20 or later
- npm
- A Jira account with API access and permission to read and update the target project
- Either a Gemini API key or a running OpenAI-compatible local model server

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```dotenv
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_USER_EMAIL=you@example.com
JIRA_API_TOKEN=your-jira-api-token

# Required when using Gemini (the default provider)
GEMINI_API_KEY=your-gemini-api-key
# Optional; defaults to gemini-3.1-flash-lite
GEMINI_MODEL_NAME=gemini-3.1-flash-lite

# Optional when using a local OpenAI-compatible server
LOCAL_LLM_URL=http://127.0.0.1:8080/v1
LOCAL_MODEL_NAME=your-model-name
```

Keep `.env` private; do not commit API keys or tokens.

## Run the complete workflow

From the project root, provide a Jira Epic key:

```bash
npm run brd-workflow -- KAN-4
```

Gemini is the default provider. To select a provider explicitly:

```bash
npm run brd-workflow -- KAN-4 --provider gemini
npm run brd-workflow -- KAN-4 --provider local
```

The workflow runs these stages in order and stops when a stage fails:

1. **BRD generation:** fetches the Jira issue, generates the BRD, and attaches it to the Business Vision Epic.
2. **Requirement parsing:** parses functional requirements from the BRD and creates or updates a Jira Task for each requirement.
3. **FRD generation:** reads the BRD and related Jira issues, then publishes the FRD and story sub-tasks.
4. **Architecture generation:** reads the FRD and story tasks, then publishes the architecture document and component sub-tasks.

The workflow makes changes in Jira. A failed run can leave earlier stages' updates in place; fix the reported error before rerunning.

## Run stages individually

Each client can also be run directly:

```bash
npx tsx 'brd_generation/mcp_clients&llms/brd_client.ts' KAN-4 --provider gemini
npx tsx 'brd_retri_parse/mcp_clients&llms/brd_retri_client.ts' KAN-4
npx tsx 'frd_generation/mcp_clients&llms/frd_client.ts' KAN-4 --provider gemini
npx tsx 'arch_generation/mcp_clients&llms/arch_client.ts' KAN-4 --provider gemini
```

Run them in the order shown. The FRD and architecture clients also support `--model <name>` and `--output <path>`.

## Output

Generated local documents are written to:

- `generated_brds/BRD_<EPIC_KEY>.md`
- `generated_frds/FRD_<EPIC_KEY>.md`
- `generated_arch/ARCH_<EPIC_KEY>.md`

These generated directories are ignored by Git.

## Project structure

```text
.
├── start.ts                         # End-to-end workflow orchestrator
├── package.json                     # Dependencies and npm scripts
├── tsconfig.json                    # TypeScript configuration
├── brd_generation/
│   ├── prompts.ts
│   ├── mcp_clients&llms/
│   │   ├── brd_client.ts
│   │   └── brd_generator.ts
│   └── mcp_server&functions/
│       ├── bvision_fetch.ts
│       ├── brd_upsave.ts
│       └── customfun.ts
├── brd_retri_parse/
│   ├── mcp_clients&llms/
│   │   └── brd_retri_client.ts
│   └── mcp_server&functions/
│       ├── bvision_fetch.ts
│       ├── brd_retri_parser.ts
│       ├── brd_upsave.ts
│       └── customfun.ts
├── frd_generation/
│   ├── prompts.ts
│   ├── mcp_clients&llms/
│   │   ├── frd_agent.ts
│   │   └── frd_client.ts
│   └── mcp_server&functions/
│       ├── customfun.ts
│       ├── jira_common.ts
│       ├── jira_fetch.ts
│       └── jira_publish.ts
└── arch_generation/
    ├── prompts.ts
    ├── mcp_clients&llms/
    │   ├── arch_agent.ts
    │   └── arch_client.ts
    └── mcp_server&functions/
        ├── customfun.ts
        ├── jira_fetch.ts
        └── jira_publish.ts
```

The `mcp_clients&llms/` folders contain stage clients and model-generation code. The `mcp_server&functions/` folders contain Jira MCP servers and their fetch, publish, and parsing helpers.

### Technologies used

- **TypeScript** with **Node.js** (ES modules / NodeNext)
- **tsx** to run TypeScript directly during development and workflow execution
- **Model Context Protocol (MCP)** via `@modelcontextprotocol/sdk` to expose Jira operations as tools
- **Atlassian Jira REST API v3** for issue lookup, search, attachments, and issue updates
- **Google Gemini** via `@google/genai`, or a local **OpenAI-compatible chat-completions API** via the `openai` SDK
- **Zod** for validating generated FRD and architecture data
- **Commander** for command-line arguments and **dotenv** for local environment configuration

## Check the project

Run the TypeScript compiler without emitting files:

```bash
npx tsc --noEmit
```
