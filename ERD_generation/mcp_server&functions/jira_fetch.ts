import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders, adfToText } from "./customfun.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;
const COMPONENT_ID_REGEX = /^COMP-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+$/i;

function validateIssueKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(key)) throw new Error("issue_key must be a valid Jira key, for example KAN-4.");
  return key;
}

function issueSummary(issue: any): any {
  const fields = issue.fields || {};
  const parent = fields.parent || {};
  return {
    key: issue.key,
    summary: fields.summary,
    issuetype: fields.issuetype?.name,
    status: fields.status?.name,
    description: adfToText(fields.description),
    labels: fields.labels || [],
    attachments: fields.attachment || [],
    parent_issue_key: parent.key,
    parent_summary: parent.fields?.summary,
    parent_issuetype: parent.fields?.issuetype?.name,
  };
}

export async function getJiraIssue(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,status,description,parent,labels,attachment`, { headers: getJiraHeaders() });
  if (!response.ok) return JSON.stringify({ error: `Issue lookup failed: ${response.status}`, details: await response.text() }, null, 2);
  return JSON.stringify(issueSummary(await response.json()), null, 2);
}

export async function searchJiraIssues(jqlQuery: string, maxResults = 50): Promise<string> {
  if (!jqlQuery.trim()) throw new Error("jql_query must not be empty.");
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  url.searchParams.set("jql", jqlQuery);
  url.searchParams.set("maxResults", String(Math.max(1, Math.min(maxResults, 100))));
  url.searchParams.set("fields", "summary,issuetype,status,description,parent,labels,attachment");
  const response = await fetch(url, { headers: getJiraHeaders() });
  if (!response.ok) return JSON.stringify({ error: `Issue search failed: ${response.status}`, details: await response.text() }, null, 2);
  const data = await response.json();
  return JSON.stringify((data.issues || []).map(issueSummary), null, 2);
}

async function downloadAttachment(attachments: any[], filename: string): Promise<string | null> {
  const attachment = (attachments || []).find((item) => String(item.filename).toLowerCase() === filename.toLowerCase());
  if (!attachment?.id) return null;
  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/content/${attachment.id}`, { headers: getAttachmentHeaders() });
  if (!response.ok) throw new Error(`Attachment download failed for ${filename}: ${response.status} ${await response.text()}`);
  return response.text();
}

function extractManagedEntities(description: string): string[] {
  const match = description.match(/Managed Data Entities \(ERD Precursors\):\s*(.*)/is);
  if (!match) return [];
  const value = match[1].split(/\b(?:Traceable FR IDs|Traceable User Stories|Core Responsibilities):/i)[0];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export async function getArchContext(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const sourceResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,parent,attachment,description,labels`, { headers: getJiraHeaders() });
  if (!sourceResponse.ok) return JSON.stringify({ error: `Issue lookup failed: ${sourceResponse.status}`, details: await sourceResponse.text() }, null, 2);
  const source = await sourceResponse.json();
  const sourceSummary = issueSummary(source);
  let epicKey = "";
  if ((sourceSummary.issuetype || "").toLowerCase() === "epic") epicKey = key;
  else if ((sourceSummary.parent_issuetype || "").toLowerCase() === "epic") epicKey = sourceSummary.parent_issue_key;
  else return JSON.stringify({ error: `${key} is neither a Jira Epic nor its direct child.` }, null, 2);

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=summary,issuetype,description,attachment,labels`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Epic lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);
  const epic = await epicResponse.json();
  const epicSummary = issueSummary(epic);

  const archUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  archUrl.searchParams.set("jql", `parent = "${epicKey}" AND labels = "arch-output-document"`);
  archUrl.searchParams.set("maxResults", "100");
  archUrl.searchParams.set("fields", "summary,issuetype,description,parent,labels,attachment");
  const archResponse = await fetch(archUrl, { headers: getJiraHeaders() });
  if (!archResponse.ok) return JSON.stringify({ error: `Architecture document search failed: ${archResponse.status}`, details: await archResponse.text() }, null, 2);
  const archIssues = ((await archResponse.json()).issues || []).sort((a: any, b: any) => a.key.localeCompare(b.key));
  if (!archIssues.length) return JSON.stringify({ error: `No [ARCH] document task found under Epic ${epicKey}.` }, null, 2);
  const archIssue = archIssues[0];
  const archMarkdown = await downloadAttachment(archIssue.fields?.attachment || [], `ARCH_${epicKey}.md`);
  if (!archMarkdown) return JSON.stringify({ error: `No ARCH_${epicKey}.md attachment found on the architecture task.` }, null, 2);

  const componentIdMatches = [...archMarkdown.matchAll(/\bCOMP-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g)].map((match) => match[0].toUpperCase());
  const expectedComponentIds = new Set(componentIdMatches);

  const componentUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  componentUrl.searchParams.set("jql", `parent = "${archIssue.key}" AND labels = "arch-output-component" ORDER BY created DESC`);
  componentUrl.searchParams.set("maxResults", "100");
  componentUrl.searchParams.set("fields", "summary,issuetype,description,parent,labels,created");
  const componentResponse = await fetch(componentUrl, { headers: getJiraHeaders() });
  if (!componentResponse.ok) return JSON.stringify({ error: `Architecture component search failed: ${componentResponse.status}`, details: await componentResponse.text() }, null, 2);
  const componentIssues = (await componentResponse.json()).issues || [];
  const seen = new Set<string>();
  const components: any[] = [];
  for (const issue of componentIssues) {
    const labels = issue.fields?.labels || [];
    if (labels.some((label: string) => label.toLowerCase() === "superseded-output")) continue;
    const description = adfToText(issue.fields?.description);
    const idMatch = description.match(/Component ID:\s*(COMP-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)/i);
    let componentId = idMatch?.[1]?.toUpperCase() || "";
    if (!componentId) componentId = labels.find((label: string) => COMPONENT_ID_REGEX.test(label))?.toUpperCase() || "";
    let entities = extractManagedEntities(description);
    if (!entities.length) {
      if (/ONBOARDING/i.test(componentId)) entities.push("Employer", "Member");
      if (/CONTRIBUTIONS/i.test(componentId)) entities.push("Transaction", "ContributionRecord");
      if (/INVESTMENTS/i.test(componentId)) entities.push("Investment");
      if (/BENEFITS/i.test(componentId)) entities.push("BenefitPayment", "Member");
      if (/COMPLIANCE/i.test(componentId)) entities.push("AuditLog");
    }
    if (componentId && (!expectedComponentIds.size || expectedComponentIds.has(componentId)) && entities.length && !seen.has(componentId)) {
      seen.add(componentId);
      components.push({ component_id: componentId, issue_key: issue.key, summary: issue.fields?.summary, managed_data_entities: entities, description });
    }
  }
  if (!expectedComponentIds.size) {
    for (const id of seen) expectedComponentIds.add(id);
  }
  const missing = [...expectedComponentIds].filter((id) => !seen.has(id));
  if (missing.length) return JSON.stringify({ error: `Architecture component tasks are missing or have no managed ERD entities: ${missing.join(", ")}` }, null, 2);

  const frdUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  frdUrl.searchParams.set("jql", `parent = "${epicKey}" AND labels = "frd-output-document"`);
  frdUrl.searchParams.set("maxResults", "100");
  frdUrl.searchParams.set("fields", "summary,attachment");
  const frdResponse = await fetch(frdUrl, { headers: getJiraHeaders() });
  if (!frdResponse.ok) return JSON.stringify({ error: `FRD document search failed: ${frdResponse.status}`, details: await frdResponse.text() }, null, 2);
  const frdIssues = ((await frdResponse.json()).issues || []).sort((a: any, b: any) => a.key.localeCompare(b.key));
  if (!frdIssues.length) return JSON.stringify({ error: `No FRD document task found under Epic ${epicKey}.` }, null, 2);
  const frdMarkdown = await downloadAttachment(frdIssues[0].fields?.attachment || [], `FRD_${epicKey}.md`);
  if (!frdMarkdown) return JSON.stringify({ error: `No FRD_${epicKey}.md attachment found on the FRD task.` }, null, 2);

  return JSON.stringify({
    epic: { key: epicKey, summary: epicSummary.summary, description: epicSummary.description },
    source_issue: sourceSummary,
    architecture_document: { issue_key: archIssue.key, markdown: archMarkdown },
    architecture_components: components,
    frd_document: { issue_key: frdIssues[0].key, filename: `FRD_${epicKey}.md`, markdown: frdMarkdown },
  }, null, 2);
}
