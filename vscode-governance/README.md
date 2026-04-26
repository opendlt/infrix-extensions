# Infrix Governance Spine — VS Code Extension

Inspect intents, plans, approvals, and evidence inside VS Code. Drives the canonical `/v4` governance API through the wallet's RPC proxy.

## Features

- **Governance sidebar** — recent intents grouped by status; expand to see plan steps with the §15.1 selector's chosen plugin + Reason + Confidentiality / Cost implications.
- **Plan view webview** — full plan rendering with per-step plugin selection details.
- **Evidence view webview** — chain hash + per-plugin contributions for any completed intent.
- **Wallet connect** — disclosure context (X-Actor / X-Purpose) injected on every governance read; the sidebar shows "Connect wallet to inspect governance" when the actor is unset.

## Build

```bash
cd vscode-extension
npm install
npm run build
```

`out/extension.js` is the compiled entry point.

## Run during development

```bash
# Inside VS Code:
F5  → "Run Extension" (launches a new VS Code window with this extension loaded)
```

## Configure

Workspace settings:

```jsonc
{
  "infrix.endpoint": "http://localhost:8080",
  "infrix.actor": "acc://alice.acme",
  "infrix.purpose": "audit"
}
```

The actor is required — every governance read injects it as `X-Actor` so the server-side disclosure gate admits the request. Without it the sidebar shows the disconnected state instead of 503'ing.

## Architecture

- `src/api-client.ts` — typed REST client for `/v4` endpoints; injects disclosure headers on every read.
- `src/governance-tree.ts` — `vscode.TreeDataProvider` listing recent intents and their plan steps.
- `src/webviews/plan-view.ts` — full-plan rendering (called from `infrix.viewPlan` command).
- `src/webviews/evidence-view.ts` — evidence bundle rendering (called from `infrix.viewEvidence` command).
- `src/extension.ts` — entry point; wires the tree, webviews, and commands.

The extension does not sign anything. Approval signing remains the canonical wallet's job (the browser extension at `extension/` or a CLI). The VS Code surface is read-mostly: it shows operators what's in flight, not what to sign.
