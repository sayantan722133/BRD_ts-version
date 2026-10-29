import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders } from "./customfun.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;
const COMPONENT_ID_REGEX = /^COMP-[A-Z0-9]+-\d+$/i;

function paragraph(text: string) { return { type: "paragraph", content: [{ type: "text", text }] }; }
function label(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").substring(0, 255); }

function componentOutputLabel(component: any): string {
  const reqIds = (component.source_requirement_ids || []).map(String).map((s: string) => s.toLowerCase()).sort();
  const storyIds = (component.source_story_ids || []).map(String).map((s: string) => s.toLowerCase()).sort();
  const identity = [String(component.component_id).toLowerCase(), String(component.module_id).toLowerCase(), ...reqIds, ...storyIds].join("-");
  return label(`arch-comp-${identity}`);
}

function componentDescription(comp: any) {
  const frKeys = (comp.source_requirement_ids || []).join(", ");
  const storyKeys = (comp.source_story_ids || []).join(", ");
  const tech = (comp.tech_stack || []).join(", ");
  const entities = (comp.data_entities_handled || []).join(", ");
  const deps = (comp.dependencies || []).join(", ") || "None";

  return [
    paragraph(`Component ID: ${comp.component_id}`),
    paragraph(`Type: ${comp.component_type}`),
    paragraph(`Module: ${comp.module_id}`),
    paragraph(`Tech Stack: ${tech}`),
    paragraph(`Dependencies: ${deps}`),
    paragraph(`Managed Data Entities (ERD Precursors): ${entities}`),
    paragraph(`Traceable FR IDs: ${frKeys}`),
    paragraph(`Traceable User Stories: ${storyKeys}`),
    paragraph("Core Responsibilities:"),
    {
      type: "bulletList",
      content: (comp.responsibilities || []).map((item: string) => ({ type: "listItem", content: [paragraph(item)] })),
    },
  ];
}

export async function publishArchToJira(epicIssueKey: string, archMarkdown: string, inputIssueKeys: string[], componentsJson: string, integrationContractsJson: string = "[]"): Promise<string> {
  const epicKey = epicIssueKey.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(epicKey)) throw new Error("epic_issue_key must be a valid Jira issue key.");
  if (!archMarkdown.trim()) throw new Error("arch_markdown must not be empty.");

  const componentsPayload = JSON.parse(componentsJson);
  const attachmentName = `ARCH_${epicKey}.md`;

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=project,issuetype`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Epic lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);

  const epicFields = (await epicResponse.json()).fields || {};
  if (epicFields.issuetype?.name?.toLowerCase() !== "epic") return JSON.stringify({ error: `${epicKey} is not a Jira Epic.` }, null, 2);
  const projectKey = epicFields.project?.key;

  const metadataResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { headers: getJiraHeaders() });
  if (!metadataResponse.ok) return JSON.stringify({ error: `Issue metadata lookup failed: ${metadataResponse.status}`, details: await metadataResponse.text() }, null, 2);
  
  const issueTypes = (await metadataResponse.json()).issueTypes || [];
  const taskType = issueTypes.find((it: any) => it.name.toLowerCase() === "task" && !it.subtask);
  if (!taskType) return JSON.stringify({ error: `Project ${projectKey} has no Task issue type for an Epic child.` }, null, 2);
  const subtaskType = issueTypes.find((it: any) => it.subtask);
  if (!subtaskType) return JSON.stringify({ error: `Project ${projectKey} has no sub-task issue type for architecture components.` }, null, 2);

  const archSearchUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  archSearchUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels = "arch-output-document"`);
  archSearchUrl.searchParams.append("maxResults", "100");
  archSearchUrl.searchParams.append("fields", "summary,attachment");
  
  const archSearch = await fetch(archSearchUrl.toString(), { headers: getJiraHeaders() });
  if (!archSearch.ok) return JSON.stringify({ error: `Architecture issue search failed: ${archSearch.status}`, details: await archSearch.text() }, null, 2);
  
  const existingArch = ((await archSearch.json()).issues || []).sort((a: any, b: any) => (a.key > b.key ? 1 : -1));
  const duplicateArchTaskKeys = existingArch.slice(1).map((i: any) => i.key);
  const archTaskCreated = existingArch.length === 0;
  let archTaskKey = existingArch.length > 0 ? existingArch[0].key : null;

  const archDescriptionLines = [
    `System Architecture & Component Design Specification for Epic ${epicKey}.`,
    `Traceable FRD Inputs: ${inputIssueKeys?.length ? inputIssueKeys.join(", ") : "None"}.`,
    `Full Architecture Document is attached as ${attachmentName}.`,
    "Discrete Architecture Components are generated as sub-tasks of this Architecture Task for downstream ERD modeling.",
  ];

  if (archTaskCreated) {
    const createArch = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
      method: "POST",
      headers: getJiraHeaders(),
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          parent: { key: epicKey },
          issuetype: { id: taskType.id },
          summary: "[ARCH] System Architecture & Component Design",
          description: { type: "doc", version: 1, content: archDescriptionLines.map(paragraph) },
          labels: ["arch-output-document"],
        }
      })
    });
    if (!createArch.ok) return JSON.stringify({ error: `Architecture Task creation failed: ${createArch.status}`, details: await createArch.text() }, null, 2);
    archTaskKey = (await createArch.json()).key;
  }

  const componentResults: any[] = [];
  const legacyComponentKeys: string[] = [];
  const duplicateComponentKeys: string[] = [];

  for (const comp of componentsPayload) {
    const compId = (comp.component_id || "").trim().toUpperCase();
    if (!COMPONENT_ID_REGEX.test(compId)) continue;

    const outputLabel = componentOutputLabel(comp);
    const existingUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
    existingUrl.searchParams.append("jql", `parent = "${archTaskKey}" AND labels = "${outputLabel}"`);
    existingUrl.searchParams.append("maxResults", "100");
    existingUrl.searchParams.append("fields", "summary");
    
    const existingResponse = await fetch(existingUrl.toString(), { headers: getJiraHeaders() });
    if (!existingResponse.ok) return JSON.stringify({ error: `Component lookup failed for ${compId}: ${existingResponse.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);
    
    let existingCompTask = ((await existingResponse.json()).issues || []).sort((a: any, b: any) => (a.key > b.key ? 1 : -1));
    let legacyParent = false;
    const compName = (comp.name || "").trim();

    if (existingCompTask.length === 0) {
      const currentChildrenUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
      currentChildrenUrl.searchParams.append("jql", `parent = "${archTaskKey}" AND labels = "arch-output-component" ORDER BY key`);
      currentChildrenUrl.searchParams.append("maxResults", "100");
      currentChildrenUrl.searchParams.append("fields", "summary");

      const currentChildrenResponse = await fetch(currentChildrenUrl.toString(), { headers: getJiraHeaders() });
      if (!currentChildrenResponse.ok) {
        return JSON.stringify({ error: `Component identity lookup failed for ${compId}: ${currentChildrenResponse.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);
      }

      const currentChildren = (await currentChildrenResponse.json()).issues || [];
      existingCompTask = currentChildren.filter((issue: any) =>
        (issue.fields?.summary || "").toUpperCase().startsWith(`[${compId}] COMPONENT:`)
      );
    }

    if (existingCompTask.length === 0) {
      const moduleLabel = label(comp.module_id || "Core");
      const legacyUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
      legacyUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels = "arch-output-component" AND labels = "${moduleLabel}" ORDER BY key`);
      legacyUrl.searchParams.append("maxResults", "100");
      legacyUrl.searchParams.append("fields", "summary,issuetype,parent,labels");
      
      const legacyResponse = await fetch(legacyUrl.toString(), { headers: getJiraHeaders() });
      if (!legacyResponse.ok) return JSON.stringify({ error: `Legacy component lookup failed for ${compId}: ${legacyResponse.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);
      
      const legacyIssues = (await legacyResponse.json()).issues || [];
      const matchingLegacy = legacyIssues.filter((i: any) => (i.fields?.summary || "").split("] Component: ").pop()?.trim().toLowerCase() === compName.toLowerCase());
      existingCompTask = matchingLegacy.sort((a: any, b: any) => (a.key > b.key ? 1 : -1));
      legacyParent = existingCompTask.length > 0;
    }

    if (existingCompTask.length > 1) duplicateComponentKeys.push(...existingCompTask.slice(1).map((i: any) => i.key));
    existingCompTask = existingCompTask.slice(0, 1);
    
    const compSummary = `[${compId}] Component: ${compName}`.substring(0, 255);
    const moduleId = comp.module_id || "Core";
    const compFields = {
      summary: compSummary,
      description: { type: "doc", version: 1, content: componentDescription(comp) },
      labels: ["arch-output-component", outputLabel, label(moduleId)],
    };

    let compTaskKey = null;
    let created = false;
    let writeStatus = "failed";

    if (existingCompTask.length > 0) {
      compTaskKey = existingCompTask[0].key;
      const writeResp = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${compTaskKey}`, {
        method: "PUT",
        headers: getJiraHeaders(),
        body: JSON.stringify({ fields: compFields })
      });
      writeStatus = writeResp.ok ? "success" : `failed: ${writeResp.status}`;
    } else {
      const writeResp = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
        method: "POST",
        headers: getJiraHeaders(),
        body: JSON.stringify({ fields: { project: { key: projectKey }, parent: { key: archTaskKey }, issuetype: { id: subtaskType.id }, ...compFields } })
      });
      if (writeResp.ok) {
        compTaskKey = (await writeResp.json()).key;
        created = true;
        writeStatus = "success";
      } else {
        writeStatus = `failed: ${writeResp.status}`;
      }
    }

    componentResults.push({
      component_id: compId,
      component_task_key: compTaskKey,
      summary: compSummary,
      created,
      status: writeStatus,
      parent_issue_key: legacyParent ? epicKey : archTaskKey,
      hierarchy: legacyParent ? "legacy-epic-child" : "architecture-subtask",
    });
    if (legacyParent && compTaskKey) legacyComponentKeys.push(compTaskKey);
  }

  const childUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  childUrl.searchParams.append("jql", `parent = "${archTaskKey}" AND labels in ("arch-output-component", "superseded-output") ORDER BY key`);
  childUrl.searchParams.append("maxResults", "100");
  childUrl.searchParams.append("fields", "labels");
  const compChildrenResponse = await fetch(childUrl.toString(), { headers: getJiraHeaders() });
  
  if (!compChildrenResponse.ok) return JSON.stringify({ error: `Architecture child lookup failed: ${compChildrenResponse.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);
  
  const childIssues = (await compChildrenResponse.json()).issues || [];
  const activeComponentKeys = childIssues.filter((i: any) => i.fields?.labels?.includes("arch-output-component") && !i.fields?.labels?.includes("superseded-output")).map((i: any) => i.key);
  const supersededComponentKeys = childIssues.filter((i: any) => i.fields?.labels?.includes("superseded-output")).map((i: any) => i.key);

  const finalDescriptionLines = [...archDescriptionLines, "Current architecture components are sub-tasks of this document:"];
  if (activeComponentKeys.length) activeComponentKeys.forEach((k: string) => finalDescriptionLines.push(`- ${k}`));
  else finalDescriptionLines.push("None found.");

  if (supersededComponentKeys.length) {
    finalDescriptionLines.push("Superseded generated components retained for history:");
    supersededComponentKeys.forEach((k: string) => finalDescriptionLines.push(`- ${k}`));
  }

  const updateArch = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${archTaskKey}`, {
    method: "PUT",
    headers: getJiraHeaders(),
    body: JSON.stringify({ fields: { description: { type: "doc", version: 1, content: finalDescriptionLines.map(paragraph) } } })
  });
  if (!updateArch.ok) return JSON.stringify({ error: `Architecture Task description update failed: ${updateArch.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);

  const formData = new FormData();
  formData.append("file", new Blob([archMarkdown], { type: "text/markdown" }), attachmentName);

  const upload = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${archTaskKey}/attachments`, {
    method: "POST",
    headers: getAttachmentHeaders(),
    body: formData,
  });

  if (!upload.ok) return JSON.stringify({ error: `Architecture Task was written, but attachment upload failed: ${upload.status}`, arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);

  const uploadedAttachments = await upload.json();
  const uploadedAttachmentId = uploadedAttachments[0]?.id || "";
  if (!uploadedAttachmentId) return JSON.stringify({ error: "Architecture document uploaded, but Jira did not return its attachment ID.", arch_task_key: archTaskKey, component_tasks: componentResults }, null, 2);

  const attachmentCleanupErrors: any[] = [];
  const existingAttachments = existingArch.length > 0 ? existingArch[0].fields?.attachment || [] : [];
  for (const existing of existingAttachments) {
    const oldFilename = existing.filename || "";
    const oldId = existing.id || "";
    if (oldId && oldId !== uploadedAttachmentId && (oldFilename.toLowerCase() === attachmentName.toLowerCase() || (oldFilename.toLowerCase().startsWith(`arch_${epicKey}_`.toLowerCase()) && oldFilename.toLowerCase().endsWith(".md")))) {
      const deleteResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/${oldId}`, { method: "DELETE", headers: getJiraHeaders() });
      if (!deleteResponse.ok) attachmentCleanupErrors.push({ attachment_id: oldId, filename: oldFilename, error: `Delete failed: ${deleteResponse.status}` });
    }
  }

  return JSON.stringify({
    epic_issue_key: epicKey,
    arch_task_key: archTaskKey,
    arch_attachment: attachmentName,
    attachment_uploaded: true,
    attachment_cleanup_errors: attachmentCleanupErrors,
    component_tasks: componentResults,
    legacy_component_tasks: legacyComponentKeys,
    duplicate_component_tasks: duplicateComponentKeys,
    duplicate_architecture_document_tasks: duplicateArchTaskKeys,
    superseded_component_tasks: supersededComponentKeys,
  }, null, 2);
}
