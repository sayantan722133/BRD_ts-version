import * as dotenv from "dotenv";

dotenv.config();

export const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");

export function getJiraHeaders(): Record<string, string> {
  if (!JIRA_BASE_URL) throw new Error("Missing JIRA_BASE_URL in environment.");

  const email = process.env.JIRA_USER_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!email || !apiToken) {
    throw new Error("Missing JIRA_USER_EMAIL or JIRA_API_TOKEN in environment.");
  }

  const token = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export function getAttachmentHeaders(): Record<string, string> {
  const headers = getJiraHeaders();
  delete headers["Content-Type"];
  headers["X-Atlassian-Token"] = "no-check";
  return headers;
}

export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("\n");

  const chunks = node.type === "text" ? [node.text || ""] : [];
  if (Array.isArray(node.content)) chunks.push(...node.content.map(adfToText));
  return chunks.filter(Boolean).join(" ");
}
