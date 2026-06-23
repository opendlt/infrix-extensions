# Infrix Extensions

Editor and browser client surfaces for [Infrix](https://github.com/opendlt/infrix-accumen),
the governance-first execution fabric for Accumulate. Three independently-published
packages share this repo:

| Package | What it is | Distribution |
| --- | --- | --- |
| [`vscode-governance/`](vscode-governance) — **`infrix-governance`** | VS Code: **Infrix Governance Spine** — read-only inspection of intents, plans, approvals, and evidence over the `/v4` API | VS Code Marketplace (`vsce publish`, publisher `opendlt`) |
| [`vscode-contracts/`](vscode-contracts) — **`infrix-contracts`** | VS Code: **Infrix Smart Contracts** — contract dev (syntaxes, snippets, governed deploy/call intents, ABI) | VS Code Marketplace (`vsce publish`, publisher `opendlt`) |
| [`browser/`](browser) — **`infrix-extension`** | Browser MV3 **wallet** — keystore, approval queue, intent submission, evidence verification; embeds Cinema via [`@infrix/cinema-core`](https://github.com/opendlt/infrix-cinema-core) | Loaded unpacked / packed `.zip` |

## Develop

Each package is self-contained:

```bash
cd vscode-governance && npm install && npm run build && npm test
cd vscode-contracts  && npm install && npm run build && npm test
cd browser           && npm install && npm test     # requires @infrix/cinema-core
```

## Cinema

`browser/` does not fork the Cinema renderer — it consumes the canonical
**`@infrix/cinema-core`** package and keeps a byte-drift-fenced mirror
(`browser/scripts/sync-cinema-core.mjs` + `browser/tests/cinema_core_mirror.test.mjs`),
so there is exactly one Cinema implementation across Nexus, the SDK widget, and the
extension.

## Provenance

Extracted from the Infrix monorepo with full history preserved
(`git filter-repo`); each package's subtree is content-identical to its in-repo origin.
