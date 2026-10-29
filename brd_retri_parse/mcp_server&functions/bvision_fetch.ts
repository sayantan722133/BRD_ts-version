import { JIRA_BASE_URL, BRD_MASTER_ISSUE_KEY, getJiraHeaders, adfToText } from "./customfun.js";

export async function getJiraIssue(issueKey: string): Promise<string> {
  const key = issueKey.trim().toUpperCase();
  const response = await fetch(
    `${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,issuetype,status,description,parent`,
    { headers: getJiraHeaders() }
  );

  if (!response.ok) return JSON.stringify({ error: `Issue lookup failed: ${response.status}`, details: await response.text() }, null, 2);

  const data = await response.json();
  const fields = data.fields || {};
  const parent = fields.parent || {};
  const parentFields = parent.fields || {};

  return JSON.stringify({
    key: data.key,
    summary: fields.summary,
    issuetype: fields.issuetype?.name,
    status: fields.status?.name,
    description: adfToText(fields.description),
    parent_issue_key: parent.key,
    parent_summary: parentFields.summary,
    parent_issuetype: parentFields.issuetype?.name,
  }, null, 2);
}

export async function searchJiraIssues(jqlQuery: string, maxResults: number = 20): Promise<string> {
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  url.searchParams.append("jql", jqlQuery);
  url.searchParams.append("maxResults", maxResults.toString());
  url.searchParams.append("fields", "summary,issuetype");

  const response = await fetch(url.toString(), { headers: getJiraHeaders() });
  if (!response.ok) return JSON.stringify({ error: `Search failed: ${response.status}`, details: await response.text() }, null, 2);

  const data = await response.json();
  return JSON.stringify((data.issues || []).map((issue: any) => ({
    key: issue.key,
    summary: issue.fields?.summary,
    type: issue.fields?.issuetype?.name,
  })), null, 2);
}

export async function getBrdMarkdown(issueKey: string): Promise<string> {
  const sourceKey = issueKey.trim().toUpperCase();
  const sourceResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${sourceKey}?fields=summary,issuetype,parent`, { headers: getJiraHeaders() });
  
  if (!sourceResponse.ok) return JSON.stringify({ error: `Source issue lookup failed: ${sourceResponse.status}`, details: await sourceResponse.text() }, null, 2);

  const sourceData = await sourceResponse.json();
  const sourceFields = sourceData.fields || {};
  const sourceType = (sourceFields.issuetype?.name || "").toLowerCase();
  const parentFields = sourceFields.parent?.fields || {};
  
  let businessVisionKey = sourceKey;
  if (sourceType === "epic") businessVisionKey = sourceKey;
  else if ((parentFields.issuetype?.name || "").toLowerCase() === "epic") businessVisionKey = sourceFields.parent?.key || sourceKey;

  const expectedName = `BRD_${businessVisionKey}.md`.toLowerCase();

  if (businessVisionKey !== BRD_MASTER_ISSUE_KEY) {
    return JSON.stringify({ error: `Business Vision ${businessVisionKey} does not match configured BRD Epic ${BRD_MASTER_ISSUE_KEY}.` }, null, 2);
  }

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${BRD_MASTER_ISSUE_KEY}?fields=issuetype,attachment`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Configured BRD Epic ${BRD_MASTER_ISSUE_KEY} lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);

  const epicFields = (await epicResponse.json()).fields || {};
  if ((epicFields.issuetype?.name || "").toLowerCase() !== "epic") {
    return JSON.stringify({ error: `Configured BRD issue ${BRD_MASTER_ISSUE_KEY} is not a Jira Epic.` }, null, 2);
  }

  const attachments = (epicFields.attachment || []).filter((a: any) => (a.filename || "").toLowerCase() === expectedName);
  
  if (!attachments.length) {
    return JSON.stringify({
      error: `No matching BRD attachment named BRD_${businessVisionKey}.md found on ${BRD_MASTER_ISSUE_KEY}.`,
      available_markdown_attachments: (epicFields.attachment || []).filter((a: any) => (a.filename || "").toLowerCase().endsWith(".md")).map((a: any) => a.filename),
    }, null, 2);
  }

  const attachment = attachments[0];
  if (!attachment.id) return JSON.stringify({ error: "The BRD attachment metadata did not include an attachment ID." }, null, 2);

  const downloadHeaders = getJiraHeaders();
  delete downloadHeaders["Content-Type"];
  
  const downloadResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/content/${attachment.id}`, { headers: downloadHeaders });
  if (!downloadResponse.ok) return JSON.stringify({ error: `BRD attachment download failed: ${downloadResponse.status}`, attachment_name: attachment.filename, details: await downloadResponse.text() }, null, 2);

  return JSON.stringify({
    source_issue_key: sourceKey,
    business_vision_key: businessVisionKey,
    attachment_issue_key: BRD_MASTER_ISSUE_KEY,
    attachment_name: attachment.filename,
    markdown_content: await downloadResponse.text(),
  }, null, 2);
}
