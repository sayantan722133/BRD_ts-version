import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders, paragraph } from "./customfun.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;
const TABLE_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 255);
}

function parseEntities(value: string): any[] {
  let entities: any;
  try {
    entities = JSON.parse(value);
  } catch {
    throw new Error("entities_json must contain valid JSON.");
  }
  if (!Array.isArray(entities) || !entities.length) throw new Error("entities_json must contain at least one entity.");
  const tableNames = new Set<string>();
  for (const entity of entities) {
    if (!entity || !TABLE_NAME_REGEX.test(String(entity.table_name || ""))) throw new Error("Each entity must have a valid table_name.");
    if (tableNames.has(entity.table_name.toLowerCase())) throw new Error("entities_json contains duplicate table names.");
    tableNames.add(entity.table_name.toLowerCase());
    if (!Array.isArray(entity.attributes) || !entity.attributes.length) throw new Error(`Entity ${entity.table_name} must contain attributes.`);
    const names = new Set<string>();
    let primaryCount = 0;
    for (const attribute of entity.attributes) {
      if (!attribute || !TABLE_NAME_REGEX.test(String(attribute.name || "")) || typeof attribute.data_type !== "string" || !attribute.data_type.trim()) {
        throw new Error(`Entity ${entity.table_name} contains an invalid attribute.`);
      }
      if (names.has(attribute.name.toLowerCase())) throw new Error(`Entity ${entity.table_name} contains duplicate attributes.`);
      names.add(attribute.name.toLowerCase());
      if (attribute.is_primary) primaryCount++;
    }
    if (!primaryCount) throw new Error(`Entity ${entity.table_name} must contain a primary key.`);
  }
  return entities;
}

function entityDescription(entity: any) {
  const lines = [`Database table: ${entity.table_name}`, "Columns:"];
  for (const attribute of entity.attributes || []) {
    const constraints = [
      attribute.is_primary ? "PK" : "",
      attribute.is_foreign ? "FK" : "",
    ].filter(Boolean);
    lines.push(`- ${attribute.name}: ${attribute.data_type}${constraints.length ? ` (${constraints.join(", ")})` : ""}`);
  }
  return lines.map(paragraph);
}

export async function publishErdToJira(epicIssueKey: string, erdMarkdown: string, entitiesJson: string): Promise<string> {
  const epicKey = epicIssueKey.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(epicKey)) throw new Error("epic_issue_key must be a valid Jira issue key.");
  if (!erdMarkdown.trim()) throw new Error("erd_markdown must not be empty.");
  const entities = parseEntities(entitiesJson);
  const attachmentName = `ERD_${epicKey}.md`;

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=project,issuetype`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Epic lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);
  const epicData = await epicResponse.json();
  if (epicData.fields?.issuetype?.name?.toLowerCase() !== "epic") return JSON.stringify({ error: `${epicKey} is not a Jira Epic.` }, null, 2);
  const projectKey = epicData.fields.project?.key;

  const metadataResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { headers: getJiraHeaders() });
  if (!metadataResponse.ok) return JSON.stringify({ error: `Issue metadata lookup failed: ${metadataResponse.status}`, details: await metadataResponse.text() }, null, 2);
  const issueTypes = (await metadataResponse.json()).issueTypes || [];
  const taskType = issueTypes.find((item: any) => item.name?.toLowerCase() === "task" && !item.subtask);
  const subtaskType = issueTypes.find((item: any) => item.subtask);
  if (!taskType || !subtaskType) return JSON.stringify({ error: `Project ${projectKey} must support Task and sub-task issue types.` }, null, 2);

  const searchUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  searchUrl.searchParams.set("jql", `parent = "${epicKey}" AND labels = "erd-output-document" ORDER BY key`);
  searchUrl.searchParams.set("maxResults", "100");
  searchUrl.searchParams.set("fields", "summary,attachment");
  const searchResponse = await fetch(searchUrl, { headers: getJiraHeaders() });
  if (!searchResponse.ok) return JSON.stringify({ error: `ERD document search failed: ${searchResponse.status}`, details: await searchResponse.text() }, null, 2);
  const existingTasks = ((await searchResponse.json()).issues || []).sort((a: any, b: any) => a.key.localeCompare(b.key));
  let taskKey = existingTasks[0]?.key || null;
  const createdTask = !taskKey;
  const existingAttachments = existingTasks[0]?.fields?.attachment || [];
  const fields = {
    summary: "[ERD] Database Schema & ERD",
    description: { type: "doc", version: 1, content: [
      paragraph(`Database Schema and ERD for Epic ${epicKey}.`),
      paragraph(`The complete document is attached as ${attachmentName}.`),
      paragraph("Generated database entities are represented by child subtasks."),
    ] },
    labels: ["erd-output-document"],
  };

  if (taskKey) {
    const update = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${taskKey}`, { method: "PUT", headers: getJiraHeaders(), body: JSON.stringify({ fields }) });
    if (!update.ok) return JSON.stringify({ error: `ERD Task update failed: ${update.status}`, details: await update.text(), erd_task_key: taskKey }, null, 2);
  } else {
    const create = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
      method: "POST",
      headers: getJiraHeaders(),
      body: JSON.stringify({ fields: { project: { key: projectKey }, parent: { key: epicKey }, issuetype: { id: taskType.id }, ...fields } }),
    });
    if (!create.ok) return JSON.stringify({ error: `ERD Task creation failed: ${create.status}`, details: await create.text() }, null, 2);
    taskKey = (await create.json()).key;
  }
  if (!taskKey) return JSON.stringify({ error: "Jira did not return the ERD Task key." }, null, 2);

  const upload = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${taskKey}/attachments`, {
    method: "POST",
    headers: getAttachmentHeaders(),
    body: (() => {
      const form = new FormData();
      form.append("file", new Blob([erdMarkdown], { type: "text/markdown" }), attachmentName);
      return form;
    })(),
  });
  if (!upload.ok) return JSON.stringify({ error: `ERD attachment upload failed: ${upload.status}`, details: await upload.text(), erd_task_key: taskKey }, null, 2);
  const uploaded = await upload.json();
  const uploadedId = uploaded[0]?.id ? String(uploaded[0].id) : "";
  const cleanupErrors: any[] = [];
  if (uploadedId) {
    for (const old of existingAttachments) {
      if (old.id && String(old.id) !== uploadedId && String(old.filename).toLowerCase() === attachmentName.toLowerCase()) {
        const remove = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/${old.id}`, { method: "DELETE", headers: getJiraHeaders() });
        if (!remove.ok) cleanupErrors.push({ attachment_id: old.id, filename: old.filename, error: `Delete failed: ${remove.status} ${await remove.text()}` });
      }
    }
  }

  const entityTasks: any[] = [];
  for (const entity of entities) {
    const outputLabel = normalizeLabel(`erd-entity-${entity.table_name}`);
    const entitySearch = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
    entitySearch.searchParams.set("jql", `parent = "${taskKey}" AND labels = "${outputLabel}"`);
    entitySearch.searchParams.set("maxResults", "100");
    entitySearch.searchParams.set("fields", "summary");
    const response = await fetch(entitySearch, { headers: getJiraHeaders() });
    if (!response.ok) return JSON.stringify({ error: `Entity task search failed for ${entity.table_name}: ${response.status}`, erd_task_key: taskKey, entity_tasks: entityTasks }, null, 2);
    const existing = ((await response.json()).issues || []).sort((a: any, b: any) => a.key.localeCompare(b.key));
    const entityFields = {
      summary: `[ERD] Table: ${entity.table_name}`.slice(0, 255),
      description: { type: "doc", version: 1, content: entityDescription(entity) },
      labels: ["erd-output-entity", outputLabel],
    };
    let entityKey: string | null = existing[0]?.key || null;
    let write;
    if (entityKey) {
      write = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${entityKey}`, { method: "PUT", headers: getJiraHeaders(), body: JSON.stringify({ fields: entityFields }) });
    } else {
      write = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
        method: "POST",
        headers: getJiraHeaders(),
        body: JSON.stringify({ fields: { project: { key: projectKey }, parent: { key: taskKey }, issuetype: { id: subtaskType.id }, ...entityFields } }),
      });
      entityKey = write.ok ? (await write.json()).key : null;
    }
    if (!write.ok) return JSON.stringify({ error: `Entity task write failed for ${entity.table_name}: ${write.status}`, details: await write.text(), erd_task_key: taskKey, entity_tasks: entityTasks }, null, 2);
    entityTasks.push({ table_name: entity.table_name, issue_key: entityKey, created: !existing.length });
  }

  return JSON.stringify({
    epic_issue_key: epicKey,
    erd_task_key: taskKey,
    erd_task_created: createdTask,
    attachment_name: attachmentName,
    attachment_cleanup_errors: cleanupErrors,
    entity_tasks: entityTasks,
  }, null, 2);
}
