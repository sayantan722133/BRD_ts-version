import { JIRA_BASE_URL, extractAdfText, getJiraHeaders } from "./customfun.js";

export async function getJiraIssue(issueKey: string): Promise<string> {
  const normalizedKey = issueKey.trim().toUpperCase();
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${normalizedKey}?expand=renderedFields,names`;

  const response = await fetch(url, { headers: getJiraHeaders() });
  if (!response.ok) {
    return JSON.stringify({
      error: `Failed to retrieve ${normalizedKey}: ${response.status}`,
      details: await response.text(),
    });
  }

  const data = await response.json();
  const fields = data.fields || {};
  const commentsData = fields.comment?.comments || [];

  const result = {
    key: data.key,
    summary: fields.summary,
    issuetype: fields.issuetype?.name,
    status: fields.status?.name,
    description: extractAdfText(fields.description).trim(),
    recent_comments: commentsData.slice(-5).map((c: any) => 
      `[${c.author?.displayName || 'Unknown'}]: ${extractAdfText(c.body)}`
    ),
  };
  
  return JSON.stringify(result, null, 2);
}

export async function searchJiraIssues(jqlQuery: string, maxResults: number = 5): Promise<string> {
  const url = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
  url.searchParams.append("jql", jqlQuery);
  url.searchParams.append("maxResults", maxResults.toString());
  url.searchParams.append("fields", "summary,status,issuetype");

  const response = await fetch(url.toString(), { headers: getJiraHeaders() });
  if (!response.ok) {
    return JSON.stringify({
      error: `Search failed: ${response.status}`,
      details: await response.text(),
    });
  }

  const data = await response.json();
  const issues = data.issues || [];
  
  const result = issues.map((issue: any) => ({
    key: issue.key,
    summary: issue.fields?.summary,
    type: issue.fields?.issuetype?.name,
    status: issue.fields?.status?.name,
  }));

  return JSON.stringify(result, null, 2);
}
