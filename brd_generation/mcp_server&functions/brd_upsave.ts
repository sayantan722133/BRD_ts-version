import { JIRA_BASE_URL, extractAdfText, getJiraAuthHeaders, getJiraHeaders, normalizeBrdFilename, saveBrdContent } from "./customfun.js";

export async function saveBrdFile(fileName: string, markdownContent: string): Promise<string> {
  const filePath = saveBrdContent(fileName, markdownContent);
  return `BRD successfully written to: ${filePath}`;
}

export async function publishBrdToJira(issueKey: string, fileName: string, markdownContent: string, comment: string = ""): Promise<string> {
  const normalizedKey = issueKey.trim().toUpperCase();
  if (!normalizedKey) throw new Error("issue_key must not be empty.");

  const safeName = normalizeBrdFilename(fileName);
  const localPath = saveBrdContent(safeName, markdownContent);

  const sourceResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${normalizedKey}?fields=summary,issuetype,parent`, { headers: getJiraHeaders() });
  if (!sourceResponse.ok) return JSON.stringify({ error: `BRD saved locally but source issue lookup failed: ${sourceResponse.status}`, local_path: localPath, details: await sourceResponse.text() }, null, 2);

  const sourceFields = (await sourceResponse.json()).fields || {};
  const sourceType = (sourceFields.issuetype?.name || "").toLowerCase();
  const sourceParentType = (sourceFields.parent?.fields?.issuetype?.name || "").toLowerCase();

  let businessVisionKey = "";
  if (sourceType === "epic") businessVisionKey = normalizedKey;
  else if (sourceParentType === "epic") businessVisionKey = sourceFields.parent.key;
  else return JSON.stringify({ error: `${normalizedKey} is not a Business Vision Epic or a child of one.`, local_path: localPath }, null, 2);

  const targetIssueKey = businessVisionKey;
  const targetResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${targetIssueKey}?fields=attachment,comment`, { headers: getJiraHeaders() });
  if (!targetResponse.ok) return JSON.stringify({ error: `BRD saved locally but target Epic lookup failed: ${targetResponse.status}`, local_path: localPath, target_issue_key: targetIssueKey, details: await targetResponse.text() }, null, 2);

  const targetFields = (await targetResponse.json()).fields || {};
  const existingAttachments = targetFields.attachment || [];

  const formData = new FormData();
  formData.append("file", new Blob([markdownContent], { type: "text/markdown" }), safeName);

  const uploadResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${targetIssueKey}/attachments`, {
    method: "POST",
    headers: getJiraAuthHeaders(),
    body: formData,
  });

  if (!uploadResponse.ok) return JSON.stringify({ error: `BRD saved locally but upload to ${targetIssueKey} failed: ${uploadResponse.status}`, local_path: localPath, target_issue_key: targetIssueKey, details: await uploadResponse.text() }, null, 2);

  const attachmentData = await uploadResponse.json();
  const attachment = attachmentData.length ? attachmentData[0] : {};
  const uploadedAttachmentId = attachment.id ? String(attachment.id) : "";

  if (!uploadedAttachmentId) return JSON.stringify({ error: "BRD uploaded, but Jira did not return its attachment ID; older attachments were kept.", local_path: localPath, target_issue_key: targetIssueKey }, null, 2);

  const attachmentCleanupErrors: any[] = [];
  const generatedPrefix = `brd_${businessVisionKey}_`.toLowerCase();

  for (const existing of existingAttachments) {
    const oldFilename = (existing.filename || "").toString();
    const oldId = (existing.id || "").toString();
    const isGeneratedBrd = oldFilename.toLowerCase() === safeName.toLowerCase() || (oldFilename.toLowerCase().startsWith(generatedPrefix) && oldFilename.toLowerCase().endsWith(".md"));

    if (oldId && oldId !== uploadedAttachmentId && isGeneratedBrd) {
      const deleteResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/attachment/${oldId}`, { method: "DELETE", headers: getJiraHeaders() });
      if (!deleteResponse.ok) attachmentCleanupErrors.push({ attachment_id: oldId, filename: oldFilename, error: `Delete failed: ${deleteResponse.status} ${await deleteResponse.text()}` });
    }
  }

  const auditComment = comment.trim() || `BRD generated from Business Vision ${businessVisionKey} and attached to this Epic as ${safeName}.`;
  const comments = targetFields.comment?.comments || [];
  const commentAlreadyPresent = comments.some((item: any) => extractAdfText(item.body).trim() === auditComment);
  
  let commentPosted = false;
  let commentError = null;
  let commentStatus = commentAlreadyPresent ? 200 : null;

  if (!commentAlreadyPresent) {
    const commentResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${targetIssueKey}/comment`, {
      method: "POST",
      headers: getJiraHeaders(),
      body: JSON.stringify({
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: auditComment }] }] }
      })
    });
    commentPosted = commentResponse.ok;
    commentStatus = commentResponse.status;
    if (!commentPosted) commentError = await commentResponse.text();
  }

  const result: any = {
    source_issue_key: normalizedKey,
    business_vision_key: businessVisionKey,
    target_issue_key: targetIssueKey,
    local_path: localPath,
    attachment: { id: attachment.id, filename: attachment.filename || safeName, content_url: attachment.content },
    attachment_cleanup_errors: attachmentCleanupErrors,
    comment_posted: commentPosted,
    comment_already_present: commentAlreadyPresent,
  };
  if (commentError) result.comment_error = { status: commentStatus, details: commentError };
  
  return JSON.stringify(result, null, 2);
}
