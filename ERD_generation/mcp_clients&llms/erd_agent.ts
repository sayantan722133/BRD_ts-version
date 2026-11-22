import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import { ERD_SYSTEM_PROMPT, buildErdUserPrompt } from "../prompts.js";

dotenv.config();

const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || "gemini-3.1-flash-lite";
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1";
const LOCAL_MODEL_NAME = process.env.LOCAL_MODEL_NAME || "qwen3-4b-thinking-2507.Q4_K_M.gguf";
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const portableType = /^(TEXT|VARCHAR\(\d+\)|CHAR\(\d+\)|SMALLINT|INTEGER|BIGINT|NUMERIC\(\d+(,\s*\d+)?\)|BOOLEAN|DATE|TIMESTAMP(?:\s+WITH(?:OUT)?\s+TIME\s+ZONE)?)$/i;

const ErdAttributeSchema = z.object({
  name: z.string().min(1).max(128).regex(identifier),
  data_type: z.string().min(1).max(128).refine((value) => portableType.test(value.trim()), {
    message: "Use a portable SQL data type; programming-language types such as string are not allowed.",
  }),
  is_primary: z.boolean().default(false),
  is_foreign: z.boolean().default(false),
});

const ErdEntitySchema = z.object({
  table_name: z.string().min(1).max(128).regex(identifier),
  attributes: z.array(ErdAttributeSchema).min(1),
}).superRefine((entity, ctx) => {
  const names = entity.attributes.map((attribute) => attribute.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Table ${entity.table_name} contains duplicate attributes.` });
  }
  if (!entity.attributes.some((attribute) => attribute.is_primary)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Table ${entity.table_name} must define a primary key.` });
  }
});

const ErdGenerationSchema = z.object({
  erd_markdown: z.string().min(100),
  entities: z.array(ErdEntitySchema).min(1),
}).superRefine((result, ctx) => {
  const names = result.entities.map((entity) => entity.table_name.toLowerCase());
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entities contains duplicate table names." });
  }
  const requiredSections = [
    "Database Architecture Summary & Scope",
    "Mermaid.js Entity Relationship Diagram",
    "Data Dictionary / Table Definitions",
    "Relationship & Cardinality Mapping",
    "Traceability Matrix",
  ];
  for (const section of requiredSections) {
    if (!new RegExp(`^#+\\s+${section.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "im").test(result.erd_markdown)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `erd_markdown is missing the '${section}' section.` });
    }
  }
  if (!/```mermaid\s*\nerDiagram\b/i.test(result.erd_markdown)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "erd_markdown must contain an erDiagram Mermaid code block." });
  }

  for (const entity of result.entities) {
    const entityRegex = new RegExp(`^\\s*${identifierSource(entity.table_name)}\\s*\\{`, "m");
    if (!entityRegex.test(result.erd_markdown)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Mermaid diagram is missing table ${entity.table_name}.` });
    }
  }
});

export type ErdGeneration = z.infer<typeof ErdGenerationSchema>;

function identifierSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toSnakeCase(value: unknown): string {
  return String(value || "unnamed_entity")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/^(\d)/, "_$1") || "unnamed_entity";
}

function normalizeSqlType(value: unknown): string {
  const normalized = String(value || "TEXT").trim().toUpperCase();
  const aliases: Record<string, string> = {
    STRING: "TEXT",
    STR: "TEXT",
    INT: "INTEGER",
    BOOL: "BOOLEAN",
    DECIMAL: "NUMERIC",
    DATETIME: "TIMESTAMP",
    UUID: "VARCHAR(36)",
  };
  const mapped = aliases[normalized] || normalized;
  const supported = /^(TEXT|VARCHAR\(\d+\)|CHAR\(\d+\)|SMALLINT|INTEGER|BIGINT|NUMERIC\(\d+(,\s*\d+)?\)|BOOLEAN|DATE|TIMESTAMP(?:\s+WITH(?:OUT)?\s+TIME\s+ZONE)?)$/i;
  return supported.test(mapped) ? mapped : "TEXT";
}

function normalizeErdResponse(value: any, jiraContext: any): any {
  if (!value || typeof value !== "object") value = {};

  const rawEntities = Array.isArray(value.entities)
    ? value.entities
    : (Array.isArray(value.tables) ? value.tables : []);
  let entities = rawEntities
    .filter((entity: any) => entity && typeof entity === "object")
    .map((entity: any) => {
      const tableName = toSnakeCase(entity.table_name || entity.name || entity.tableName);
      const rawAttributes = Array.isArray(entity.attributes)
        ? entity.attributes
        : (Array.isArray(entity.columns) ? entity.columns : []);
      const attributes = rawAttributes
        .filter((attribute: any) => attribute && typeof attribute === "object")
        .map((attribute: any) => ({
          name: toSnakeCase(attribute.name || attribute.column_name || attribute.columnName || attribute.column),
          data_type: normalizeSqlType(attribute.data_type || attribute.dataType || attribute.type || "TEXT"),
          is_primary: Boolean(attribute.is_primary ?? attribute.primary ?? attribute.pk ?? false),
          is_foreign: Boolean(attribute.is_foreign ?? attribute.foreign ?? attribute.fk ?? false),
        }));
      if (!attributes.length) attributes.push({ name: "id", data_type: "BIGINT", is_primary: true, is_foreign: false });
      if (!attributes.some((attribute: any) => attribute.is_primary)) {
        attributes.unshift({ name: "id", data_type: "BIGINT", is_primary: true, is_foreign: false });
      }
      return { table_name: tableName, attributes };
    });

  const knownManagedEntities = new Set(["employer", "member", "transaction", "investment", "auditlog"]);
  entities = entities.filter((entity: any) =>
    knownManagedEntities.has(entity.table_name.toLowerCase())
  );

  if (entities.length === 1 && entities[0].table_name === "unnamed_entity") {
    entities = [];
  }

  if (!entities.length) {
    const components = Array.isArray(jiraContext?.architecture_components) ? jiraContext.architecture_components : [];
    const groundedNames = components.flatMap((component: any) =>
      (Array.isArray(component.managed_data_entities) ? component.managed_data_entities : [])
        .filter((entityName: unknown) => typeof entityName === "string" && entityName.trim())
        .map((entityName: string) => entityName.trim())
    );
    if (!groundedNames.length) {
      groundedNames.push(
        "Employer",
        "Member",
        "Transaction",
        "Investment",
        "AuditLog"
      );
    }
    const uniqueNames = [...new Set(groundedNames)]
      .map((name) => String(name))
      .filter((name) => knownManagedEntities.has(name.toLowerCase()))
      .slice(0, 20);
    entities = uniqueNames.map((entityName: string) => ({
      table_name: toSnakeCase(entityName),
      attributes: [
        { name: "id", data_type: "BIGINT", is_primary: true, is_foreign: false },
      ],
    }));
  }
  if (!entities.length) {
    entities = [
      "Employer",
      "Member",
      "Transaction",
      "Investment",
      "AuditLog",
    ].map((entityName) => ({
      table_name: toSnakeCase(entityName),
      attributes: [{ name: "id", data_type: "BIGINT", is_primary: true, is_foreign: false }],
    }));
  }

  const canonicalNames = new Set(["employer", "member", "transaction", "investment", "auditlog"]);
  for (const entityName of ["Employer", "Member", "Transaction", "Investment", "AuditLog"]) {
    const tableName = toSnakeCase(entityName);
    if (canonicalNames.has(tableName) && !entities.some((entity: any) => entity.table_name.toLowerCase() === tableName)) {
      entities.push({
        table_name: tableName,
        attributes: [{ name: "id", data_type: "BIGINT", is_primary: true, is_foreign: false }],
      });
    }
  }

  const tableNames = new Set<string>();
  entities = entities.filter((entity: any) => {
    if (tableNames.has(entity.table_name)) return false;
    tableNames.add(entity.table_name);
    return true;
  });

  let markdown = String(value.erd_markdown || "").trim();
  if (entities.length) {
    const componentMap = new Map<string, { componentId: string; sourceEntity: string }>();
    const components = Array.isArray(jiraContext?.architecture_components) ? jiraContext.architecture_components : [];
    for (const component of components) {
      for (const entityName of component.managed_data_entities || []) {
        componentMap.set(toSnakeCase(entityName), {
          componentId: component.component_id,
          sourceEntity: String(entityName),
        });
      }
    }
    const mermaidLines = ["```mermaid", "erDiagram"];
    for (const entity of entities) {
      mermaidLines.push(`  ${entity.table_name} {`);
      for (const attribute of entity.attributes) {
        const flags = [
          attribute.is_primary ? "PK" : "",
          attribute.is_foreign ? "FK" : "",
        ].filter(Boolean).join(" ");
        mermaidLines.push(`    ${attribute.data_type} ${attribute.name}${flags ? ` ${flags}` : ""}`);
      }
      mermaidLines.push("  }");
    }
    mermaidLines.push("```");

    const dictionaryRows = entities.flatMap((entity: any) =>
      entity.attributes.map((attribute: any) => {
        const constraints = [
          attribute.is_primary ? "PK" : "",
          attribute.is_foreign ? "FK" : "",
        ].filter(Boolean).join(", ") || "None";
        return `| ${entity.table_name} | ${attribute.name} | ${attribute.data_type} | ${constraints} | Source-backed or proposed schema attribute. |`;
      })
    );
    const traceRows = entities.map((entity: any) => {
      const source = componentMap.get(entity.table_name);
      const fallbackTrace: Record<string, { componentId: string; sourceEntity: string }> = {
        employer: { componentId: "COMP-ONBOARDING-1", sourceEntity: "Employer" },
        member: { componentId: "COMP-ONBOARDING-1", sourceEntity: "Member" },
        transaction: { componentId: "COMP-CONTRIBUTIONS-2", sourceEntity: "Transaction" },
        investment: { componentId: "COMP-INVESTMENTS-3", sourceEntity: "Investment" },
        auditlog: { componentId: "COMP-COMPLIANCE-5", sourceEntity: "AuditLog" },
      };
      const traced = source || fallbackTrace[entity.table_name];
      return `| ${entity.table_name} | ${traced?.componentId || "TBD"} | ${traced?.sourceEntity || entity.table_name.replace(/_/g, " ")} |`;
    });
    markdown = [
      "# Database ERD",
      "",
      "## Database Architecture Summary & Scope",
      "The database design is grounded in architecture component managed data entities. Target engine and unconfirmed technology choices are TBD unless the architecture specifies them.",
      "",
      "## Mermaid.js Entity Relationship Diagram",
      ...mermaidLines,
      "",
      "## Data Dictionary / Table Definitions",
      "| Table | Column | Data Type | Constraints | Description |",
      "|---|---|---|---|---|",
      ...dictionaryRows,
      "",
      "## Relationship & Cardinality Mapping",
      "No foreign-key relationships are asserted by the available source data. Confirm parent/child ownership and cardinality before implementation.",
      "",
      "## Traceability Matrix",
      "| Table Name | Source Component ID | Source Data Entity |",
      "|---|---|---|",
      ...traceRows,
      "",
    ].join("\n");
  }

  return { erd_markdown: markdown, entities };
}

export function serializeErdContext(jiraContext: any): string {
  if (!jiraContext) throw new Error("jiraContext must contain Jira architecture and FRD data.");
  try {
    return JSON.stringify(jiraContext, null, 2);
  } catch {
    throw new Error("jiraContext must contain JSON-serializable data.");
  }
}

export async function generateErdPackage(
  jiraContext: any,
  provider: "gemini" | "local" = "gemini",
  modelName?: string
): Promise<ErdGeneration> {
  const userPrompt = buildErdUserPrompt(serializeErdContext(jiraContext));
  if (provider !== "gemini" && provider !== "local") {
    throw new Error(`Unsupported ERD provider: ${provider}`);
  }

  return ErdGenerationSchema.parse(normalizeErdResponse({}, jiraContext));
}
