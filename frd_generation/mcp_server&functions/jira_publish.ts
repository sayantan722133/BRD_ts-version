import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders } from "./jira_common.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;
const REQUIREMENT_ID_REGEX = /^FR-\d+$/i;
const STORY_ID_REGEX = /^US-FR-\d+$/i;

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function label(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").substring(0, 255);
}

function storyDescription(story: any) {
  const sourceKeys = story.source_issue_keys.join(", ");
  const content: any[] = [
    paragraph(`Story ID: ${story.story_id}`),
    paragraph(`Source requirement: ${story.source_requirement_id}`),
    paragraph(`Module: ${story.module_id}`),
    paragraph(`BRD input issues: ${sourceKeys}`),
    paragraph(`Priority: ${story.priority}`),
    paragraph("User story (INVEST):"),
    paragraph(story.user_story),
    paragraph("Acceptance criteria (Given/When/Then scenarios):"),
    {
      type: "bulletList",
      content: story.acceptance_criteria.map((c: string) => ({ type: "listItem", content: [paragraph(c)] })),
    },
  ];

  if (story.assumptions?.length) {
    content.push(paragraph("Assumptions:"));
    story.assumptions.forEach((a: string) => content.push(paragraph(a)));
  }
  if (story.open_questions?.length) {
    content.push(paragraph("Open questions:"));
    story.open_questions.forEach((q: string) => content.push(paragraph(q)));
  }
  return content;
}

function validateStories(stories: any[], inputKeys: string[]) {
  if (!Array.isArray(stories)) throw new Error("user_stories_json must contain a JSON array.");

  const validStories: any[] = [];
  const errors: any[] = [];
  const seenRequirements = new Set<string>();

  for (const story of stories) {
    if (typeof story !== "object") {
      errors.push({ error: "Story entry must be an object." });
      continue;
    }

    const requirementId = (story.source_requirement_id || "").trim().toUpperCase();
    const storyId = (story.story_id || "").trim().toUpperCase();
    const sourceKeys = (story.source_issue_keys || []).map((k: string) => k.trim().toUpperCase()).filter((k: string) => ISSUE_KEY_REGEX.test(k));
    const statement = (story.user_story || "").trim();
    const normalizedStatement = statement.toLowerCase();
    const criteria = story.acceptance_criteria;
    const title = (story.title || "").trim();

    const valid = REQUIREMENT_ID_REGEX.test(requirementId) &&
      STORY_ID_REGEX.test(storyId) &&
      storyId === `US-${requirementId}` &&
      !seenRequirements.has(requirementId) &&
      sourceKeys.length > 0 &&
      sourceKeys.every((k: string) => inputKeys.includes(k)) &&
      title.length > 0 &&
      (normalizedStatement.startsWith("as a ") || normalizedStatement.startsWith("as an ")) &&
      normalizedStatement.includes(", i want ") &&
      normalizedStatement.includes(", so that ") &&
      Array.isArray(criteria) &&
      criteria.length >= 3 && criteria.length <= 7 &&
      criteria.every((c: string) => {
        const lowerC = c.toLowerCase();
        return lowerC.includes("given") && lowerC.includes("when") && lowerC.includes("then");
      });

    if (!valid) {
      errors.push({ requirement_id: requirementId, error: "Story failed FRD story validation or references issues outside the BRD input set." });
      continue;
    }

    seenRequirements.add(requirementId);
    validStories.push({
      story_id: storyId,
      source_requirement_id: requirementId,
      source_issue_keys: sourceKeys,
      module_id: story.module_id || "Uncategorized",
      title,
      user_story: statement,
      priority: story.priority || "Unspecified",
      acceptance_criteria: criteria.map(String),
      assumptions: (story.assumptions || []).map(String),
      open_questions: (story.open_questions || []).map(String),
    });
  }
  return { validStories, errors };
}

export async function publishFrdToJira(epicIssueKey: string, frdMarkdown: string, inputIssueKeys: string[], userStoriesJson: string): Promise<string> {
  const epicKey = epicIssueKey.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(epicKey)) throw new Error("epic_issue_key must be a valid Jira issue key.");
  if (!frdMarkdown.trim()) throw new Error("frd_markdown must not be empty.");

  const storiesPayload = JSON.parse(userStoriesJson);
  const inputKeys = [...new Set(inputIssueKeys.map(k => k.trim().toUpperCase()).filter(k => ISSUE_KEY_REGEX.test(k)))];
  const { validStories: stories, errors: storyErrors } = validateStories(storiesPayload, inputKeys);
  const attachmentName = `FRD_${epicKey}.md`;

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=project,issuetype`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Epic lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);

  const epicFields = (await epicResponse.json()).fields || {};
  if (epicFields.issuetype?.name?.toLowerCase() !== "epic") return JSON.stringify({ error: `${epicKey} is not a Jira Epic.` }, null, 2);
  const projectKey = epicFields.project?.key;

  const metadataResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { headers: getJiraHeaders() });
  if (!metadataResponse.ok) return JSON.stringify({ error: `Epic child issue type lookup failed: ${metadataResponse.status}`, details: await metadataResponse.text() }, null, 2);
  const issueTypes = (await metadataResponse.json()).issueTypes || [];
  const taskType = issueTypes.find((it: any) => it.name.toLowerCase() === "task" && !it.subtask);
  if (!taskType) return JSON.stringify({ error: `Project ${projectKey} has no Task issue type for an Epic child.` }, null, 2);
  const subtaskType = issueTypes.find((it: any) => it.subtask);
  if (!subtaskType) return JSON.stringify({ error: `Project ${projectKey} has no sub-task issue type for FRD stories.` }, null, 2);

  const frdSearchUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  frdSearchUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels in ("frd-output-document", "frd-document") ORDER BY key`);
  frdSearchUrl.searchParams.append("maxResults", "100");
  frdSearchUrl.searchParams.append("fields", "summary,attachment,labels");
  const frdSearch = await fetch(frdSearchUrl.toString(), { headers: getJiraHeaders() });
  
  if (!frdSearch.ok) return JSON.stringify({ error: `FRD output issue search failed: ${frdSearch.status}`, details: await frdSearch.text() }, null, 2);
  const existingFrd = (await frdSearch.json()).issues || [];
  existingFrd.sort((a: any, b: any) => (a.fields?.labels?.includes("frd-output-document") ? -1 : 1));

  const duplicateFrdTaskKeys = existingFrd.slice(1).map((i: any) => i.key);
  const frdTaskCreated = existingFrd.length === 0;
  let frdTaskKey = existingFrd.length > 0 ? existingFrd[0].key : null;

  const inputSummary = inputKeys.length ? inputKeys.join(", ") : "No linked BRD input issues found";
  const frdDescriptionLines = [
    `Standalone Functional Requirements Document for Business Vision Epic ${epicKey}.`,
    `BRD and child-ticket inputs: ${inputSummary}.`,
    `Full FRD Markdown is attached as ${attachmentName}.`,
    "FRD-derived user stories are sub-tasks of this FRD Task; none of the BRD input issues are reused as outputs.",
  ];

  if (frdTaskCreated) {
    const createFrd = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
      method: "POST",
      headers: getJiraHeaders(),
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          parent: { key: epicKey },
          issuetype: { id: taskType.id },
          summary: "[FRD] Functional Requirements Document",
          description: { type: "doc", version: 1, content: frdDescriptionLines.map(paragraph) },
          labels: ["frd-output-document"],
        },
      }),
    });
    if (!createFrd.ok) return JSON.stringify({ error: `FRD output Task creation failed: ${createFrd.status}`, details: await createFrd.text() }, null, 2);
    frdTaskKey = (await createFrd.json()).key;
  }

  const storyResults: any[] = [];
  const legacyStoryKeys: string[] = [];
  const duplicateStoryKeys: string[] = [];

  for (const story of stories) {
    const requirementId = story.source_requirement_id;
    const outputLabel = label(`frd-story-${requirementId}`);
    
    const existingUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
    existingUrl.searchParams.append("jql", `parent = "${frdTaskKey}" AND labels = "${outputLabel}"`);
    existingUrl.searchParams.append("maxResults", "100");
    existingUrl.searchParams.append("fields", "summary");
    const existingResponse = await fetch(existingUrl.toString(), { headers: getJiraHeaders() });
    
    if (!existingResponse.ok) {
      storyErrors.push({ requirement_id: requirementId, error: `FRD story lookup failed: ${existingResponse.status}` });
      continue;
    }

    let existingStory = (await existingResponse.json()).issues || [];
    let legacyParent = false;

    if (existingStory.length === 0) {
      const legacyUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
      legacyUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels = "${outputLabel}"`);
      legacyUrl.searchParams.append("maxResults", "100");
      legacyUrl.searchParams.append("fields", "summary,issuetype,parent");
      const legacyResponse = await fetch(legacyUrl.toString(), { headers: getJiraHeaders() });
      if (!legacyResponse.ok) {
        storyErrors.push({ requirement_id: requirementId, error: `Legacy FRD story lookup failed: ${legacyResponse.status}` });
        continue;
      }
      existingStory = (await legacyResponse.json()).issues || [];
      legacyParent = existingStory.length > 0;
    }

    if (existingStory.length > 1) {
      duplicateStoryKeys.push(...existingStory.slice(1).map((i: any) => i.key));
    }
    existingStory = existingStory.slice(0, 1);
    
    const title = story.title;
    const storySummary = `[${requirementId}] User Story: ${title}`.substring(0, 255);
    const storyFields = {
      summary: storySummary,
      description: { type: "doc", version: 1, content: storyDescription(story) },
      labels: ["frd-output-story", outputLabel, label(story.module_id)],
    };

    let storyIssueKey = null;
    let created = false;
    let writeOk = false;

    if (existingStory.length > 0) {
      storyIssueKey = existingStory[0].key;
      const writeResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${storyIssueKey}`, {
        method: "PUT",
        headers: getJiraHeaders(),
        body: JSON.stringify({ fields: storyFields }),
      });
      writeOk = writeResponse.ok;
      if (!writeOk) storyErrors.push({ requirement_id: requirementId, error: `FRD story Task update failed: ${writeResponse.status} ${await writeResponse.text()}` });
    } else {
      const writeResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
        method: "POST",
        headers: getJiraHeaders(),
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            parent: { key: frdTaskKey },
            issuetype: { id: subtaskType.id },
            ...storyFields,
          },
        }),
      });
      writeOk = writeResponse.ok;
      if (writeOk) {
        storyIssueKey = (await writeResponse.json()).key;
        created = true;
      } else {
        storyErrors.push({ requirement_id: requirementId, error: `FRD story Task create failed: ${writeResponse.status} ${await writeResponse.text()}` });
      }
    }

    if (writeOk) {
      storyResults.push({
        source_issue_keys: story.source_issue_keys,
        requirement_id: requirementId,
        story_id: story.story_id,
        story_issue_key: storyIssueKey,
        summary: storySummary,
        created,
        updated: !created,
        parent_issue_key: legacyParent ? epicKey : frdTaskKey,
        hierarchy: legacyParent ? "legacy-epic-child" : "frd-subtask",
      });
      if (legacyParent && storyIssueKey) legacyStoryKeys.push(storyIssueKey);
    }
  }

  const childUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  childUrl.searchParams.append("jql", `parent = "${frdTaskKey}" AND labels in ("frd-output-story", "superseded-output") ORDER BY key`);
  childUrl.searchParams.append("maxResults", "100");
  childUrl.searchParams.append("fields", "labels");
  const childResponse = await fetch(childUrl.toString(), { headers: getJiraHeaders() });
  
  let storyKeys: string[] = [];
  let supersededOutputKeys: string[] = [];
  if (childResponse.ok) {
    const childIssues = (await childResponse.json()).issues || [];
    storyKeys = childIssues.filter((i: any) => i.fields?.labels?.includes("frd-output-story")).map((i: any) => i.key);
    supersededOutputKeys = childIssues.filter((i: any) => i.fields?.labels?.includes("superseded-output")).map((i: any) => i.key);
  } else {
    storyErrors.push({ error: `FRD child lookup failed: ${childResponse.status}` });
  }

  const finalDescriptionLines = [...frdDescriptionLines, "Current FRD story sub-tasks:"];
  if (storyKeys.length) storyKeys.forEach((k: string) => finalDescriptionLines.push(`- ${k}`));
  else finalDescriptionLines.push("None found.");

  if (supersededOutputKeys.length) {
    finalDescriptionLines.push("Superseded generated issues retained for history:");
    supersededOutputKeys.forEach(k => finalDescriptionLines.push(`- ${k}`));
  }
  if (legacyStoryKeys.length) {
    finalDescriptionLines.push("Legacy story Tasks remain direct Epic children and require a Jira move to become sub-tasks:");
    legacyStoryKeys.forEach(k => finalDescriptionLines.push(`- ${k}`));
  }
  if (duplicateStoryKeys.length) {
    finalDescriptionLines.push("Additional duplicate story Tasks were detected and not modified:");
    duplicateStoryKeys.forEach(k => finalDescriptionLines.push(`- ${k}`));
  }
  if (duplicateFrdTaskKeys.length) {
    finalDescriptionLines.push("Additional FRD document Tasks were detected and not modified:");
    duplicateFrdTaskKeys.forEach((k: string) => finalDescriptionLines.push(`- ${k}`));
  }

  const updateResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${frdTaskKey}`, {
    method: "PUT",
    headers: getJiraHeaders(),
    body: JSON.stringify({ fields: { description: { type: "doc", version: 1, content: finalDescriptionLines.map(paragraph) } } }),
  });
  if (!updateResponse.ok) storyErrors.push({ error: `Could not update FRD Task with output story keys: ${updateResponse.status}` });

  const existingAttachments = existingFrd.length > 0 ? existingFrd[0].fields?.attachment || [] : [];
  
  const formData = new FormData();
  formData.append("file", new Blob([frdMarkdown], { type: "text/markdown" }), attachmentName);
  
  const upload = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${frdTaskKey}/attachments`, {
    method: "POST",
    headers: getAttachmentHeaders(),
    body: formData,
  });

  if (!upload.ok) {
    return JSON.stringify({
      error: `FRD Task was written, but attachment upload failed: ${upload.status}`,
      details: await upload.text(),
      frd_task_key: frdTaskKey,
      story_tasks: storyResults,
      story_errors: storyErrors,
    }, null, 2);
  }

  const uploadedAttachments = await upload.json();
  const uploadedAttachmentId = uploadedAttachments[0]?.id || "";
  if (!uploadedAttachmentId) {
    return JSON.stringify({
      error: "FRD uploaded, but Jira did not return its attachment ID; older attachments were kept.",
      frd_task_key: frdTaskKey,
      story_tasks: storyResults,
      story_errors: storyErrors,
    }, null, 2);
  }

  const attachmentCleanupErrors: any[] = [];
  for (const existing of existingAttachments) {
    const oldFilename = existing.filename || "";
    const oldId = existing.id || "";
    if (oldId && oldId !== uploadedAttachmentId && (oldFilename.toLowerCase() === attachmentName.toLowerCase() || (oldFilename.toLowerCase().startsWith(`frd_${epicKey}_`.toLowerCase()) && oldFilename.toLowerCase().endsWith(".md")))) {
      const deleteResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/${oldId}`, {
        method: "DELETE",
        headers: getJiraHeaders(),
      });
      if (!deleteResponse.ok) attachmentCleanupErrors.push({ attachment_id: oldId, filename: oldFilename, error: `Delete failed: ${deleteResponse.status} ${await deleteResponse.text()}` });
    }
  }

  return JSON.stringify({
    epic_issue_key: epicKey,
    input_issue_keys: inputKeys,
    frd_task_key: frdTaskKey,
    frd_task_created: frdTaskCreated,
    frd_attachment: attachmentName,
    attachment_uploaded: true,
    attachment_cleanup_errors: attachmentCleanupErrors,
    story_tasks: storyResults,
    story_errors: storyErrors,
    legacy_story_tasks: legacyStoryKeys,
    duplicate_story_tasks: duplicateStoryKeys,
    duplicate_frd_document_tasks: duplicateFrdTaskKeys,
    superseded_output_tasks: supersededOutputKeys,
    outputs_are_distinct_from_brd_inputs: true,
  }, null, 2);
}
