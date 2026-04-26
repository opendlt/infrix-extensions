// G-21 phase 5 — Plan view webview.
//
// Renders an ExecutionPlan's steps + plugin selections as a small
// HTML page. Each step shows the chosen plugin's Reason +
// Confidentiality / Cost implications so approvers can read the
// rationale at a glance.

import * as vscode from "vscode";
import { PlanSummary } from "../api-client";

export function renderPlanWebview(
  context: vscode.ExtensionContext,
  plan: PlanSummary,
): void {
  const panel = vscode.window.createWebviewPanel(
    "infrix.planView",
    `Plan ${plan.id}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = htmlForPlan(plan);
  context.subscriptions.push(panel);
}

function htmlForPlan(plan: PlanSummary): string {
  const steps = plan.steps
    .map((step) => {
      const sel = plan.pluginSelections[step.stageId] ?? {
        reason: "(no selection record)",
        pluginId: "(none)",
        fallbacks: [],
        confidentialityImplications: "",
        costImplications: "",
      };
      const fallbacks = sel.fallbacks?.length
        ? `<li><strong>fallbacks:</strong> ${escapeHtml(sel.fallbacks.join(", "))}</li>`
        : "";
      return `
        <article class="step">
          <h3>${escapeHtml(step.stepType)} <small>${escapeHtml(step.stageId)}</small></h3>
          <p>${escapeHtml(step.description)}</p>
          <ul>
            <li><strong>chosen plugin:</strong> ${escapeHtml(sel.pluginId)}</li>
            <li><strong>reason:</strong> ${escapeHtml(sel.reason)}</li>
            <li><strong>confidentiality:</strong> ${escapeHtml(sel.confidentialityImplications)}</li>
            <li><strong>cost:</strong> ${escapeHtml(sel.costImplications)}</li>
            ${fallbacks}
          </ul>
        </article>
      `;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Plan ${escapeHtml(plan.id)}</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 1.5rem; }
    h1 { font-size: 1.25rem; }
    h3 { font-size: 1rem; margin-top: 0; }
    h3 small { font-weight: normal; opacity: 0.7; margin-left: 0.5em; }
    article.step { border: 1px solid var(--vscode-editorWidget-border, #ccc); padding: 0.75rem 1rem; margin-bottom: 0.75rem; border-radius: 4px; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.2em 0; }
  </style>
</head>
<body>
  <h1>Plan ${escapeHtml(plan.id)}</h1>
  <p>Intent <code>${escapeHtml(plan.intentId)}</code> — ${plan.steps.length} step(s).</p>
  ${steps}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
