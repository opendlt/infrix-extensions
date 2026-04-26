// G-21 phase 5 — Evidence view webview.
//
// Renders an EvidenceBundle as a small HTML page with the
// chain hash and per-plugin contributions so approvers can
// inspect what was emitted.

import * as vscode from "vscode";
import { EvidenceBundleSummary } from "../api-client";

export function renderEvidenceWebview(
  context: vscode.ExtensionContext,
  bundle: EvidenceBundleSummary,
): void {
  const panel = vscode.window.createWebviewPanel(
    "infrix.evidenceView",
    `Evidence ${bundle.intentId}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = htmlForBundle(bundle);
  context.subscriptions.push(panel);
}

function htmlForBundle(bundle: EvidenceBundleSummary): string {
  const contributions = bundle.contributions
    .map(
      (c) => `<li><code>${escapeHtml(c.pluginId)}</code> — ${escapeHtml(c.kind)}</li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Evidence ${escapeHtml(bundle.intentId)}</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 1.5rem; }
    h1 { font-size: 1.25rem; }
    code { background: var(--vscode-textBlockQuote-background, #eee); padding: 0 0.25em; }
  </style>
</head>
<body>
  <h1>Evidence Bundle</h1>
  <p><strong>Intent:</strong> <code>${escapeHtml(bundle.intentId)}</code></p>
  <p><strong>Chain hash:</strong> <code>${escapeHtml(bundle.chainHash)}</code></p>
  <h2>Contributions</h2>
  <ul>${contributions}</ul>
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
