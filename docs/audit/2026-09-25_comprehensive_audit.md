# NoteForge comprehensive audit — 2026-09-25

Companion: [NoteForge 2 roadmap and phased plan](../roadmap/NOTEFORGE_2_ROADMAP.md).

Audited: `DaveHomeAssist/noteforge` `main` @ `1630342` (PR #6 merged 2026-09-25), the live canonical route `https://systembydave.com/noteforge/`, the mirror `https://davehomeassist.github.io/noteforge/`, the System by Dave release scripts, and the Notion hub `SFT | NoteForge`. Method: fresh checkout gates run locally (Node 25.8.1), live bundle-hash comparison, browser walkthrough at 1440 / 375 / 2560 px in both themes, and four specialist reviews (architecture, visual/UX, competitive parity, quality engineering) whose full reports are the appendices.

## 1. Executive summary

NoteForge 1.0 is a finished, well-engineered, single-user local-first notes app. The 20-feature daily-driver program is shipped and green. It is not yet a product that could displace Notion, ClickUp, or Confluence for anyone, and the reasons are structural rather than cosmetic.

1. **The data and recovery layer is the asset.** Storage, migrations, revision history, backups, and link integrity are the best-tested code in the repo (~700 Node assertions) and encode contracts the incumbents do not offer: lossless Markdown, whole-vault offline, rename-safe links, transclusion with diagnostics, revision-gated destructive actions.
2. **The editor and the views are the liability.** The raw-when-focused block canvas (`block-editor.js`, 1,822 lines) cannot express inline formatting, nested blocks, typed tables, comments, or collaboration; every view is an `innerHTML` template with manual wiring (106 sites). These must be replaced, not extended.
3. **The record model is load-bearing in the wrong place.** Markdown strings are the authority for both blocks and properties, block IDs are regenerated on every parse, and the whole vault is one IndexedDB key rewritten on every save. Databases, relations, rollups, per-block comments, multi-vault, and sync each require a schema v7 record model with Markdown kept as a lossless projection.
4. **The visual layer is an engineering tool, not a design.** Color is tokenized; nothing else is. 58 emoji and Unicode glyphs act as icons, there is no spacing or type scale, sidebar rows are 72 px cards, and 14 features live in modals behind a 17-item overflow menu. The app violates house rules WEB-1 (defaults to system theme), WEB-2 (no navigation rail, no mobile bottom rail), and WEB-3 (a 760 px column wastes ~78 % of a 32:9 screen).
5. **The number-one competitive gap is database views.** Table, board, list, gallery, timeline, filters, groups, relations, rollups, and formulas are absent. Sync is the second. Everything else is secondary.
6. **Release safety is weaker than the documentation claims.** The canonical site is 8 commits and 36 days behind the mirror, two of those commits change runtime semantics, there is no version string to tell the surfaces apart, `main` has no branch protection (a red PR was merged), Dependabot is disabled, and there is no lint, format, or type gate.
7. **Verdict: strangler-fig rewrite behind the existing data layer**, with a planned schema re-platform. Not evolve-in-place (items 2 and 3 are structural). Not greenfield (item 1 is worth keeping).

## 2. Verified state (2026-09-25, all times ET)

| Surface | State | Evidence |
|---|---|---|
| Repo `main` | `1630342`, clean, 37 commits since 2026-07-02 | `git log`, `git status` |
| CI (Deploy NoteForge run #39) | Success on `1630342` | `gh run list` |
| Node gate (`npm test`) | 425 checks, 0 failures | local run, this session |
| Browser gate (`npm run test:browser`) | 394 component assertions + 120 integrated + 10 production/offline, all pass, zero unexpected errors | local run, this session |
| Build + budget | 257,109 B initial shell, 71 B under the 257,180 B ceiling | `npm run build && npm run test:budget` |
| `npm audit --audit-level=moderate` | 0 vulnerabilities | local |
| Mirror (GitHub Pages) | Serves `index-DZIoNl3p.js` (matches local build of `main`) | `curl` |
| Canonical (systembydave.com) | Serves `index-C9X9iXpA.js`; provenance `sourceCommit=becbffa` (2026-08-20) | `curl`, `source_provenance.json` |
| Drift | 8 commits on `main` not deployed canonically; `7af4239` (alias authority) and `9110926` (folder-export mapping) change runtime behavior | `git log becbffa..main --stat` |
| Branch protection / rulesets | None | `gh api …/branches/main/protection` → 404 |
| Dependabot | Disabled | `gh api …/dependabot/alerts` → 403 |
| Lint / format / types | None configured | repo root listing |
| Local Node | 25.8.1 (checklist mandates 22) | `node --version` |
| Outdated deps | dompurify 3.4.14→3.4.16, marked 15→18, vite 6→8, playwright 1.61→1.63, yaml 2.9.0→2.9.1 | `npm outdated` |
| Notion hub `SFT \| NoteForge` | Status Done, Health Green, "No corrective work remains" (reconciled earlier today) | fetch |
| Notion `RUN-20260925-0955` | 🟡 partial; canonical record stale (now reconciled) | fetch |
| Merged-but-live branches | 12 remote branches all merged into `main`; no tags, no releases, no CHANGELOG; `version` 1.0.0 | `git branch -a`, `gh api` |

The Notion hub's "Green, shipped and verified" predates this audit and does not account for the canonical/mirror drift.

## 3. Capabilities (what ships today)

Grouped from the README, acceptance matrix, and live walkthrough. All items are verified by the green gates above.

**Editor.** Block editor with paragraph, H1–H3 (H4–H6 parse to outline but are raw blocks in the editor), bullet, numbered, to-do, quote, code, divider, date, image, callout, editable table, toggle; slash menu; Markdown shortcuts; block multi-select; undo/redo; drag reorder; raw-when-focused rendering; DOMPurify-sanitized output; strict production CSP.

**Knowledge graph.** `[[wikilinks]]` with alias and heading/block fragments; rename-safe atomic rewrite with preview and safety revisions; canonical-title-first resolution; contextual backlinks with snippets; unlinked mentions with previewed conversion; force-directed graph (keyboard-navigable, SVG export); stable `^block-ids`; `[[Note#^id]]` navigation; `![[Note#^id]]` read-only transclusion with cycle/depth/missing diagnostics; H1–H6 outline.

**Organization and retrieval.** Nested notes (parent/child tree, collapse, drag-to-nest); tags; pin; sort; fuzzy ranked scoped search (`tag:`, `in:title`, `has:banner`, `is:pinned`, `is:archived`, `prop:`); saved views; Archive; Trash; command palette (notes, commands, headings); back/forward and 50 persisted recents; tabs (20) and two-pane split with single-writer ownership; find/replace (note and vault-wide, previewed, revision-protected); ID-based bulk actions (tag, archive, reparent, export, trash).

**Daily workflow.** Idempotent local-date Daily note; Quick Capture (text, URL, clipboard, image) with PWA GET share target; `@due()` tasks with a grouped dashboard; month/week calendar with mobile agenda; three templates.

**Properties.** Lossless YAML frontmatter with text, number, boolean, ISO date, safe URL, select, multi-select; typed editor with raw fallback; `aliases` as frontmatter authority; property search filters.

**Durability and recovery.** IndexedDB (`my-notes-app`) with localStorage fallback; schema v6 migration runner with randomized 1,000-note fidelity tests; content-addressed SHA-256 revisions (50 per note, 90 days), compare/restore/restore-as-copy with pre-restore safety captures; rolling daily/weekly local snapshots; verified JSON backup envelope with preview and atomic full-vault restore; storage health and quota reporting.

**Interop.** Obsidian-compatible `.md` folder export (File System Access) and manual folder reconciliation (Add/Update/Conflict/Unchanged plan, per-item decisions, backup and revision gates, no inferred deletes); web clipper bookmarklet; self-contained HTML note export; Markdown export; graph SVG export; JSON export/import.

**Platform.** Installable PWA with offline service worker and versioned precache; light/dark/system theme; settings (font, width, autosave, default template); off-canvas mobile sidebar; focus-trapped inert modals; reduced-motion, forced-colors, and increased-contrast rules; 390 px and 200 %-equivalent layouts tested.

**Engineering.** Clean `app → components → core → utils` layering with zero import cycles; three runtime dependencies; ~90 s CI; SHA-pinned actions; per-artifact provenance hashes on the canonical deploy.

## 4. Shortcomings

### 4.1 Release and process (highest urgency)

| Finding | Severity | Evidence |
|---|---|---|
| Canonical site 8 commits / 36 days stale; two runtime-affecting commits undeployed; no version marker in HTML | High | Appendix C.0, C.4 |
| No branch protection; PR #4 merged red; main red for 71 minutes | High | C.0 |
| Two-repo sync is manual; `verify:noteforge` checks self-consistency only, never upstream | High | C.4 |
| Dependabot disabled; no lint, format, or type gates | Med | C.0, C.3 |
| Release checklist mandates Node 22 while local is 25; unenforceable locally | Med | C.3 |
| Test totals hand-tallied; browser runner reports failures via `document.title` with a 60 s timeout and no artifacts; hard-coded dates already broke CI once | Med | C.1 |
| 12 merged branches never deleted; no tags, releases, CHANGELOG, or semver | Low | C.5 |

### 4.2 Architecture (blocks the ambition)

| Finding | Severity | Evidence |
|---|---|---|
| Markdown string is the authoritative record for blocks and properties | Critical | A.4 |
| Block IDs regenerate on every parse; only 6 of 12 types can carry a stable `^id` | Critical | A.3 |
| Whole vault serialized under one IndexedDB key on every save | High | A.4 |
| Raw-when-focused contenteditable cannot host inline marks, nesting, typed tables, comments, or CRDT | Critical | A.3 |
| `main.js` (1,292 lines) is an orchestrator with 30 lazy imports and an idle-time editor duck-swap that other controllers must be patched to follow | High | A.1 |
| 106 `innerHTML` templates with manual event wiring; no component model, lifecycle, or diffing | High | A.2 |
| State split across five owners; module-level singletons act as implicit render parameters | Med | A.2 |
| Aliases dual-stored with a 285-line reconciler | Med | A.4 |
| 0 `@typedef`, no type checking; 23 dead exports; duplicated helpers | Low | A.5 |
| 71 bytes of bundle headroom; no framework or editor core fits without a new budget policy | High | A.7 |

### 4.3 Visual design and UX (the "stunning" gap)

| Finding | Severity | Evidence |
|---|---|---|
| WEB-1: default theme is system, not light; light flash before theme applies; toggle not in the mobile bar; no `color-scheme` | Med | D.2 |
| WEB-2: no navigation rail; subject areas are modals, not tabs; no mobile bottom rail | Med | D.8 |
| WEB-3: fixed 320 px sidebar and a 760 px centered column; ~78 % of a 32:9 viewport empty; zero `min-width` queries | High | D.3 |
| Title centered while body is left-pinned above 1100 px; page shifts ~81 px after idle | Med | D.3 |
| No spacing, type, elevation, motion, or z-index scales; 884 raw `px`; 36 font sizes; 0 of 280 padding/gap declarations use a token | High | D.1 |
| 58 emoji/Unicode glyphs as icons | High | D.4 |
| Contrast failures: dark accent 2.90:1, dark danger 2.77:1 (used on the storage-failure alert), field borders 1.2–1.7:1 | High | D.2 |
| Sidebar rows 72 px with a permanent checkbox; hierarchy hidden; tag cloud unbounded | Med | D.4, D.8 |
| 14 dialogs with 8 footer variants and 16 field stylings; 18 native `alert()`/`confirm()` calls | Med | D.4, D.6 |
| No empty-state CTAs, skeletons, or `:active` states; menus and modals appear without motion | Low | D.4, D.6 |
| Mobile: three stacked toolbars plus a 250 px banner before the title; block gutter invisible on touch | Med | D.3, live screenshot |
| Graph: static, no zoom/pan, active node colored with `--danger` | Low | D.4 |

### 4.4 Accessibility defects (fix now, independent of the rewrite)

- `.sr-only` is used in six places and defined nowhere, so screen-reader text is visible and each announcement grows the page below the 100vh shell (`index.html:109`, `bulk-actions-view.js:11,13`, `saved-searches-view.js:16,152`).
- Forced-colors rules target `.note-item--active`, which does not exist; the real class is `.note-item--on`; no `aria-current` on the active note.
- Title input has no label; pin and delete buttons announce as "pushpin" and "wastebasket".
- Slash menu has no ARIA; note list has no tree semantics and up to five tab stops per row; several targets under 24 px; no skip link.

### 4.5 Competitive gaps (ranked by switching cost)

| # | Gap | Severity |
|---|---|---|
| 1 | Database views (table, board, list, gallery, timeline) with filters, sorts, groups | Critical |
| 2 | Multi-device sync | Critical |
| 3 | Relations, rollups, formulas | High |
| 4 | Native desktop/mobile with a file-system vault | High |
| 5 | Importers (Notion ZIP, Confluence HTML, CSV) | High |
| 6 | Editor richness (inline marks, columns, embeds, math, Mermaid) | Med |
| 7 | Task depth (custom status, priority, recurring, reminders) | High |
| 8 | Share and publish to a URL | Med |
| 9 | AI Q&A over the vault | High |
| 10 | Automations, buttons, API | High |
| 11 | Dashboards and charts | High |
| 12 | Comments and mentions | Low (solo) / High (team) |

Full matrix: Appendix B.1. Where NoteForge is already ahead: Appendix B.2.

## 5. Keep, replace, or add

| Layer | Decision | Reason |
|---|---|---|
| `storage.js`, `database.js` write queue, `migrations.js`, `revision-store.js`, `backup.js`, `recovery-service.js` | Keep; extend with per-note keys and schema v7 | Best-tested, encodes hard-won durability lessons, clean async KV contract |
| DOM-free utils (`wikilinks`, `headings`, `search-query`, `tree`, `fuzzy`, `link-analysis`, `frontmatter-boundary`, `local-date`, `tasks`, `calendar`) | Keep as-is | Pure, unit-tested, independent of the block model |
| Node test tier (425 checks) and fixtures | Keep; move to a runner | Regression floor for the rewrite |
| Color tokens | Keep; extend into a three-tier token system | ~95 % of color already tokenized |
| `blocks.js` model, `block-editor.js`, `editor.js` | Replace (schema-based editor on a record model) | Cannot express marks, nesting, typed cells, comments, CRDT |
| All `innerHTML` views and phase controllers | Replace domain by domain behind `Database` | No component model; phase-named accretion |
| Browser test tiers (`features.html`, `run-features.mjs`) | Rebuild per new component | Coupled to class names and `window.app` internals |
| Canonical deploy process | Replace with automated exact-SHA sync + drift check | Manual trigger is the root cause of drift |
| Bundle budget policy | Replace with per-route gzip budgets | Single byte ceiling has 71 B headroom |
| Icon system, type scale, spacing scale, motion, primitives, navigation rail, context panel, ultrawide layout, views, collections, sync | Add | Absent today |

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Users on the canonical URL run different alias/reconciliation semantics than the mirror | Certain (now) | Med | Automate sync; add build meta tag; re-sync this week |
| 2 | Rewrite silently changes Markdown output for existing vaults | Med | Critical | Golden-corpus snapshots before any editor work; round-trip gate stays |
| 3 | Editor core adoption blows the bundle budget and offline precache | Certain | Med | Per-route budgets; lazy editor chunk; drop `marked` when the schema editor lands |
| 4 | Schema v7 migration corrupts a real vault | Low | Critical | Existing randomized 1,000-note fidelity test; revision-protected migration path; portable backup prompt before v7 |
| 5 | A red PR merges again during the rewrite | High | Med | Branch protection with required `verify` |
| 6 | Browser tests discarded without replacement coverage | High | High | Side-by-side suites with count floors until parity |
| 7 | Design work lands without tokens and repeats the ad hoc pattern | Med | High | Tokens and primitives ship first (Phase 1 gate) |
| 8 | Sync bet consumes the program | Med | High | Phase 8 is optional and last; folder sync first |
| 9 | Hand-rolled formula/automation engines become security holes | Med | High | Sandboxed expression language; no `eval`; CSP stays strict |
| 10 | Single maintainer bandwidth | High | High | Agent lanes per phase; releasable vertical slices |

## 7. Recommendation

Adopt the roadmap in `docs/roadmap/NOTEFORGE_2_ROADMAP.md`. Start with Phase 0 this week: it closes the release-safety findings (drift, branch protection, Node pin, Dependabot, tooling, golden corpus, budget policy) in two to three weeks and makes every later phase safe. Phase 1 (design system and shell) delivers the visible transformation without touching storage. Phase 2 (record model) and Phase 3 (collections and views) close the number-one competitive gap before the editor core is replaced in Phase 4.

Quick fixes that should not wait for any phase: define `.sr-only`, fix the forced-colors selector and add `aria-current`, label the title/pin/delete controls, default the theme to light and apply it before first paint, bump dompurify, and re-sync the canonical deploy.

---

# Appendices — specialist reports

## Appendix A — Architecture and code quality audit (specialist report)

Target: `1630342` (main). Read-only inspection.

### A.0 Snapshot

| Metric | Value |
|---|---|
| Source | 87 JS files / 16,524 lines; 17 CSS files / 1,565 lines |
| Classes / private methods | 44 classes, 338 `#private` methods |
| Runtime deps | 3 (`marked`, `dompurify`, `yaml`); dev: `vite`, `playwright` |
| Git | 37 commits, 2026-07-02 → 2026-09-25, single author; `main.js` touched in 13 of 37 |
| Lint / format / types | None: no ESLint, Prettier, EditorConfig, Biome, tsconfig/jsconfig, `@ts-check` |
| Initial shell | 257,109 B vs 257,180 B ceiling (71 bytes headroom, `test/bundle-budget.mjs:12`) |

### A.1 Module map and dependency graph

Layering is real and clean. Static imports flow strictly `app → components → core → utils/ui`. A cycle/violation scan found 0 static import cycles and 0 upward violations. Highest fan-in: `src/utils/helpers.js` (37 importers), `src/components/modal.js` (14), `src/core/note.js` (9). Highest fan-out: `src/app/main.js` (10 static + 30 dynamic `import()` sites).

The god modules are orchestration and editor, not domain:

| File | Lines | Fns | Avg / median / max fn length |
|---|---|---|---|
| `src/components/block-editor.js` | 1,822 | 95 | 16.7 / 12 / 73 (`#chooseMenu` :1423) |
| `src/app/main.js` | 1,292 | 87 | 13.3 / 7 / 88 (constructor :17, 42× `getElementById`) |
| `src/core/revision-store.js` | 1,186 | 69 | 12.7 / 6 / 95 (`captureNow` :648) |
| `src/core/database.js` | 874 | 62 | 11.6 / 8 / 75 (`replaceVault` :302) |
| `src/utils/blocks.js` | 372 | 9 | 34.1 / 17 / 191 (`parse` :93-283) |

Function lengths are disciplined; the files are long because they hold many small methods (only `blocks.js:parse` exceeds 100 lines).

Phase wiring is accretion, not architecture. `main.js` owns 20+ memoized `#ensureX()` loaders (`main.js:428-693`) plus `#ensurePhase4/5/6` (`:701-792`), each scheduled via `requestIdleCallback` after `db.init()` (`:72-77`). `Phase4Controller` (`src/app/phase4.js:19`) bundles daily notes + capture + tasks + calendar; `Phase5Controller` (`phase5.js:46`) bundles frontmatter properties + alias migration + transclusion + block-link enhancer; `Phase6Controller` (`phase6.js:4`) bundles workspace tabs + clipper + reconciliation. These are named after delivery rounds, not domains. The most fragile seam: Phase 6 duck-type-swaps the editor at idle time (`this.editor = workspace`, then patches `phase4.editor`, `phase5.editor`, `findReplace.editor` at `main.js:760-767`); `openNote` then branches on `this.phase6?.workspace` (`main.js:183-186`). Any new consumer of `this.editor` must be remembered in that patch list.

Sixteen `createXElements()` factories (`trash-view.js:9`, `properties-view.js:6`, etc.) each append a modal overlay to `document.body` via an `innerHTML` string. The "component" contract is `(els, db, callbacks)` with no shared base, lifecycle, or props.

### A.2 State management and rendering

There is no single store. State is split across five owners:

1. `Database` (`database.js:39`): `notes: Map`, `config: {}` bag (`:47`), `listeners: Set` (`:48`). `#emit(noteIds)` (`:77`) fires 7 subscribers; the `main.js:150-157` subscriber re-renders the whole note list and calls `editor.refresh()` on every emit.
2. `db.config` is an untyped flat bag holding UI prefs, `workspace`, `collapsed`, `recentNoteIds`, and migration markers (`migrations.js:58-68`).
3. `App` fields: `currentId`, `view`, `navigation` (`main.js:19-22`).
4. Per-view local state: `NoteList` (query, activeTag, collapsed, selection), `WorkspaceView.state` (`workspace-view.js:41`), `BlockEditor` (focusedId, selectedIds, undo stacks :117-140).
5. Module-level singletons: `modal.js:11-13`, `markdown.js:20-22` (`knownTitles`, `renderContexts`, `transclusionRenderer`) as implicit parameters that must be set before each render (`block-editor.js:330,441,459`).

Rendering is innerHTML-string templating with manual event wiring. `innerHTML` appears 106 times across 25 files; `createElement` 35; `textContent` 117. `Editor.#render` (`editor.js:162-229`, 99 lines) rebuilds the entire editor pane as one template literal on every open/refresh, then `#wire()` (`:284-352`) re-attaches 8 listener groups. `NoteList.#paintWindow` (`note-list.js:221-247`) does hand-rolled windowing. No diffing; correctness depends on guards like `editor.refresh()` bailing while `blockEditor.isEditing()` (`editor.js:96`).

XSS posture is good. `escapeHtml` is called 109 times; all 8 `innerHTML` interpolations lacking an escape on the same line are static or pre-escaped. All markdown passes `marked → DOMPurify` (`markdown.js:110`) with `ADD_TAGS: details/summary/aside` and `ADD_ATTR` including `contenteditable`, `role`, `aria-label` (`:90-95`), a slightly widened surface worth re-reviewing. Production CSP is `script-src 'self'` but `style-src 'unsafe-inline'` and `img-src data: https:` (`vite.config.js:26-35`).

### A.3 Block editor internals

Model: `blocks.js` is the only code that reads/writes `note.content` (`:1-3`). A block is a flat `{ id, type, text, meta }` (`:5`); `id` is a fresh `uid()` on every `parse()` (`:20`), so block identity is ephemeral unless the user assigns a `^blockId` suffix, supported for only 6 of 12 types (`:17`). Types: paragraph, heading (levels 1–3 only; 4–6 become `raw` :214-223), bullet, numbered, todo, quote, code, divider, date, image, table, raw. Toggle = a `raw` block holding literal `<details>` HTML (`:145-168`); callout = a `quote` whose text starts `[!kind]` (`:43-59`). Nesting is `meta.indent` only.

Editing: one `contenteditable` row per block (`block-editor.js:351-385`). On `focusin` the row is swapped to raw markdown (`#enterRaw` :674), on `focusout` it commits and re-renders via `renderInline` (:420-466). Caret position across the swap is approximated when inline syntax differs from rendered length (`:786-796`). Undo is whole-document block-array snapshots, coalesced at 500 ms, capped at 100 (`:1771-1789`).

Structural limits for the target product:

| Capability | Status | Extend or replace? |
|---|---|---|
| Inline WYSIWYG marks | Impossible in this model; focused block is a single flat text node by design | Replace editing layer |
| Nested blocks (columns, toggles with children, synced blocks) | No tree; toggles are opaque HTML strings | Replace `blocks.js` model + serializer |
| Tables-as-data / databases | `table` is `meta.rows: string[][]` (`blocks.js:184`), no typed cells | Replace |
| Real-time collab / CRDT | Whole-document snapshots, ephemeral ids, markdown-string authority, whole-vault rewrite on save | Replace model; keep transport-agnostic storage |
| Comments anchored to ranges | Only heading anchors and `^blockId` on 6 types | Replace |

Reusable from this layer: `wikilinks.js`, `headings.js`, `frontmatter-boundary.js`, `search-query.js`, `tree.js`, `fuzzy.js`, `link-analysis.js`, all DOM-free and unit-tested.

### A.4 Data model and storage

Note (`note.js:58-96`): `id, title, content, tags[], banner, createdAt, updatedAt, deletedAt, pinned, parentId, aliases[], archivedAt` plus `_extra` passthrough (`:72-77`). Links/backlinks are derived, never stored.

Markdown is the authority for properties. Typed properties live inside `content` as YAML frontmatter (`frontmatter.js`), lazily parsed with `yaml` (104,706 B chunk). Aliases are dual-stored (metadata + frontmatter) and reconciled by `canonicalAliasesFor` (`phase5.js:35-44`); a 285-line controller exists solely to keep two sources of truth agreeing.

Storage (`storage.js`): IndexedDB `my-notes-app` v1 with a single `kv` object store (`:16-19`), localStorage fallback, lazy legacy migration, Web Locks with a lease fallback (`:186-210`, `:459-470`). The entire vault is one JSON array under the key `notes`; every `saveNote` calls `#persist()` which serializes all notes (`database.js:127-134`) through a coalescing write queue (`:137-215`). Revision history and snapshots share the same KV store under `revision:` prefixes, content-addressed by SHA-256.

Migrations (`migrations.js:13`): `CURRENT_SCHEMA_VERSION = 6`; v1–v5 are additive field defaults; v6 is a marker for a deferred, revision-protected content rewrite.

Load-bearing vs incidental decisions:

| Decision | Load-bearing? | Impact on ambition |
|---|---|---|
| Storage as opaque async KV with batch/lock/status contract | Incidental (good abstraction) | Keep; a sync layer can sit beside it |
| Whole vault under one key | Load-bearing | Blocks per-block writes, partial sync, >~10k notes |
| Markdown string = truth for blocks and properties | Load-bearing | Blocks typed DBs, relations, rollups, CRDT |
| Ephemeral block ids | Load-bearing | Blocks comments, sync, synced blocks |
| Flat `db.config` bag | Incidental | Needs typing for multi-workspace |
| `parentId` tree, soft-delete, archive, aliases | Incidental | Carry forward as-is |
| Migration runner + backup format + revision store | Incidental (well-built) | Carry forward; add v7+ |

Multiple workspaces, typed databases/views, relations/rollups, per-block ids, permissions, and CRDT sync each require a new authoritative record model (blocks as rows, properties as typed columns). Schema v7 is a re-platform of the payload, not a field addition.

### A.5 Cross-cutting quality

- Error handling: 95 `try` / 105 `catch`; 24 param-less `catch {}` each with an intent comment; failures surface via `onPersistError`/`onHistoryError` hooks (`database.js:62-65`) to a visible banner (`main.js:361-397`). Consistent and deliberate.
- Console: 31 calls, all `warn`/`error` with `[module]` prefixes. No logging abstraction.
- TODO/FIXME/HACK/XXX: 0.
- Dead code: 23 of 252 exports (9%) never referenced by any src or test file (e.g. `markdown.js:deriveTitle`, `revision-store.js:createRestorePayload`, `workspace.js:locateWorkspaceNote`).
- Duplicated helpers: `el()` in `block-editor.js:61`, `banner.js:20`, `block-editor-phase5.js:3`; `todayISO` in `templates.js:5` and `block-editor.js:67`; `formatDateTime` in `backup-view.js:11` and `history-view.js:59`; identical image-allowlist regex in `note.js:13` and `block-editor.js:21`.
- Types: 189 JSDoc blocks, 40 `@param`, 15 `@returns`, 0 `@typedef`, no type-checking.
- CSS: 23 custom properties, 231 `var()` uses, but 365 `px` literals vs 1 `rem`, 2 media queries, 7 transitions, 1 keyframe, and 66 emoji-as-icons in JS + 14 in HTML (`index.html:42-71`). `styles.css` is a 1,131-line monolith with 16 side-effect-imported component sheets.

### A.6 Testing architecture

Three tiers, all bespoke:

1. Node unit tests: 11 files, ~918 assertions. 8 use `node:test`; three use hand-rolled `ok()` counters. Chained with `&&` in `package.json` (no runner, no parallelism, no coverage).
2. `test/features.html` (2,337 lines): a single ES-module page with 377 `check()` calls in 91 sections, driving real components against synthetic DOM events; results published via `document.title` (`:2333-2334`).
3. `test/run-features.mjs` (1,919 lines): boots Vite + Playwright, runs 8 monolithic smoke functions with 167 `page.evaluate`, 281 `window.app` accesses, 91 `waitForFunction`, 66 `#id` selectors, then builds production and tests SW offline.

Untested modules: `main.js` (only indirectly via `window.app`), `pwa.js`, `theme.js`, `download.js`.

Under a UI rewrite: tier 1 survives intact. Tiers 2 and 3 (4,256 lines) are coupled to CSS class names, element ids, and `window.app` internals and would be discarded, taking most editor-behavior coverage with them.

### A.7 Build and deploy

`vite.config.js` is small and sensible: dual CSP via `transformIndexHtml` (`:65-82`), hand-rolled HTML minifier (`:84-101`), SW cache-busting by hashing asset names (`:46-63`), `modulePreload.polyfill: false` to keep `script-src 'self'` (`:125`). `public/sw.js` precaches every hashed chunk.

The budget is the constraint. Entry chunk is 226,182 B and includes `marked` (71,905 B source) + `DOMPurify` (129,175 B source). With 71 bytes of headroom, no framework or editor core can be added without renegotiating `docs/implementation/performance_budgets.md`. Rough minified costs: Preact ~4 KB, Solid ~7 KB, Lit ~6 KB, Svelte ~2 KB runtime, React+DOM ~45 KB; ProseMirror core ~90 KB, TipTap ~120 KB+, Lexical ~35 KB, BlockNote ~200 KB+. Dropping `marked` for a schema-native editor would recover budget.

### A.8 Top 10 technical debts for a rewrite

1. Markdown string is the authoritative record (`blocks.js:1-3`, `frontmatter.js`). Remediation: introduce a block/property record model (schema v7), keep markdown as a lossless projection.
2. Ephemeral block ids (`blocks.js:20`). Remediation: persist ids for every block in the record model.
3. Whole-vault-under-one-key persistence (`database.js:127-134`). Remediation: per-note (later per-block) KV keys plus an index key.
4. Raw-when-focused contenteditable editor (`block-editor.js:674-815`). Remediation: adopt a schema-based editor (ProseMirror/TipTap/Lexical).
5. `main.js` as 1,292-line orchestrator with 30 lazy imports and the editor duck-swap (`:760-767`). Remediation: a small app shell + typed service registry; controllers by domain.
6. innerHTML-template views with manual wiring (106 sites). Remediation: replace wholesale with a component model; do not port.
7. Dual-stored aliases + 285-line reconciler (`phase5.js`). Remediation: single source of truth in the property model.
8. DOM-coupled test tiers (4,256 lines). Remediation: keep Node tier; rebuild browser tests as component tests with page objects and a real runner.
9. Zero tooling and 0 `@typedef`s. Remediation: TypeScript (or `@ts-check` + typedefs), lint, format before the rewrite starts.
10. 71-byte bundle headroom + `unsafe-inline` styles + emoji icons. Remediation: re-baseline budgets; adopt an icon set and design tokens with a `rem` scale.

### A.9 Verdict: strangler-fig rewrite behind the existing data layer, with a planned schema re-platform

Not "evolve in place": items 1–4 are structural. `blocks.js` + `block-editor.js` + `editor.js` (2,598 lines) and every view's rendering approach must be replaced to reach inline WYSIWYG, nested blocks, databases, comments, or collab.

Not "greenfield": the persistence/durability stack (`storage.js` 503, `database.js` 874, `migrations.js` 93, `revision-store.js` 1,186, `backup.js` 395, `recovery-service.js` 224) is the best-engineered, best-tested code in the repo (~700 Node assertions target it), encodes hard-won lessons (coalesced drains, refusal of stale fallbacks, lease-based locks, portable digested backups), and has a clean async KV contract a sync layer can wrap. The DOM-free utils are likewise reusable as-is.

The strangler plan: (a) add tooling and typedefs now; (b) define the v7 record model (per-block ids, typed properties, per-note keys) as a migration using the existing `runMigrations` + revision-protected commit path (`database.js:770-803`), with markdown retained as a lossless projection; (c) stand up the new shell + editor core beside the old one behind `Database`; (d) retire views one domain at a time, deleting the phase controllers as their features move; (e) rebuild browser tests per new component, keeping the Node tier as the regression floor.

## Appendix B — Competitive feature-parity gap analysis (specialist report, September 2026)

Basis: NoteForge facts from `README.md`, `ROADMAP.md`, and `docs/implementation/feature_acceptance_matrix.md`. Competitor facts checked against vendor release notes and help docs this session (links at the end). Unconfirmed items are marked "verify". Severity is rated for the realistic switcher (an individual or 2–5 person knowledge worker coming from Notion or Obsidian), not a 500-seat Confluence buyer.

Legend: Y = shipped, P = partial, N = absent, n/a = not applicable to a local-first single-user product.

### B.1 Capability matrix

#### (a) Editor and content blocks

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Block editor, slash menu, drag handles | Y | Y | Y | Y | None | Hand-rolled; raw-when-focused model |
| Inline WYSIWYG marks | Y | Y | Y | N | Med | Deliberate; ROADMAP names ProseMirror as the fork |
| Headings H1–H6 | Y | Y | Y | P | Low | Outline is H1–H6 but the editor only types H1–H3 (H4–H6 become raw) |
| Lists, to-do, quote, code, divider | Y | Y | Y | Y | None | |
| Callout, toggle, editable table | Y | Y | Y | Y | None | All round-trip to Markdown |
| Image (drop/paste/upload) | Y | Y | Y | Y | None | Downscaled data URL, src allowlisted |
| Columns / layouts | Y | Y | Y | N | Med | |
| Embeds (video, PDF, bookmark, Loom, Figma) | Y | Y | Y | N | Med | |
| Math / Mermaid / diagrams | Y | P | Y | N | Low | |
| Synced blocks | Y | N | Y | P | Low | Transclusion is read-only |
| Block links + transclusion with diagnostics | P | N | P | Y | Ahead | Cycle/depth/missing diagnostics |
| Tabs block, presentation mode | Y | N | Y | N | Low | |
| Interactive HTML blocks / buttons | Y | Y | Y | N | Low | Would violate CSP posture; skip |
| Date chip block | Y | Y | Y | Y | None | |
| Block multi-select, undo/redo | Y | Y | Y | Y | None | |
| Find/replace (note + vault, previewed) | P | P | P | Y | Ahead | |

#### (b) Structure and organization

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Multiple workspaces / spaces | Y | Y | Y | N | Med | Single IndexedDB vault |
| Page hierarchy | Y | Y | Y | Y | None | |
| Breadcrumbs | Y | Y | Y | N | Low | Cheap to add |
| Per-page icon | Y | Y | Y | N | Low | Covers shipped; icons not |
| Covers / banners | Y | N | Y | Y | None | |
| Tags / labels | Y | Y | Y | Y | None | |
| Archive separate from Trash | Y | Y | Y | Y | None | |
| Trash + restore | Y | Y | Y | Y | None | |
| Sidebar with custom sections | Y | Y | Y | P | Low | Tree + saved views only |
| Tabs + split panes | Y | Y | N | Y | Ahead of Confluence | |
| Back/forward/recents | Y | Y | Y | Y | None | |

#### (c) Databases and views

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Typed properties on a page | Y | Y | Y | Y | None | YAML frontmatter |
| Table view over pages | Y | Y | Y | N | Critical | Only sidebar list + `prop:` filter |
| Board (kanban) | Y | Y | Y | N | Critical | |
| List / gallery | Y | Y | Y | N | High | |
| Calendar view | Y | Y | Y | P | Low | Daily, `@date`, `@due` only |
| Timeline / Gantt | Y | Y | N | N | Med | |
| Dashboards / charts | Y | Y | P | N | High | |
| Filters / sorts / groups | Y | Y | Y | P | High | No grouping, no typed filters |
| Relations | Y | Y | Y | P | High | Wikilinks are untyped |
| Rollups | Y | Y | P | N | High | |
| Formulas | Y | Y | N | N | Med | |
| Sub-items / dependencies | Y | Y | N | P | Med | Hierarchy only |
| AI autofill of properties | Y | Y | Y | N | Low | |
| Forms | Y | Y | N | N | Med | |

#### (d) Project and task management

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Tasks with due dates + dashboard | Y | Y | P | Y | None | |
| Custom statuses | Y | Y | P | N | High | Only done/undone |
| Priority | Y | Y | N | N | Med | |
| Assignees | Y | Y | Y | n/a | n/a | |
| Recurring tasks | Y | Y | N | N | High | |
| Reminders / notifications | Y | Y | N | N | Med | PWA Notification API possible |
| Sprints, points, burndown | P | Y | N | N | Low | |
| Time tracking | N | Y | N | N | Low | |
| Goals / OKRs | P | Y | N | N | Low | |
| Personal planner / time blocking | Y | Y | N | P | Med | |

#### (e) Knowledge management

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Wikilinks + backlinks | Y | P | P | Y | Ahead | Contextual, alias-aware, rename-safe |
| Unlinked mentions | N | N | N | Y | Ahead | |
| Graph view | N | N | N | Y | Ahead | |
| Page ownership + verification / status | Y | N | Y | N | Med | |
| Templates | Y | Y | Y | P | Med | 3 built-in; none user-defined |
| Search: fuzzy, scoped, ranked | Y | Y | Y | Y | None | |
| Semantic / Q&A search | Y | Y | Y | N | High | |
| Daily notes | N | N | N | Y | Ahead | |
| Revision history | Y | Y | Y | Y | Ahead (local) | Browser-local, not portable |
| Outline / TOC | Y | Y | Y | Y | None | |

#### (f) Collaboration

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Real-time multi-editor | Y | Y | Y | N | High (needs backend) | |
| Comments | Y | Y | Y | N | High (team) / Low (solo) | |
| @mentions of people | Y | Y | Y | n/a | n/a | |
| Sharing links, guests, permissions | Y | Y | Y | N | High | HTML export only |
| Publish to web | Y | P | Y | P | Med | No hosted URL |

#### (g) AI

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap |
|---|---|---|---|---|---|
| Writing assist / summarize | Y | Y | Y | N | Med |
| Q&A over workspace | Y | Y | Y | N | High |
| Autonomous agents, triggers, schedules | Y | Y | Y | N | Med |
| Meeting notes / transcription | Y | Y | Y | N | Low |
| Model choice / BYO key | Y | Y | N | N | Low |
| MCP exposure of workspace | Y | P | Y | N | Med |

#### (h) Integrations and automation

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Public API | Y | Y | Y | N | High | No process to host |
| Webhooks | Y | Y | Y | N | Med | |
| Automations / rules / buttons | Y | Y | Y | N | High | |
| Slack / GitHub / Jira connectors | Y | Y | Y | N | Low (solo) | |
| Forms intake | Y | Y | N | P | Med | GET share params only |
| Web clipper | Y | Y | N | Y | Low | |
| Import (Notion/Evernote/MD/CSV) | Y | Y | Y | P | High | No Notion ZIP or CSV importer |
| Export | Y | Y | Y | Y | Ahead | Lossless, Obsidian-compatible |
| Calendar sync | Y | Y | N | N | Med | |

#### (i) Platform

| Capability | Notion | ClickUp | Confluence | NoteForge | Gap | Notes |
|---|---|---|---|---|---|---|
| Native desktop apps | Y | Y | N | N (PWA) | Med | |
| Native mobile apps | Y | Y | Y | N (PWA) | Med | |
| Offline read | P | P | N | Y | Ahead | Whole vault |
| Offline full write | P | P | N | Y | Ahead | |
| Multi-device sync | Y | Y | Y | N | Critical | Excluded from current program |
| File-system vault | N | N | N | P | High | Export + manual reconcile, Chromium |
| Account required | Y | Y | Y | N | Ahead | |
| Encryption at rest | Y | Y | Y | Browser only | Med | IndexedDB eviction risk |
| Telemetry | Y | Y | Y | None | Ahead | Strict CSP |

### B.2 Where NoteForge is already ahead

1. Whole-vault offline read/write with no opt-in. Notion's 2026 offline needs per-page marking and truncates databases to 50 rows; ClickUp only queues new tasks; Atlassian has stated it will not build an offline client.
2. Markdown as the sole authority, proven lossless on 1,000-note fixtures. Notion's Markdown export is lossy; Confluence exports XHTML; ClickUp Docs are not round-trippable.
3. Link integrity as a first-class contract: previewed rename, pre-change revisions, atomic rewrite, old title kept as alias, ambiguity reported. Unlinked mentions exist in none of the three.
4. Block references and transclusion with diagnostics.
5. Revision safety layered above the note: content-addressed revisions, pre-restore captures, restore-as-copy, verified backups, every destructive path gated behind a revision.
6. Zero account, backend, telemetry, or plan-gating.
7. Vault-wide previewed find/replace and stale-plan-safe bulk actions.
8. Daily notes, tasks, and calendar derived from source syntax, so they are rebuildable indexes rather than a second data model.
9. Testing posture with 425 Node checks + 394 browser assertions gating every push.

Caveats: revision history is browser-local; folder save is Chromium-only and one-way; one browser profile is one device; IndexedDB can be evicted.

### B.3 The 12 most consequential gaps

| # | Gap | Minimum viable for local-first single-user | Only sensible with a sync backend |
|---|---|---|---|
| 1 | Database views over notes (table/board/gallery/list with filter/sort/group) | Views as fenced blocks or view-notes over frontmatter; inline cell editing; board by any select prop; embeddable in any note. The derived index already exists. | Per-viewer permissions, row-level access |
| 2 | Multi-device sync | Two-way folder sync via File System Access on a user-owned synced folder, building on the reconciliation planner; conflicts keep both copies; optional git push/pull. | Real-time CRDT, presence, server-side conflicts |
| 3 | Relations, rollups, formulas | Relation = typed frontmatter property whose values are wikilinks; rollup = derived aggregate; formulas = sandboxed expression language. | None |
| 4 | Native desktop/mobile with a real file vault | Tauri wrapper over a folder of `.md`; PWA stays the web tier. | Cross-device push |
| 5 | Import from Notion / Confluence / Evernote | Notion ZIP importer (Markdown + CSV → frontmatter, relation columns → wikilinks); Confluence HTML importer. | API-based live import |
| 6 | Editor richness: inline marks, columns, embeds, math, Mermaid | Columns via a container convention; bookmark/embed blocks from URL; KaTeX and Mermaid lazy. Inline marks are the ProseMirror decision. | None |
| 7 | Task depth: status, priority, recurring, reminders | `@status()`, `@priority()`, `@repeat()` markers mirroring `@due()`; PWA notifications. | Cross-device reminders, assignees |
| 8 | Share / publish | "Export site" static folder for user hosting. | Hosted links, guests, expiring links |
| 9 | AI Q&A over the vault | Opt-in only: local embeddings + in-browser model, or Ollama on localhost; BYO key stored locally. | Autonomous agents, connectors |
| 10 | Automations, buttons, API | Local rules engine on save events; button block; protocol handler; CLI over the exported folder. | Webhooks, inbound HTTP API |
| 11 | Dashboards / charts | Chart block bound to a saved view. | Cross-user rollups |
| 12 | Comments / mentions | Block-anchored margin notes; lowest solo value. | Threads, resolution, notifications |

Honorable mentions: user-defined templates from any note; per-note icons and breadcrumbs; page status/verified-until; multiple vaults.

### B.4 What "organizationally superior" can concretely mean

1. One object, many lenses. A note is simultaneously a page, a database row, a task, and a calendar item because all four derive from the same `.md` + frontmatter. "Convert page to row" becomes a non-operation.
2. Graph, hierarchy, and properties are one index. `parent:` is a relation; a typed relation is a wikilink; the tree, backlink panel, graph, and relation column are four renderings of one edge set.
3. Views are notes. A view definition lives in Markdown, so it is linkable, transcludable, versioned, exportable, and diffable.
4. Schema on demand with drift reporting. Frontmatter across notes implies the schema; a Structure Health panel reports untyped notes, mismatched types, dangling links, duplicate block IDs, orphaned children.
5. Time as a first-class axis. "View as of <date>" renders any table/board from revisions at a past time; "what changed this week" across the vault.
6. Installable vault kits: PARA, Zettelkasten, GTD, Meeting-OS as one importable file with notes, views, templates, saved searches, and a lint profile.
7. Source vs derived is always visible, with a rebuild button on every index.
8. Progressive disclosure by intent: plain text first, structure when you ask for it.

### B.5 What "visually stunning" means in 2026 for this category

Reference bars: Linear (calm 2026 refresh, unequal visual weight), Raycast (bold single accent, palette-as-UI), Craft (typography-led canvas), Things 3 and Obsidian Minimal (quiet neutrals, semantic color only), Capacities/Tana/Anytype (object chips, tinted property pills), Arc (playful onboarding).

1. Typography-first canvas: a deliberate UI/body pair, optical sizing, tabular numerals in property columns, 65–75ch measure, a density switch.
2. Dark-first, both modes designed: elevation by tint, true-black option, light mode composed rather than inverted.
3. One accent, semantic everything else.
4. Command palette as the visual spine: large type, grouped results, kbd hints, instant preview.
5. Motion as feedback only: 120–200 ms eased transitions, spring-damped drag, reduced-motion honored.
6. Affordances that disappear: hover-only handles, ghost placeholders, chrome that recedes in focus mode.
7. Consistent micro-iconography: one 16/20 px stroke set, per-note icon plus cover.
8. Beautiful structure rendering: graph clustered by type, typographic calendar, board cards with covers.
9. Empty states and onboarding as product: a sample vault that demonstrates links, views, and daily notes in 60 seconds.
10. Platform-native feel in the PWA: safe-area insets, sheet-style mobile outline, window-controls overlay.

### B.6 Sources

Notion: releases 3.3 (2026-02-24), 3.4 (2026-03-26, 2026-04-14), 3.5 (2026-05-13), 3.6 (2026-07-01), 3.7 (2026-09-15), 2.46 (2024-10-24); help pages for working offline, wikis and verified pages, sub-items and dependencies, relations and rollups, public pages; TechCrunch on Notion Mail shutdown (2026-06-25); `makenotion/notion-mcp-server`.
ClickUp: ClickUp 4.0 blog; help center articles on Super Agents, Offline Mode, Sprint management, Goals/OKRs, Integrations/API/MCP; Dashboards feature page.
Confluence: What's new; Atlassian Intelligence features; Rovo MCP GA announcement; page status docs; database fields docs; Confluence Databases Spring 2026 feature drop; live docs; CONFCLOUD-68406 (offline stance); Smart Links article.
Design references: Linear design refresh; Obsidian Bases syntax; Obsidian Things theme; Capacities comparison pages; Craft 2026 updates.

## Appendix C — Quality engineering and release process audit (specialist report)

Scope: `noteforge` @ `1630342` (main) and `system-by-dave` @ `7e6c870` (main). Read-only.

### C.0 Headline findings

| # | Finding | Evidence |
|---|---|---|
| 1 | Canonical deploy is 8 commits / 36 days stale, and two of those commits change runtime behavior. | `git log becbffa..main` → 8 commits; provenance `sourceCommit=becbffa…`; live canonical serves `index-C9X9iXpA.js`, mirror serves `index-DZIoNl3p.js`; SW caches `noteforge-4e57dfce17bc` vs `noteforge-5366919116ce`. |
| 2 | No branch protection, no rulesets, no required checks. A red PR (#4) was merged and main went red for 71 minutes. | `gh api …/branches/main/protection` → 404 "Branch not protected"; `rulesets` → `[]`; run `34451536644` (PR #4) failed → merged → run `34453865562` (main) failed → fixed forward by PR #5. |
| 3 | The "425 Node checks" figure is hand-tallied; 8 of 11 Node scripts print nothing on success unless you read TAP. CI never asserts a total. | `phase3..7`, `revision`, `recovery`, `link-integrity` use `node:test` run as plain `node file.mjs` (package.json:13). Latest CI: 262 + 141 + 24 hand-rolled + 112 `node:test` cases. |
| 4 | Dependabot is disabled; no lint/format/typecheck config exists anywhere in the repo. | `gh api …/dependabot/alerts` → 403 "disabled"; `security_and_analysis.dependabot_security_updates.status: disabled`. |
| 5 | The two-repo sync is entirely manual and no automation notices drift. | `system-by-dave/.github/workflows/deploy-pages.yml:99-100` only runs `verify:noteforge` (hash self-consistency), never compares to upstream `main`. |

### C.1 Test inventory

Node (`npm test`, package.json:13): 11 scripts chained with `&&`, so the first failing file aborts the rest; no parallelism; no aggregate count.

| File | Lines | Style | Checks (CI run 36148600504) | Covers |
|---|---|---|---|---|
| `test/roundtrip.test.mjs` | 600 | hand-rolled `ok()` counters | 262 | blocks parse/serialize fixed points, migrations v3→current, fuzzy, search-query, settings, tree, export, JSON merge import |
| `test/database-durability.test.mjs` | 387 | TAP-ish, throws on first failure | 141 | IndexedDB/localStorage fallback, stale-fallback precedence, failed-save handling |
| `test/backup.test.mjs` | 273 | own counters | 24 | backup envelope, hash verify, restore preview |
| `test/revision.test.mjs` | 744 | `node:test` | 28 tests (131 asserts) | revision store, SHA-256 dedup, retention/GC, quota |
| `test/recovery.test.mjs` | 258 | `node:test` | 7 tests (51) | recovery service, snapshot reload |
| `test/link-integrity.test.mjs` | 386 | `node:test` | 12 tests (83) | rename plans, unlinked mentions, 150 ms perf assertion |
| `test/phase3.test.mjs` | 218 | `node:test` | 10 tests (54) | archive migration, bulk ops, find/replace |
| `test/phase4.test.mjs` | 251 | `node:test` | 14 tests (63) | daily notes, capture, tasks, calendar dates |
| `test/phase5.test.mjs` | 250 | `node:test` | 10 tests (72) | frontmatter/YAML, aliases authority |
| `test/phase6.test.mjs` | 421 | `node:test` | 23 tests (103) | workspace state, reconciliation, vault-import |
| `test/phase7.test.mjs` | 280 | `node:test` | 8 tests (52) | incremental index perf, CSP string regex |

Three reporting idioms in one suite. `node:test` files are never run under `node --test`, so there is no reporter selection, concurrency, name filtering, watch mode, or JUnit output.

Browser (`npm run test:browser` → `test/run-features.mjs`, 1,919 lines): boots Vite in-process, launches Playwright Chromium, loads `test/features.html` twice (warm-up then authoritative pass), runs eight hand-written smoke functions, then builds production and runs an offline smoke against `vite preview`. `test/features.html` (2,340 lines) is a single module with 377 `check()` calls; CI reports 394 results.

Failure detection: the page writes `ALL PASS (N)` or `FAILURES: k of N` to `document.title` (line 2331-2334); the runner waits up to 60 s for that title. Brittleness:

1. If the module throws before line 2334 (a bad import path after a refactor), the title never changes and the runner reports a bare timeout with zero per-assertion output.
2. A `section()` that throws collapses its whole group into one FAIL line, so N silently shrinks; nothing asserts `N >= 394` in code.
3. The eight smokes are sequential and stateful; the first exception aborts the rest. No retry policy. Runs `32362979090` and `32365379338` failed this way in August and were "fixed" by adding more settling waits in test code.
4. Date time-bomb: the Phase 7 smoke hard-coded `@due(2026-08-21)` and failed once the month rolled over (PR #5). `new Date(`/`Date.now(` appears in 7 test files (28 sites) without clock injection.
5. 13 fixed sleeps (10 in `features.html`, 3 in the runner).
6. No trace/video/screenshot on failure.

Budget gate: `test/bundle-budget.mjs` fails above `257_180` bytes. Deterministic, but headroom is 71 bytes; any rewrite hits it on day one.

Runtime: whole `verify` job ≈ 90 s in CI. Fast, which is a real asset.

### C.2 Coverage shape

Never referenced by any test file (5): `src/app/main.js` (1,292 lines), `src/app/pwa.js`, `src/ui/theme.js`, `src/utils/download.js`, `src/utils/frontmatter-boundary.js`. Loaded but not asserted: `src/app/phase6.js`, `src/core/knowledge-index.js`. Only exercised through the browser page: all 26 `src/components/*`, `markdown.js`, `image.js`, `transclusion.js`, `storage.js` (Node hits it only via `Database`).

User journeys with no end-to-end proof: first-run seed → edit → reload on real IndexedDB; JSON backup download → fresh profile → restore; folder export → re-import on a real directory handle; PWA update (v1→v2 SW transition; the offline smoke proves fresh install only); theme switching; graph interactions; mobile 390 px beyond the offline smoke; keyboard-only traversal of the shell; anything in Safari/Firefox/WebKit.

### C.3 CI pipeline critique

Good: all actions SHA-pinned; `permissions: contents: read` with `pages: write`/`id-token: write` scoped to deploy; `npm audit --audit-level=high` and the budget are hard gates; PRs run verify without deploy; ~90 s wall time.

Missing or weak: no branch protection (CI is advisory; PR #4 merged red); `concurrency.cancel-in-progress` keyed on `github.ref` lets a second push to main cancel an in-flight main deploy; no PR preview deploy; no lint, formatter, typecheck, or `git diff --check`; no Playwright artifacts on failure; no retry/quarantine policy; no Lighthouse, axe, or visual regression; Dependabot disabled; no `CODEOWNERS`, `SECURITY.md`, `.nvmrc`; `engines.node: ">=22"` accepts local v25.8.1; no test-count floor; no JUnit output.

### C.4 Release process critique

Model: NoteForge CI deploys `dist/` to the mirror automatically. The canonical site is a committed copy of `dist/` inside system-by-dave, produced by `scripts/sync_noteforge_release.js`, checked by `scripts/verify_noteforge_release.js`, following an 8-section, ~60-command manual checklist.

What the scripts do well: `sync` refuses unless the source `HEAD` equals `--source-commit` and is clean; refuses to overwrite files it does not own; rejects symlinks; stages atomically; injects breadcrumb/skip-link/nav and records SHA-256 of every artifact. `verify` checks provenance schema, hashes, canonical link, CSP, nav markup, manifest paths, and content-derived SW cache name. SW versioning is sound (`CACHE = 'noteforge-<12hex>'`, prunes only `noteforge-*`).

Why drift happened anyway:

1. `verify:noteforge` proves internal consistency only; nothing compares `sourceCommit` to `noteforge@main`.
2. The trigger is a human reading a checklist. PRs #4/#5/#6 were merged by agents whose scope ended at "green on NoteForge main".
3. The checklist mandates Node 22 (NoteForge) and Node 24 (system-by-dave) while local is 25.8.1, so the honest path is blocked and the "just merge" path is open.
4. The canonical `index.html` was re-hashed by a system-by-dave-side patch (`8c2abe2`, 08-26) without a NoteForge release, so the artifact already diverged once.
5. Every automated signal says "fine" while the live site is a month behind.

Is the drift user-visible? Of the 8 commits, `9110926` (folder-export mapping for reconciliation identity) and `7af4239` (frontmatter aliases as the single alias authority) change runtime behavior. Canonical users have different alias-resolution and reconciliation semantics than mirror users, with no version string anywhere (`package.json` is `1.0.0`; `index.html` carries no build id).

Other failure modes: the same user can install the PWA from both origins and get divergent semantics; committing ~1.5 MB of hashed bundles per release bloats system-by-dave history; `injectSystemByDaveNavigation` regex-patches minified HTML and will break on a shell rewrite with no NoteForge-side test.

Recommendation, in order:

- Option A (least change, do first): a `noteforge-sync.yml` workflow in system-by-dave triggered by `repository_dispatch` from NoteForge's deploy job. It checks out NoteForge at the exact SHA, builds under Node 22, runs the existing `sync` + `verify`, and opens or auto-merges a PR. Add a nightly job that fails if `source_provenance.sourceCommit != noteforge@main`. Emit `<meta name="noteforge-build" content="<sha>">` so live drift is inspectable with one `curl`.
- Option B (cleaner long-term): stop committing `dist/`. NoteForge CI uploads `dist/` as a release asset on a `vX.Y.Z` tag; system-by-dave's Pages workflow downloads that exact tag, injects nav, verifies, and stages it.
- Option C (`git subtree`): not recommended.

### C.5 Git hygiene

12 remote branches, all merged into `main`; `delete_branch_on_merge: false`. Commit subjects: 14 no-prefix imperative, 10 `feat:`, 3 `ci:`, 2 `test:`, 2 `docs:`, one each `fix:`/`deploy:`/`chore(ci):`, 3 merges; Conventional Commits abandoned after Aug 20. 6 PRs, all merge commits, one merged red. No tags, no releases, no CHANGELOG. `version` is `1.0.0` despite 6 schema versions and 7 feature phases. Root clutter: `date_project_implementation_plan.txt` (36 KB).

### C.6 Dependency posture

| Package | Current → Latest | Risk | Order |
|---|---|---|---|
| dompurify | 3.4.14 → 3.4.16 | Sanitizer; patch-level | 1st, immediately |
| playwright | 1.61.1 → 1.63.0 | Dev-only; Chromium bump may shift smoke timing | 2nd |
| yaml | 2.9.0 → 2.9.1 | Pinned exactly; patch | 3rd |
| marked | 15 → 18 | Three majors; renderer/tokenizer API changes surface in `markdown.js` and the 262 round-trip fixed points | 4th, behind a golden corpus |
| vite | 6 → 8 | Two majors; `transformIndexHtml` and `closeBundle` hooks used by three custom plugins | 5th, alone in its own PR |

`npm audit --audit-level=high` → 0 vulnerabilities. No `overrides`.

### C.7 Twelve pre-rewrite improvements (prioritized)

| # | Improvement | Effort | Why before the rewrite |
|---|---|---|---|
| 1 | Branch protection / ruleset on `main`: require `verify`, require PR, linear history, delete-on-merge | S | Makes every later item enforceable |
| 2 | Automate canonical sync (Option A) + nightly drift check; add build-SHA meta tag | M | The rewrite ships many builds; manual sync lags every one |
| 3 | `.nvmrc` = 22, engines-strict, Node 22 + 24 CI matrix | S | Local vs CI parity |
| 4 | Golden-corpus fixtures: freeze `renderMarkdown()` HTML and parse/serialize output for every seed note and the v3 fixtures | M | The only way to know the rewrite (and marked 18) preserves user data semantics |
| 5 | `node --test test/` with JUnit reporter uploaded to CI, and a test-count floor | S | One command, parallel, filterable, annotated failures |
| 6 | Playwright trace/screenshot upload; convert the eight smokes to `@playwright/test` specs with `retries: 1` and `trace: 'retain-on-failure'` | M | Today a failure is stdout archaeology |
| 7 | Clock injection (`page.clock` / injectable `now()`) | S | Eliminates the time-bomb class |
| 8 | ESLint flat config + Prettier (or Biome) in CI | S | Catches "import path moved, title never set" at lint time |
| 9 | `jsconfig.json` with `checkJs` + JSDoc types on `core/*` and `utils/*`, `tsc --noEmit` gate | M | Typed contract for the data layer the rewrite must not break |
| 10 | Enable Dependabot (grouped), bump dompurify now, land marked 18 behind the golden corpus | S/M | Sanitizer currency |
| 11 | Direct unit tests for `main.js` orchestration by extracting a testable `App` module | M | Largest untested file and the rewrite's primary target |
| 12 | Cut `v1.1.0` tag + CHANGELOG, adopt Conventional Commits + release-please | S | Named baseline to diff against and a rollback point |

### C.8 Target test pyramid for the rewrite

- Unit (Vitest, Node env): `core/*`, `utils/*`. The 262 `ok()` round-trip checks and 141 durability checks port mechanically; the 112 `node:test` cases port by swapping imports. Keep `test/fixtures/*` and add golden snapshots.
- Component (Vitest + Testing Library in happy-dom, or Playwright CT for anything touching `contenteditable`/Selection): split `features.html` into one spec per component. Caret/selection tests need real Chromium.
- E2E (`@playwright/test`): the eight smokes become eight spec files with a shared fixture that seeds `window.app`, waits on `app.ready`, and injects a fixed clock. Project matrix: Chromium desktop, Chromium 390×844, WebKit.
- Visual regression: `toHaveScreenshot` on ~15 canonical states at 0.2 % threshold, baselines in-repo.
- Accessibility: `@axe-core/playwright` on each overlay and the shell; fail on serious/critical.
- Perf: keep `bundle-budget.mjs` with a deliberately raised, recorded ceiling; add Lighthouse CI on `vite preview`; port the `< 150 ms` Node timing asserts into a bench project.
- Migration corpus: promote the v3 fixtures and a real exported vault into `test/corpus/`; every migration PR adds a `vN→vN+1` fixture pair.
- Preserving counts: run old and new suites side by side for one release; CI asserts `unit ≥ 425`, `component ≥ 394`, `e2e steps ≥ 120` until the old runner is deleted.

## Appendix D — Visual design, UX, and front-end audit (specialist report)

Source-only review of `index.html`, 17 CSS files (1,582 lines, 2,207 declarations), and the DOM-building JS. Layout geometry is derived from the CSS and was confirmed by live screenshots at 1440, 375, and 2560 px widths (see section 3 of the main audit).

Bottom line: the color token layer is solid and the accessibility plumbing is better than average. Everything else reads as an engineering tool: no type or spacing scale, 58 emoji/Unicode glyphs standing in for icons, a 72 px card list pretending to be a tree, and features hidden in modals and a 17-item overflow menu. WEB-1 is partial (default follows the OS, not light), WEB-2 is partial, WEB-3 fails.

### D.1 Design tokens

What exists (`src/styles.css:6-39`): 12 color tokens with light and dark values; 5 fixed tokens (`--radius` 10px, `--radius-sm` 6px, `--sidebar-w` 320px, `--mono`, `--sans`); 2 settings-driven tokens (`--editor-measure`, `--editor-font`); runtime variables (`--depth`, `--indent`, `--outline-level`, `--workspace-ratio`). One stale reference: `properties-view.css:14` uses `var(--font-mono)` but the token is `--mono`.

| Metric | Count |
|---|---|
| `var()` references | 472 |
| Raw `px` literals | 884 |
| Raw colors outside token blocks | 30, plus 20 hex in banner gradients (`banner.js:10-17`) |
| Padding declarations using a token | 0 of 166 (85 distinct values) |
| Gap declarations using a token | 0 of 114 (19 distinct values) |
| Font sizes | 36 distinct values in 118 declarations, mixing px, rem, em |
| Font weights | 500/600/650/700/750 (650 and 750 only differ on a variable font) |
| Radii | 14 distinct; 26 declarations bypass the tokens |
| z-index | 10 ad hoc values; slash menu and modal share z 60; banner picker (70) sits above modals |

Tokens that do not exist: spacing, type scale, line height, elevation (one shadow; modal hard-codes its own), motion, z-index layers, status colors, text-on-accent, focus ring. Status colors are hard-coded and unchanged in dark mode (`#10b981`, `#f59e0b`, `#a855f7` at `:727-730`; `#15803d` in `link-tools-view.css:10`; `#a16207` in `phase6.css:20`). Seven of 16 component CSS files are one-line minified-style source.

### D.2 Theming

`data-theme` on `<html>`; `Theme` resolves light/dark/system through `matchMedia` (`src/ui/theme.js:11-34`). The header button flips between explicit light and dark; "system" is only reachable in Settings.

WEB-1 compliance: default is `'system'` (`src/ui/settings.js:12`), not light. `index.html:2` hard-codes light but the theme applies only after async `db.init()` (`main.js:107,143`), so dark-OS users see a light flash. The toggle is an emoji; on mobile it is inside the drawer, not the top bar. `theme-color` is fixed. No `color-scheme` declaration, so native controls and scrollbars stay light in dark mode.

Contrast failures (computed WCAG ratios):

| Pair | Ratio | Where |
|---|---|---|
| Light accent `#3b6ef6` on white | 4.42 | links, wikilinks, date pills |
| White on light accent | 4.42 | `.btn--primary`, `.seg--on` |
| Accent on `accent-weak` | 3.78 | chips, active buttons |
| `text-muted` on `bg-sunken` | 4.23 | backlink snippets at 12.5 px |
| Dark: white on accent `#6b93ff` | 2.90 | "New", `seg--on`, calendar today |
| Dark: white on danger `#f87171` | 2.77 | trash badge, storage-failure alert |
| Field borders vs surface | 1.20–1.71 | every input (1.4.11 asks for 3:1) |

Forced-colors and increased-contrast: `accessibility-hardening.css` covers 6 components, loads late (after idle with phase6), and two rules target `.note-item--active`, which does not exist (the real class is `.note-item--on`, `note-list.js:267`). With no `aria-current` either, the active note is not indicated at all in forced-colors mode.

### D.3 Layout architecture

Shell: two-column grid `320px | 1fr` at 100vh with `overflow:hidden` (`styles.css:63-68`). Sidebar is fixed width, not resizable or collapsible on desktop. After idle, phase6 wraps `#editor` in a workspace that adds a 42 px toolbar and 39 px tab strip, shifting the page ~81 px after first paint.

Breakpoints: 19 `@media` blocks, 14 of them `max-width:760px`, one `max-width:1100px`, plus reduced-motion, contrast, and forced-colors. Zero `min-width` queries, zero container queries. `100vh` rather than `dvh`.

Alignment defect: `.editor__bar` and `.editor__tags` are centered with auto margins (`styles.css:1028`); `.editor__workspace` has a max-width but no auto margins (`outline-view.css:1-7`). Above 1100 px the title is centered while the body is pinned left; a 220 px outline column is reserved even with no headings; the body jumps when the outline CSS arrives at idle.

| Width | Behavior |
|---|---|
| 390 | 48 px top bar + 328 px drawer; workspace toolbar wraps; tabs add 39 px; ~155–205 px of chrome above the title; no bottom rail; block gutter only on hover, so touch never sees it |
| 768 | Sidebar takes 42 % of width, leaving a 356 px column; outline stacked above body |
| 1280 | Body 568 px beside a 220 px outline under a 760 px title bar |
| 1920 | Title centered at x≈348–1108; body at x=0–760; ~450 px dead space |
| 2560 | Title starts at x≈668, body at x=0; ~1,090 px empty |
| 5120×1440 | ~78 % of the editor area empty; split view limited to 2 panes; graph letterboxed |

### D.4 Component visual quality

Across components: 45 `:hover` rules, zero `:active` states, disabled = opacity .48, one global focus ring.

| Component | Idiom | Problems |
|---|---|---|
| Sidebar list | 72 px three-line cards as a tree; permanent 24 px select checkbox; hover ＋ and greyscale 📌 | Rows ~2.5× Notion's height; checkbox noise; 14 px/level indent after a 24 px checkbox hides hierarchy; hard-coupled `ROW_STRIDE=72` (`note-list.js:13`) |
| Editor chrome | Title is an `<input>` at 28 px (cannot wrap); text "Properties" beside emoji 📌 🗑; section headers 🔗 💬 | Mixed button idioms; no save-state indicator |
| Block handles | "+" and "⋮⋮" text glyphs on hover | Hover-only, `tabindex=-1`, ~18×20 px targets; handle overloaded as drag and "turn into" |
| Slash menu | 15 items, label + hint | No icons, grouping, or ARIA |
| Command palette | 640 px, emoji per row, ~33 commands | Flat list; no section headers or key chips |
| Modals | Shared shell, 14 dialogs | 8 footer implementations, 16 form-field stylings (4 backgrounds, 4 radii) |
| Tabs and panes | Browser-style 12 px tabs, ⇄ × glyphs, 9 px uppercase state label | No icons; plain text toolbar |
| Calendar | 94 px cells; 10.9 px pills prefixed □ ✓ D • | Tiny text; lives in a modal |
| Task dashboard | Two columns of cards; native selects | 0.7 rem meta; date input unthemed in dark |
| Graph | Static SVG, no zoom/pan; active node uses `--danger` red | Red signals danger; fixed viewBox |
| Banners | 210 px covers, 8 gradients | The strongest visual asset |
| Settings | 5 native selects | No sections or previews |
| Empty/loading | 48 px 📝 + text; "No notes yet — create one!" with no button; text "Loading…" | No calls to action, skeletons, or illustrations |

Iconography: 58 distinct non-ASCII glyphs act as icons (~27 color emoji, ~31 Unicode symbols including ⌕ U+2315 "telephone recorder" as a search icon). They render differently per OS and cannot take theme colors.

### D.5 Typography

System stack, no webfont (CSP `font-src 'self' data:` means any webfont must be self-hosted). Body 15 px/1.55; block line height 1.65. Block headings 24 / 20.3 / 17.3 px; preview uses a slightly different scale. Heading rows get no top margin (rows padded `1px 0`). 760 px measure at 15 px is ~90 characters.

| | NoteForge | Notion (approx.) | Confluence (approx.) |
|---|---|---|---|
| Body | 15 px / 1.65 | 16 px / 1.5 | 14 UI, 16 content |
| Page title | 28 px input | ~40 px, wraps | ~28–32 px |
| H1 / H2 / H3 | 24 / 20 / 17 | 30 / 24 / 20 | 24 / 20 / 16 |
| Space above headings | none | ~1–2 em | 8 px grid |
| Sidebar row | 72 px | ~28 px | ~32 px |

### D.6 Motion and interaction feedback

7 transition declarations (120/150/200 ms), 2 with easing, 0 keyframes. Modals, palette, dropdowns, and slash menu appear and disappear via `[hidden]`. Reduced motion is handled well (global kill switch, JS checks). Drag: notes can only nest, not reorder siblings; blocks show a 2 px insertion line, mouse only; no keyboard block move. Autosave is silent. 18 native `alert()`/`confirm()` calls (`main.js` ×11, `phase4` ×3, `trash-view` ×2, `phase6` ×1, `clipper` ×1).

### D.7 Accessibility posture

Strengths: shared `Modal` with inert background, focus trap, Esc, focus restore (`modal.js:15-36,128-142`); palette follows combobox/listbox/`aria-activedescendant`; workspace tabs use roving tabindex; keyboard splitter; calendar grid roving focus; to-dos as `role=checkbox`; 22 `aria-live` regions; off-canvas sidebar made inert.

Gaps: `.sr-only` used in 6 places but defined nowhere (`index.html:109`, `bulk-actions-view.js:11,13`, `saved-searches-view.js:16,152`), so screen-reader labels show on screen and each announcement adds a line below the 100vh shell; no skip link; note list has no tree semantics or roving tabindex (up to 5 tab stops per row) and no `aria-current`; slash menu has no ARIA; title input has no label; pin and delete buttons have no `aria-label` (screen readers announce "pushpin", "wastebasket"); several targets under 24 px.

### D.8 Navigation and organization

Sidebar: brand + 7 icon buttons → search → sort → saved views → unbounded tag cloud → bulk bar → note list (tree when idle, flat while searching) → count. "Pinned" is a sort order, not a section. Everything else is in a 17-item ungrouped overflow menu or 14 modals. Breadcrumbs and covers exist; there is no page icon field and no manual ordering.

Against Notion: no workspace/teamspace, Favorites, or Private sections; no page icons; no dense tree; sidebar not resizable; no Recent section; search results lose parent path. Against ClickUp: no Space > Folder > List hierarchy; no multiple views over one collection; Tasks and Calendar are modals. Against Confluence: no spaces; no page status; tags are the only labels.

WEB-2: pass on viewport-height shell and panel scrolling; fail on subject-area tabs, desktop navigation rail, and mobile bottom rail.

### D.9 The 15 highest-leverage changes (ranked)

| # | Change | Effort | Architecture change? |
|---|---|---|---|
| 1 | Token foundation: 4 px spacing, ~8-step type scale, radius/elevation/motion/z-index layers, status colors, `--on-accent`, `color-scheme`; fix accent and dark danger contrast | M | No |
| 2 | Quick fixes: define `.sr-only`; fix `.note-item--active`→`--on` and add `aria-current`; label title, pin, delete; skip link; load hardening CSS in the initial shell | S | No |
| 3 | WEB-1: default light, apply theme before first paint, toggle in mobile bar, per-theme `theme-color` | S | No |
| 4 | Editor canvas: one aligned centered column, outline in a right rail, wrapping ~40 px title, 16 px body, heading top margins | S–M | No |
| 5 | One SVG icon set (Lucide sprite, ~40 icons, `currentColor`) replacing the 58 glyphs | M | No |
| 6 | Sidebar redesign: ~30 px single-line tree rows, sections (Favorites / Recent / Views / Pages / Tags), resizable and collapsible, checkboxes only in selection mode, ARIA tree | M–L | Partial (`ROW_STRIDE`) |
| 7 | App shell with a navigation rail (desktop side, mobile bottom); Tasks, Calendar, Graph, Archive, Trash become panels or tabs | L | Yes (view routing) |
| 8 | Page icons in tree, tabs, breadcrumbs, palette, graph | M | Yes (note field + migration) |
| 9 | Ultrawide breakpoints (≥1440, ≥2400): context column, 3–4 panes, full-bleed graph with zoom/pan | L | Yes (pane model) |
| 10 | Primitives: one Field (not 16), one Dialog shell (not 8 footers), Button sizes with 32/44 px targets, Chip, EmptyState with CTA, Skeleton | M | No |
| 11 | Toast and confirm service replacing 18 native dialogs, with undo for trash | M | Minor |
| 12 | Block UX: gutter visible on touch, Alt+Shift+↑/↓ block moves, separate block action menu, slash menu with icons/groups/listbox | M | No |
| 13 | Motion: dialog/menu enter and exit (120–180 ms), drawer, list reorder | S–M | No |
| 14 | Group the overflow menu with separators, icons, shortcut hints, arrow keys | S | No |
| 15 | Organization model: manual sibling order, board/table views over saved views, page-status chip | L | Yes (order field; views over properties) |

### D.10 Verdict: restyle onto a new token and primitive layer; keep the DOM approach until the shell rewrite

Why not a React component library now: the DOM is vanilla template strings (~12k lines), the Playwright suite selects on existing class names, and the bundle budget has no headroom. Why the color work is not wasted: color is ~95 % tokenized, so semantic class hooks can stay.

Recommended approach: three-tier tokens (primitive → semantic → component) as CSS custom properties; `@layer reset, tokens, base, primitives, components, utilities` to control ordering across 17 lazily loaded sheets; plain CSS primitives (Button, Field, Dialog, Menu, Tabs, TreeItem, Chip, Toast); a self-hosted SVG sprite; Inter self-hosted as a subsetted variable woff2 (needs a budget exception or loads outside the initial shell); Zag.js state machines for tree, menu, and combobox (framework-agnostic; Ark UI reuses them if the owner later adopts Svelte/Solid/React). Avoid CSS-in-JS runtimes and a Tailwind migration. The real architecture work sits in items 7, 8, 9, and 15 (shell, view routing, data model), not in the CSS.
