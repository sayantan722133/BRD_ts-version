import { JIRA_BASE_URL, getJiraHeaders } from "./customfun.js";

function adfParagraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function jiraLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").substring(0, 255);
}

export async function createBrdRequirementIssues(sourceIssueKey: string, requirementsJson: string): Promise<string> {
  const epicKey = sourceIssueKey.trim().toUpperCase();
  const requirements = JSON.parse(requirementsJson);

  if ((requirements.source_issue_key || "").trim().toUpperCase() !== epicKey) {
    throw new Error("source_issue_key must match the parsed model source issue key.");
  }
  const modules = requirements.modules;
  if (!Array.isArray(modules) || !modules.length) {
    throw new Error("The parsed requirements must contain at least one module.");
  }

  const epicResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${epicKey}?fields=project,issuetype`, { headers: getJiraHeaders() });
  if (!epicResponse.ok) return JSON.stringify({ error: `Business Vision lookup failed: ${epicResponse.status}`, details: await epicResponse.text() }, null, 2);

  const epicFields = (await epicResponse.json()).fields || {};
  if (epicFields.issuetype?.name?.toLowerCase() !== "epic") return JSON.stringify({ error: `${epicKey} is not a Jira Epic.` }, null, 2);
  const projectKey = epicFields.project?.key;

  const metadataResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { headers: getJiraHeaders() });
  if (!metadataResponse.ok) return JSON.stringify({ error: `Issue type lookup failed: ${metadataResponse.status}`, details: await metadataResponse.text() }, null, 2);
  
  const issueTypes = (await metadataResponse.json()).issueTypes || [];
  const ticketType = issueTypes.find((it: any) => it.name.toLowerCase() === "story" && !it.subtask) ||
                     issueTypes.find((it: any) => it.name.toLowerCase() === "task" && !it.subtask);
  
  if (!ticketType) return JSON.stringify({ error: `Project ${projectKey} has no Story or Task issue type that can be linked to an Epic.` }, null, 2);

  const results: any[] = [];
  const errors: any[] = [];

  for (const module of modules) {
    const moduleId = String(module.module_id || "").trim();
    const moduleName = String(module.name || "").trim();
    const features = module.features;
    if (!moduleId || !moduleName || !Array.isArray(features)) {
      errors.push({ module_id: moduleId, error: "Invalid module data." });
      continue;
    }

    const moduleLabel = jiraLabel(moduleId);
    for (const feature of features) {
      const requirementId = String(feature.requirement_id || "").trim().toUpperCase();
      const featureName = String(feature.name || "").trim();
      if (!requirementId || !featureName) {
        errors.push({ module_id: moduleId, error: "Feature is missing its ID or name." });
        continue;
      }

      const requirementLabel = jiraLabel(`brd-${requirementId}`);
      const acceptanceCriteria = feature.acceptance_criteria || [];
      const descriptionContent: any[] = [
        adfParagraph(`Business Vision: ${epicKey}`),
        adfParagraph(`Module: ${moduleName} (${moduleId})`),
        adfParagraph(`Requirement: ${requirementId}`),
        adfParagraph(`Priority: ${feature.priority || "Unspecified"}`),
        adfParagraph("Acceptance criteria:"),
      ];

      if (acceptanceCriteria.length) {
        descriptionContent.push({
          type: "bulletList",
          content: acceptanceCriteria.map((c: string) => ({ type: "listItem", content: [adfParagraph(String(c))] })),
        });
      }

      const summary = `[${requirementId}] ${featureName}`.substring(0, 255);
      const issueFields = {
        summary,
        description: { type: "doc", version: 1, content: descriptionContent },
        labels: ["brd-requirement", requirementLabel, moduleLabel],
      };

      const duplicateUrl = new URL(`${JIRA_BASE_URL}/rest/api/3/search/jql`);
      duplicateUrl.searchParams.append("jql", `parent = "${epicKey}" AND labels = "${requirementLabel}"`);
      duplicateUrl.searchParams.append("maxResults", "1");
      duplicateUrl.searchParams.append("fields", "summary");
      
      const duplicateResponse = await fetch(duplicateUrl.toString(), { headers: getJiraHeaders() });
      if (!duplicateResponse.ok) {
        errors.push({ requirement_id: requirementId, error: `Duplicate check failed: ${duplicateResponse.status}` });
        continue;
      }

      const existing = (await duplicateResponse.json()).issues || [];
      if (existing.length > 0) {
        const issueKey = existing[0].key;
        const updateResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}`, {
          method: "PUT",
          headers: getJiraHeaders(),
          body: JSON.stringify({ fields: issueFields }),
        });
        if (!updateResponse.ok) {
          errors.push({ requirement_id: requirementId, error: `Ticket update failed: ${updateResponse.status} ${await updateResponse.text()}` });
        } else {
          results.push({ requirement_id: requirementId, module_id: moduleId, issue_key: issueKey, summary, created: false, updated: true });
        }
        continue;
      }

      const createResponse = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
        method: "POST",
        headers: getJiraHeaders(),
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            parent: { key: epicKey },
            issuetype: { id: ticketType.id },
            ...issueFields,
          },
        }),
      });

      if (!createResponse.ok) {
        errors.push({ requirement_id: requirementId, error: `Ticket creation failed: ${createResponse.status} ${await createResponse.text()}` });
      } else {
        results.push({ requirement_id: requirementId, module_id: moduleId, issue_key: (await createResponse.json()).key, summary, created: true });
      }
    }
  }

  const requirementIssues = results
    .filter(r => r.issue_key && r.requirement_id)
    .sort((a, b) => {
      const idA = parseInt(String(a.requirement_id).split("-").pop() || "0", 10);
      const idB = parseInt(String(b.requirement_id).split("-").pop() || "0", 10);
      return idA - idB;
    });

  for (let i = 1; i < requirementIssues.length; i++) {
    const previous = requirementIssues[i - 1];
    const current = requirementIssues[i];
    const rankResponse = await fetch(`${JIRA_BASE_URL}/rest/agile/1.0/issue/rank`, {
      method: "PUT",
      headers: getJiraHeaders(),
      body: JSON.stringify({
        issues: [String(current.issue_key)],
        rankAfterIssue: String(previous.issue_key),
      })
    });
    if (!rankResponse.ok) errors.push({ requirement_id: current.requirement_id, error: `Requirement task ranking failed: ${rankResponse.status} ${await rankResponse.text()}` });
  }

  return JSON.stringify({ parent_issue_key: epicKey, issue_type: ticketType.name, tickets: results, errors }, null, 2);
}
