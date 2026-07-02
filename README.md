# Infrix Extensions

> **Infrix — governed, verifiable execution on Accumulate.** New here? Start at
> [infrix.opendlt.org](https://infrix.opendlt.org) · try it live at
> [play.infrix.opendlt.org](https://play.infrix.opendlt.org).

Editor and browser client surfaces for [Infrix](https://github.com/opendlt),
the governance-first execution fabric for Accumulate. Three independently-published
packages share this repo:

> **Looking to write a plugin / extend execution?** This repo is **editor +
> wallet clients**, not the plugin system. Execution plugin families and the
> supported extension seams (Verifier / Adapter / Agent / Confidential
> registries) live in **`infrix-core/pkg/executor`** — see
> `infrix-core/docs/plugins/AUTHORING.md` and `docs/plugins/catalog/`, and
> scaffold with `infrix plugin new`.

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
cd browser           && npm test     # resolves @infrix/cinema-core from the sibling repo or INFRIX_CINEMA_CORE_SRC
```

Install the git hook once per clone so the cinema-core mirror is verified before each commit:

```bash
npm run hooks:install    # from the repo root (sets core.hooksPath)
```

## Cinema

`browser/` does not fork the Cinema renderer — it consumes the canonical
**`@infrix/cinema-core`** package and keeps a byte-drift-fenced mirror in
`browser/cinema-core/`, so there is exactly one Cinema implementation across Nexus,
the SDK widget, and the extension.

**Working on Cinema?** Edit the canonical
[`infrix-cinema-core`](https://github.com/opendlt/infrix-cinema-core) repo — never
`browser/cinema-core/` (it is generated). Then mirror:

```bash
cd browser
npm run vendor         # regenerate cinema-core/ + popup.html load order from canonical
npm run vendor:check   # fails on any drift (also run by the pre-commit hook and CI)
```

The mirror is self-maintaining (every mountable canonical module is copied and
wired into `popup.html` in `loader.js` order, with deletions pruned), enforced by
`browser/tests/cinema_core_mirror.test.mjs`, the pre-commit hook, and CI. See
[`browser/cinema-core/README.md`](browser/cinema-core/README.md) for the full ritual.

## Provenance

Extracted from the Infrix monorepo with full history preserved
(`git filter-repo`); each package's subtree is content-identical to its in-repo origin.
