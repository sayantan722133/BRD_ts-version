import { JIRA_BASE_URL, getJiraHeaders, getAttachmentHeaders, adfToText } from "./customfun.js";

const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;

function validateIssueKey(issueKey: string): string {
  const key = issueKey.trim().toUpperCase();
  if (!ISSUE_KEY_REGEX.test(key)) throw new Error("issue_key must be a valid Jira key, for example KAN-4.");
  return key;
}

export async function getJiraIssue(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const response = await fetch(
    `${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,status,description,parent,comment,labels`,
    { headers: getJiraHeaders() }
  );

  if (!response.ok) return JSON.stringify({ error: `Issue lookup failed: ${response.status}`, details: await response.text() });
  
  const data = await response.json();
  const fields = data.fields || {};
  const parent = fields.parent || {};
  const comments = (fields.comment?.comments || []).slice(-10);

  return JSON.stringify({
    key: data.key,
    summary: fields.summary,
    issuetype: fields.issuetype?.name,
    status: fields.status?.name,
    description: adfToText(fields.description),
    labels: fields.labels || [],
    parent_issue_key: parent.key,
    parent_summary: parent.fields?.summary,
    parent_issuetype: parent.fields?.issuetype?.name,
    recent_comments: comments.map((c: any) => ({ author: c.author?.displayName || "Unknown", body: adfToText(c.body) })),
  }, null, 2);
}

export async function searchJiraIssues(jqlQuery: string, maxResults: number = 50): Promise<string> {
  const boundedResults = Math.max(1, Math.min(maxResults, 100));
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  url.searchParams.append("jql", jqlQuery);
  url.searchParams.append("maxResults", boundedResults.toString());
  url.searchParams.append("fields", "summary,issuetype,status,description,labels");

  const response = await fetch(url.toString(), { headers: getJiraHeaders() });
  if (!response.ok) return JSON.stringify({ error: `Issue search failed: ${response.status}`, details: await response.text() });

  const data = await response.json();
  return JSON.stringify((data.issues || []).map((issue: any) => ({
    key: issue.key,
    summary: issue.fields?.summary,
    type: issue.fields?.issuetype?.name,
    status: issue.fields?.status?.name,
    description: adfToText(issue.fields?.description),
    labels: issue.fields?.labels || [],
  })), null, 2);
}

function selectFrdAttachment(attachments: any[], epicKey: string): any {
  const markdownAttachments = attachments.filter(a => 
    (a.filename || "").toLowerCase().startsWith(`frd_${epicKey}`.toLowerCase()) && 
    (a.filename || "").toLowerCase().endsWith(".md")
  );
  const stableName = `FRD_${epicKey}.md`.toLowerCase();
  
  const exactMatch = markdownAttachments.find(a => (a.filename || "").toLowerCase() === stableName);
  if (exactMatch) return exactMatch;
  
  return markdownAttachments.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())[0] || null;
}

export async function getFrdMarkdown(issueKey: string): Promise<string> {
  const key = validateIssueKey(issueKey);
  const issueResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,parent,attachment`, { headers: getJiraHeaders() });
  
  if (!issueResponse.ok) return JSON.stringify({ error: `Issue lookup failed: ${issueResponse.status}`, details: await issueResponse.text() }, null, 2);
  
  const issueData = await issueResponse.json();
  const issueType = issueData.fields?.issuetype?.name?.toLowerCase() || "";
  const parentType = issueData.fields?.parent?.fields?.issuetype?.name?.toLowerCase() || "";

  let epicKey = "";
  if (issueType === "epic") epicKey = key;
  else if (parentType === "epic") epicKey = issueData.fields.parent.key;
  else return JSON.stringify({ error: `${key} is neither a Jira Epic nor its direct child.` }, null, 2);

  const frdSearchUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  frdSearchUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels = "frd-output-document"`);
  frdSearchUrl.searchParams.append("maxResults", "1");
  frdSearchUrl.searchParams.append("fields", "summary,attachment");
  
  const frdSearch = await fetch(frdSearchUrl.toString(), { headers: getJiraHeaders() });
  let attachment = null;
  let targetIssueSummary = "";

  if (frdSearch.ok) {
    const tasks = (await frdSearch.json()).issues || [];
    if (tasks.length > 0) {
      targetIssueSummary = tasks[0].fields?.summary || "";
      attachment = selectFrdAttachment(tasks[0].fields?.attachment || [], epicKey);
    }
  }

  if (!attachment) {
    const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=summary,attachment`, { headers: getJiraHeaders() });
    if (epicResponse.ok) {
      const epicData = await epicResponse.json();
      targetIssueSummary = epicData.fields?.summary || "";
      attachment = selectFrdAttachment(epicData.fields?.attachment || [], epicKey);
    }
  }

  if (!attachment) return JSON.stringify({ error: `No FRD Markdown attachment found for Epic ${epicKey}.` }, null, 2);

  const download = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/content/${attachment.id}`, { headers: getAttachmentHeaders() });
  if (!download.ok) return JSON.stringify({ error: `FRD attachment download failed: ${download.status}`, details: await download.text() }, null, 2);

  return JSON.stringify({
    epic_key: epicKey,
    source_summary: targetIssueSummary,
    attachment_name: attachment.filename,
    markdown_content: await download.text(),
  }, null, 2);
}
