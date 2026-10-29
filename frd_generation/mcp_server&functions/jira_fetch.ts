import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders, adfToText } from "./jira_common.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;

function validateIssueKey(issueKey: string): string {
  const key = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(key)) {
    throw new Error("issue_key must be a valid Jira key, for example KAN-4.");
  }
  return key;
}

export async function getJiraIssue(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const response = await fetch(
    `${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,status,description,parent,comment,labels`,
    { headers: getJiraHeaders() }
  );

  if (!response.ok) {
    return JSON.stringify({ error: `Issue lookup failed: ${response.status}`, details: await response.text() });
  }

  const data = await response.json();
  const fields = data.fields || {};
  const parent = fields.parent || {};
  const parentFields = parent.fields || {};
  const comments = (fields.comment?.comments || []).slice(-10);

  return JSON.stringify({
    key: data.key,
    summary: fields.summary,
    issuetype: fields.issuetype?.name,
    status: fields.status?.name,
    description: adfToText(fields.description),
    labels: fields.labels || [],
    parent_issue_key: parent.key,
    parent_summary: parentFields.summary,
    parent_issuetype: parentFields.issuetype?.name,
    recent_comments: comments.map((c: any) => ({
      author: c.author?.displayName || "Unknown",
      body: adfToText(c.body),
    })),
  }, null, 2);
}

export async function searchJiraIssues(jqlQuery: string, maxResults: number = 50): Promise<string> {
  const boundedResults = Math.max(1, Math.min(maxResults, 100));
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  url.searchParams.append("jql", jqlQuery);
  url.searchParams.append("maxResults", boundedResults.toString());
  url.searchParams.append("fields", "summary,issuetype,status,description,labels");

  const response = await fetch(url.toString(), { headers: getJiraHeaders() });

  if (!response.ok) {
    return JSON.stringify({ error: `Issue search failed: ${response.status}`, details: await response.text() });
  }

  const data = await response.json();
  return JSON.stringify(
    (data.issues || []).map((issue: any) => ({
      key: issue.key,
      summary: issue.fields?.summary,
      type: issue.fields?.issuetype?.name,
      status: issue.fields?.status?.name,
      description: adfToText(issue.fields?.description),
      labels: issue.fields?.labels || [],
    })),
    null,
    2
  );
}

export async function getBrdMarkdown(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const issueResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,parent`, {
    headers: getJiraHeaders(),
  });

  if (!issueResponse.ok) {
    return JSON.stringify({ error: `Issue lookup failed: ${issueResponse.status}`, details: await issueResponse.text() }, null, 2);
  }

  const issueData = await issueResponse.json();
  const issueType = issueData.fields?.issuetype?.name?.toLowerCase() || "";
  const parentType = issueData.fields?.parent?.fields?.issuetype?.name?.toLowerCase() || "";

  let epicKey = "";
  if (issueType === "epic") epicKey = key;
  else if (parentType === "epic") epicKey = issueData.fields.parent.key;
  else return JSON.stringify({ error: `${key} is neither a Business Vision Epic nor its direct child.` }, null, 2);

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=summary,attachment,issuetype`, {
    headers: getJiraHeaders(),
  });

  if (!epicResponse.ok) {
    return JSON.stringify({ error: `Epic lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);
  }

  const epicData = await epicResponse.json();
  const expectedName = `brd_${epicKey}.md`.toLowerCase();
  const attachments = epicData.fields?.attachment || [];
  const attachment = attachments.find((a: any) => a.filename?.toLowerCase() === expectedName);

  if (!attachment) {
    const available = attachments.filter((a: any) => a.filename?.toLowerCase().endsWith(".md")).map((a: any) => a.filename);
    return JSON.stringify({ error: `No ${expectedName} attachment found on Epic ${epicKey}.`, available_markdown_attachments: available }, null, 2);
  }

  const attachmentId = attachment.id;
  if (!attachmentId) return JSON.stringify({ error: "BRD attachment metadata is missing its attachment ID." }, null, 2);

  const downloadResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/content/${attachmentId}`, {
    headers: getAttachmentHeaders(),
  });

  if (!downloadResponse.ok) {
    return JSON.stringify({ error: `BRD attachment download failed: ${downloadResponse.status}`, details: await downloadResponse.text() }, null, 2);
  }

  const markdown = await downloadResponse.text();

  return JSON.stringify({
    epic_key: epicKey,
    epic_summary: epicData.fields?.summary,
    attachment_name: attachment.filename,
    markdown_content: markdown,
  }, null, 2);
}
