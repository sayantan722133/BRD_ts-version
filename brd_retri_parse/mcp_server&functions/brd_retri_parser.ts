import { z } from "zod";

export const RequirementFeatureSchema = z.object({
  requirement_id: z.string().regex(/^FR-\d+$/),
  name: z.string().min(1),
  priority: z.string().min(1),
  acceptance_criteria: z.array(z.string()).min(1),
}).strict();

export const CoreModuleSchema = z.object({
  module_id: z.string().regex(/^MOD-[A-Z0-9-]+$/),
  name: z.string().min(1),
  features: z.array(RequirementFeatureSchema).min(1),
}).strict();

export const BRDRequirementsSchema = z.object({
  schema_version: z.string().default("1.0"),
  source_issue_key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  source_summary: z.string().default(""),
  modules: z.array(CoreModuleSchema).min(1),
}).strict();

export type BRDRequirements = z.infer<typeof BRDRequirementsSchema>;

const MODULE_RULES: [string, string, string[]][] = [
  ["BENEFITS", "Benefit Payments", ["benefit", "disbursement", "payout"]],
  ["ONBOARDING", "Employer & Scheme Onboarding", ["onboarding", "kyc", "enrollment"]],
  ["INVESTMENTS", "Investment Management", ["investment", "fund switch", "fund performance"]],
  ["MEMBER-EXPERIENCE", "Member Experience", ["self-service", "member portal"]],
  ["CONTRIBUTIONS", "Contribution Management", ["contribution", "salary deduction", "billing"]],
  ["MEMBER-EXPERIENCE", "Member Experience", ["member"]],
  ["COMPLIANCE", "Compliance & Audit", ["compliance", "audit", "regulatory"]],
  ["SECURITY", "Security & Access", ["security", "access control", "authentication"]],
  ["PLATFORM", "Core Platform", []],
];

function cleanCell(value: string): string {
  let cleaned = value.replace(/<br\s*\/?>/gi, "; ");
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  cleaned = cleaned.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  return cleaned.replace(/`/g, "").trim();
}

function moduleFor(description: string, acceptance: string): [string, string] {
  for (const text of [description, acceptance]) {
    const normalized = text.toLowerCase();
    for (let i = 0; i < MODULE_RULES.length - 1; i++) {
      const [moduleId, moduleName, keywords] = MODULE_RULES[i];
      if (keywords.some(keyword => normalized.includes(keyword))) {
        return [moduleId, moduleName];
      }
    }
  }
  const defaultRule = MODULE_RULES[MODULE_RULES.length - 1];
  return [defaultRule[0], defaultRule[1]];
}

export function parseBrdRequirements(markdown: string, sourceIssueKey: string, sourceSummary: string = ""): BRDRequirements {
  const rows: [string, string, string, string][] = [];
  let header: string[] | null = null;
  const lines = markdown.split("\n");

  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(cleanCell);
    
    if (!cells.length || cells.every(c => /^:?-{3,}:?$/.test(c.replace(/ /g, "")))) continue;
    
    const lowered = cells.map(c => c.toLowerCase());
    const normalizedHeaders = lowered.map(c => c.replace(/[^a-z0-9]+/g, " ").trim());
    if (normalizedHeaders.some(c => /^(?:fr )?id$/.test(c) || c === "requirement id")) {
      header = normalizedHeaders;
      continue;
    }
    if (!header) continue;

    const indexes = {
      id: header.findIndex(c => /^(?:fr )?id$/.test(c) || c === "requirement id"),
      priority: header.findIndex(c => c.includes("priority")),
      description: header.findIndex(c => c.includes("description") || c.includes("requirement") || c.includes("outcome")),
      acceptance: header.findIndex(c => c.includes("acceptance")),
    };

    if (Object.values(indexes).some(idx => idx === -1 || idx >= cells.length)) continue;

    const idMatch = cells[indexes.id].match(/FR-\d+/i);
    if (idMatch) {
      rows.push([
        idMatch[0].toUpperCase(),
        cells[indexes.priority],
        cells[indexes.description],
        cells[indexes.acceptance]
      ]);
    }
  }

  if (!rows.length) {
    let current: { id: string; title: string; priority: string; description: string; outcome: string; acceptance: string } | null = null;
    const addCurrent = () => {
      if (!current) return;
      const description = current.description || current.outcome || current.title;
      if (description && current.acceptance) {
        rows.push([current.id, current.priority, description, current.acceptance]);
      }
    };

    for (const line of lines) {
      const heading = line.trim().match(/^#{2,6}\s+(FR-\d+)\b\s*:?\s*(.*)$/i);
      if (heading) {
        addCurrent();
        current = {
          id: heading[1].toUpperCase(),
          title: cleanCell(heading[2]),
          priority: "",
          description: "",
          outcome: "",
          acceptance: "",
        };
        continue;
      }
      if (!current) continue;

      const field = line.trim().match(/^\*\*(Description|Priority|Outcome|Acceptance Criteria)\*\*\s*:\s*(.*)$/i);
      if (!field) continue;

      const value = cleanCell(field[2]);
      switch (field[1].toLowerCase()) {
        case "description":
          current.description = value;
          break;
        case "priority":
          current.priority = value;
          break;
        case "outcome":
          current.outcome = value;
          break;
        case "acceptance criteria":
          current.acceptance = value;
          break;
      }
    }
    addCurrent();
  }

  if (!rows.length) throw new Error("No functional requirements with acceptance criteria were found in the BRD.");

  const featureGroups: Record<string, any[]> = {};
  const moduleNames: Record<string, string> = {};

  for (const [reqId, priority, description, acceptance] of rows) {
    const [moduleId, moduleName] = moduleFor(description, acceptance);
    moduleNames[moduleId] = moduleName;
    const criteria = acceptance.split(/\s*;\s*/).map(p => p.trim()).filter(Boolean);
    
    if (!featureGroups[moduleId]) featureGroups[moduleId] = [];
    featureGroups[moduleId].push({
      requirement_id: reqId,
      name: description,
      priority: priority || "Unspecified",
      acceptance_criteria: criteria,
    });
  }

  const result = {
    schema_version: "1.0",
    source_issue_key: sourceIssueKey.trim().toUpperCase(),
    source_summary: sourceSummary.trim(),
    modules: Object.entries(featureGroups).map(([moduleId, features]) => ({
      module_id: `MOD-${moduleId}`,
      name: moduleNames[moduleId],
      features,
    })),
  };

  return BRDRequirementsSchema.parse(result);
}
