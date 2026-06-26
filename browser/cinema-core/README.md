# `cinema-core/` — GENERATED MIRROR. Do not edit by hand.

Every file in this directory is a **byte-identical mirror** (LF-normalized) of the
canonical [`@infrix/cinema-core`](https://github.com/opendlt/infrix-cinema-core)
package. The extension ships a copy so the MV3 popup can load the classic
`<script>`s without a bundler, but there is **exactly one** Cinema
implementation — this is not a fork.

Editing files here directly will be overwritten on the next sync and will be
**rejected by CI** (the drift fence compares this directory against canonical).

## Which folder do I edit when working on Cinema?

> **Always edit the canonical repo: `infrix-cinema-core` (the `@infrix/cinema-core` package).**
> Then mirror the change here with `npm run vendor`. Never edit `browser/cinema-core/`.

- Cinema renderer / vocabulary / disclosure / narrative / proof, or any new
  module → edit **`infrix-cinema-core`**, test it there, then mirror.
- The extension's own surface (popup, background worker, approval flow, *how/where*
  it mounts Cinema) → edit `browser/` **outside** this directory.

## Steady-state ritual (every Cinema change)

1. Edit and test in **`infrix-cinema-core`** (the source of truth).
2. *(Release path, optional)* bump + publish `@infrix/cinema-core`, then bump the
   `@infrix/cinema-core` devDependency in `browser/package.json`.
3. In `browser/`, regenerate the mirror **and** the popup load order:
   ```bash
   npm run vendor
   ```
4. Verify nothing drifted:
   ```bash
   npm run vendor:check    # exits non-zero on any drift
   npm test                # includes the byte-identity + popup-order fence
   ```
5. Commit the regenerated `cinema-core/` **and** `popup/popup.html` together
   (plus the dependency bump if step 2 applied).

The local **pre-commit hook** (`npm run hooks:install` once per clone) runs
`vendor:check` automatically, and **CI** enforces it against canonical `HEAD`, so
a forgotten `npm run vendor` cannot land.

## How the mirror works

| Piece | Role |
| --- | --- |
| `scripts/cinema-mirror-manifest.mjs` | Single source of truth: what is mountable, where canonical is, the compare, the popup load-block generator. |
| `scripts/sync-cinema-core.mjs` (`npm run vendor`) | Copies every mountable canonical asset here (LF-normalized), prunes files canonical dropped, and regenerates the `popup.html` load block from canonical's `loader.js` order. `--dry-run` reports without writing. |
| `scripts/check-cinema-mirror.mjs` (`npm run vendor:check`) | Fails if this mirror or the `popup.html` load block has drifted. Used by the hook and CI. |
| `tests/cinema_core_mirror.test.mjs` | The drift fence in the test suite. |
| `.gitattributes` | Pins these assets to `eol=lf` so the mirror is platform-deterministic. |

**Mountable set** = every `.js`/`.css` in canonical **except** `loader.js` (the ESM
entry — the extension loads classic scripts directly) and `*.test.mjs`. The set is
derived dynamically, so a new canonical module is mirrored automatically and gets
a `<script>` tag in `popup.html` in canonical's `loader.js` order.

## Source resolution (local-first)

`vendor` / `vendor:check` find canonical in this order:

1. `INFRIX_CINEMA_CORE_SRC` env var (used by CI; a bad value fails loudly).
2. an installed `@infrix/cinema-core` package.
3. the sibling working copy `../../infrix-cinema-core` (the local layout).

If none resolve, `vendor` fails loudly and `vendor:check` skips with a notice
(it cannot verify a source it does not have).
