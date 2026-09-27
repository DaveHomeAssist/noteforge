# NoteForge 2 — roadmap and phased implementation plan

Status: proposed 2026-09-25. Companion audit: [`docs/audit/2026-09-25_comprehensive_audit.md`](../audit/2026-09-25_comprehensive_audit.md).
Owner: Dave Robertson. Supersedes the "Round" and "Daily-driver program" sections of `ROADMAP.md` for planning purposes; that file keeps the shipped history.

Scope: turn the shipped 20-feature local-first daily driver into a visually distinctive, organizationally superior alternative to Notion, ClickUp, and Confluence without giving up local-first ownership, Markdown portability, or the recovery guarantees that already exist.

## 1. Vision and positioning

NoteForge 2 is **Notion's block model + Obsidian's ownership + Linear's polish** in one local-first workspace. It competes on three things the incumbents do not do well together:

1. **One object model.** A page is a page. A collection is a page with a schema. A task is a page with a status. A view is a saved query. Blocks are addressable everywhere. "Convert page to database row" is a non-operation.
2. **Plain-text authority.** Every structure has a documented Markdown/YAML serialization (NoteForge Flavored Markdown, "NFM"). The runtime record model is richer than a string, but nothing is trapped in it: NFM is a lossless projection and the on-disk form in file-vault mode.
3. **A real design system.** Tokens, an icon set, a type scale, motion rules, and density modes applied to every surface, on every width from 390 px to 32:9, in both themes.

Differentiators none of the three do well (from the competitive analysis, Appendix B.4 of the audit), mapped to phases:

| Differentiator | Phase |
|---|---|
| One object, many lenses (page = row = task = calendar item) | 2, 3 |
| Graph, hierarchy, and properties are one edge index | 2, 3 |
| Views are notes (linkable, transcludable, versioned, diffable) | 3 |
| Schema on demand with a Structure Health panel (untyped notes, type mismatches, dangling links, duplicate IDs, orphans) | 3 |
| Time as a first-class axis ("view as of date", "what changed this week") | 5 |
| Installable vault kits (PARA, Zettelkasten, GTD, Meeting-OS) | 6 |
| Source vs derived always visible, with a rebuild button on every index | 2 |
| Progressive disclosure: plain text first, structure when asked for | 4 |

Cloud sync and collaboration remain an explicit late bet (Phase 8), designed for from Phase 2 onward but never a prerequisite for daily use.

## 2. Principles (supersede the four in `ROADMAP.md`)

1. Local-first, own-your-data. No mandatory backend, account, or telemetry.
2. NFM is the portable authority. New structure ships with a spec section and a round-trip corpus before UI.
3. One object model; no parallel "task" or "database" storage formats.
4. Design system first. No surface ships without tokens, icons, focus states, motion rules, and both themes.
5. Earn dependencies, but stop hand-rolling where a mature core exists (editor, CRDT, search, state machines).
6. Tested and budgeted. Budgets are per route and gzip-based; raise them deliberately, never by living 71 bytes under a ceiling.
7. Every phase is a releasable vertical slice with migrations, recovery, live proof, and automated canonical deploy.
8. House rules WEB-1, WEB-2, WEB-3 are acceptance criteria, not aspirations.

## 3. Phase map

| Phase | Theme | Effort (one developer plus agent lanes) | Depends on | Closes audit findings |
|---|---|---|---|---|
| 0 | Foundation and release safety | 2–3 weeks | none | 4.1, 4.4, C.7 |
| 1 | Design system and app shell | 4–6 weeks | 0 | 4.3, D.9 items 1–7, 10–14 |
| 2 | Record model (schema v7) | 3–4 weeks | 0 | 4.2 items 1–3, 8 |
| 3 | Collections and views | 6–8 weeks | 2 | 4.5 items 1, 3, 11 |
| 4 | Editor core | 6–10 weeks | 1, 2 | 4.2 item 4, 4.5 item 6 |
| 5 | Work management | 4–6 weeks | 3 | 4.5 item 7 |
| 6 | Spaces and knowledge management | 4–6 weeks | 1, 3 | D.8, 4.5 item 8 |
| 7 | Search, AI, and automation | 4–6 weeks | 3 | 4.5 items 9, 10 |
| 8 | Sync and collaboration (the bet) | 8–12 weeks | 2, 4, 6 | 4.5 items 2, 12 |
| 9 | Platform and ecosystem | 4–6 weeks | 3, 6 | 4.5 items 4, 5 |

Sequential total: 45–67 weeks. With Phases 5/6/7 as parallel lanes after Phase 3 and Phase 9 overlapping Phase 8: roughly 32–42 weeks. Calendar sketch: Q4 2026 Phases 0–2; Q1 2027 Phases 3–4; Q2 2027 Phases 5–7; Q3 2027 Phases 8–9.

Why views come before the editor rewrite: database views are the number-one switching blocker, they depend only on the record model, and the editor core is the riskiest and longest item. Shipping views first delivers organizational superiority while the editor decision is de-risked with a prototype.

## 4. Phases in detail

### Phase 0 — Foundation and release safety (2–3 weeks)

**Status: complete 2026-09-27 (v1.2.0).** Sprint records: [Sprint 2](sprints/2026-09-26_phase0_sprint2.md), [Sprint 3](sprints/2026-09-27_phase0_sprint3.md). Two scope changes: release-please became a version-bump `release` job (Actions may not open PRs here), and Conventional Commits were not adopted ([decision log](../architecture/decisions.md)). Still with Dave: branch protection, Dependabot alerts, merged-branch cleanup.

Goal: make the rewrite safe to start and make the two live surfaces provably identical.

Week 1 quick fixes (no architecture change, ship as one PR):
- Define `.sr-only`; fix `accessibility-hardening.css` selectors (`.note-item--active` → `.note-item--on`) and add `aria-current` to the active note; label the title input, pin, and delete controls; add a skip link; load the hardening stylesheet in the initial shell.
- WEB-1: default theme to `light`, apply the persisted theme before first paint (inline script reading the config key), put the toggle in the mobile bar, set per-theme `theme-color`, declare `color-scheme`.
- Bump `dompurify` to 3.4.16; enable Dependabot (grouped minor/patch).
- Re-sync the canonical deploy to `main` by hand once, so users stop running divergent semantics.

Release safety:
- **Automated canonical sync.** NoteForge's deploy job sends a `repository_dispatch` to System by Dave; a new `noteforge-sync.yml` there checks out NoteForge at the exact SHA, builds under Node 22, runs the existing `sync:noteforge` + `verify:noteforge`, and opens or auto-merges a PR. A nightly job fails when `source_provenance.sourceCommit` differs from `noteforge@main`. Emit `<meta name="noteforge-build" content="<sha>">` so drift is inspectable with one `curl`.
- **Branch protection** on `main`: require the `verify` job, require PRs, linear history, delete branch on merge. Fix the `concurrency` group so a push to `main` cannot cancel an in-flight main deploy.
- **Toolchain pins.** `.nvmrc` = 22, `engines` enforced with `engine-strict`, Node 22 + 24 CI matrix.
- **Static gates.** Biome (lint + format) and `tsc --noEmit` with `checkJs` over `src/` using JSDoc `@typedef`s for `core/` and `utils/`. New files are `.ts` from Phase 1.
- **Test harness.** Run Node tests under `node --test` (or Vitest) with a JUnit reporter uploaded to CI and a count floor (≥ 425). Convert the eight browser smokes to `@playwright/test` specs with `retries: 1`, `trace: 'retain-on-failure'`, and artifact upload; inject a fixed clock. Add `@axe-core/playwright` and `toHaveScreenshot` baselines for the shell, editor, palette, and modals in both themes at 390 / 1440 / 2560.
- **Golden corpus.** Freeze `renderMarkdown()` HTML and `parse/serialize` output for every seed note and the schema-v3 fixtures into `test/golden/`. Every later phase must keep these byte-identical or record an approved diff.
- **Budget policy v2.** Replace the single 257,180-byte ceiling with per-route gzip budgets (`shell`, `editor`, `collections`, `graph`, `recovery`) measured in CI, with a documented raise procedure. Land `marked` 18 behind the golden corpus.
- **NFM spec v1.** `docs/spec/nfm.md` documents the syntax that exists today (wikilinks with aliases and fragments, `^block-ids`, `![[embeds]]`, `@date()`, `@due()`, `> [!callout]`, `<details>` toggles, frontmatter types) with a conformance corpus in `test/fixtures/nfm/`.
- **Repo hygiene.** Delete the 12 merged branches; add `CHANGELOG.md`; tag `v1.1.0` at the current release SHA; adopt Conventional Commits and release-please; move `date_project_implementation_plan.txt` under `docs/implementation/`.

Exit criteria: canonical and mirror serve identical hashes from an automated sync and a drift check is green; Biome, tsc, unit, Playwright, axe, visual, and budget gates run on every PR; `v1.1.0` exists; NFM spec and golden corpus committed; the accessibility and WEB-1 quick fixes are live on both surfaces.

### Phase 1 — Design system and app shell (4–6 weeks)

Goal: the "visually stunning" layer. Ship a new shell around the existing editor and data layer so nothing about storage changes (strangler fig).

Design approach (from Appendix D.10): three-tier tokens (primitive → semantic → component) as CSS custom properties; `@layer reset, tokens, base, primitives, components, utilities` to control ordering across lazily loaded sheets; plain CSS primitives; Zag.js state machines for tree, menu, combobox, and tabs (framework-agnostic; Ark UI reuses them if a framework is adopted later); a self-hosted SVG sprite; no CSS-in-JS runtime; no Tailwind migration.

Scope:
- **Tokens.** Neutral scale with a slight hue bias, accent scale, semantic colors (success/warning/danger/info) with dark variants, `--on-accent`, focus ring, 4 px spacing scale, type scale (12/13/14/16/18/22/28/36/44), line-height scale, radius scale, three elevation levels by tint plus shadow, motion durations and easings, z-index layers, and two density modes. Light and dark palettes designed separately. Fix the audited contrast failures (dark accent 2.90:1, dark danger 2.77:1, field borders).
- **Typography.** Self-hosted variable UI face (Inter or Geist, subsetted woff2, precached, loaded outside the initial shell) with the system stack as fallback; JetBrains Mono or system mono for code; 16 px body; wrapping page title at ~40 px; heading top margins; 68–72 character measure with a "wide" toggle.
- **Icon system.** Lucide as an inline `currentColor` sprite (~40 icons to start). Every emoji or Unicode glyph used as chrome is replaced. Emoji remain available as user page icons.
- **Primitives.** Button (sm/md, 32 px desktop / 44 px touch targets, hover/focus/active/disabled), Field (one, replacing 16 stylings), Dialog shell (one, replacing 8 footers), Menu, Tabs, TreeItem, Chip, Toast, EmptyState with a call to action, Skeleton. A toast and confirm service replaces the 18 native `alert()`/`confirm()` calls, with undo for trash.
- **Shell layout.** Four regions: icon rail (spaces, search, capture, tasks, calendar, graph, settings, theme), collapsible and resizable sidebar (Favorites, Recents, Tree, Collections, Views, Tags; ~30 px single-line rows; checkboxes only in selection mode; ARIA tree with roving tabindex), main (tabs and panes), and a right context panel (Outline, Backlinks, Properties, History, Comments). Viewport-height shell with panel-local scrolling. Tasks, Calendar, Graph, Archive, and Trash become panels or tabs instead of modals (WEB-2). *2026-09-27: Tasks, Calendar, Archive, and Trash are main-area views like Graph (`src/components/main-view.js`); WEB-2 no longer has subject areas in modals.*
- **Breakpoints.** 390 (single column, bottom tab rail: Notes / Search / Capture / Tasks / More; one top bar; banner collapses to 96 px; block gutter visible on touch), 768 (sidebar overlay), 1024 (sidebar + main), 1440 (sidebar + main + context), 1920 (context open by default, two panes comfortable), 2560+ (three panes or main plus two context columns; measure preserved; full-bleed graph with zoom and pan). `min-width` and container queries; `dvh` (WEB-3). *2026-09-27: the 768 sidebar overlay shipped, and visual baselines now cover 390 / 768 / 1440 / 1920 / 2560 in both themes. The 1920 and 2560+ layouts (context open by default, three panes) are open.*
- **Page chrome.** Page icon (new note field, additive migration) and cover, breadcrumbs, title, property strip, last-edited, empty states, skeletons for lazy chunks.
- **Command palette v2.** Grouped results (Pages, Commands, Views, Tags, Recent), icons, key chips, inline preview, nested actions. *Groups (Recent, Notes, Commands, Headings), icons, key chips, and the preview shipped 2026-09-27; Views and Tags groups and nested actions are open.*
- **Slash menu v2** with icons, groups, and listbox ARIA; separate block action menu; Alt+Shift+↑/↓ block moves. *Icons, groups, combobox + listbox ARIA, block moves, and the block action menu (handle or Ctrl/⌘+/) shipped 2026-09-27.*
- **Motion.** Dialog and menu enter/exit (120–180 ms), drawer, list reorder, spring-damped drag and splitter; reduced motion respected. *Enter animations and the tokenized drawer shipped 2026-09-27; exits stay instant (delaying `hidden` would complicate focus return and inert). List reorder and drag motion are open.*
- **Overflow menu** grouped (Create / Views / Knowledge / Data / Help) with separators, icons, shortcut hints, arrow keys. *Shipped 2026-09-27 with App (Settings) in place of Help; see the [decision log](../architecture/decisions.md).*

Exit criteria: visual baselines approved at 390 / 768 / 1440 / 1920 / 2560 in both themes; axe clean; no emoji in chrome; Lighthouse accessibility and best-practices ≥ 95; WEB-1/2/3 pass; no storage change beyond the additive `icon` field; the Phase 0 count floors hold.

### Phase 2 — Record model, schema v7 (3–4 weeks)

Goal: replace the load-bearing "Markdown string is the record" decision with a block and property record model, keeping NFM as a lossless projection. This is the prerequisite for views, relations, per-block comments, multi-vault, and sync.

Scope:
- **Per-note storage keys.** Move from one `notes` array key to `note:<id>` keys plus an index key, using the existing `storage.saveMany` atomic batch and the revision-protected migration path (`database.js:770-803`). Writes become O(1) per save.
- **Block records.** Every block carries a persistent ID (all types, not 6 of 12), a type, content, marks, children, and props. Unassigned IDs are generated once and written back to NFM as `^id` only when referenced; otherwise they live in the record and are stable across parses.
- **Typed property records.** Properties become first-class typed records (text, number, checkbox, date, date range, select, multi-select, status, url, email, relation, rollup, formula, created/edited time, files, icon). Frontmatter remains the NFM projection. Aliases live in one place; delete the 285-line reconciler.
- **Edge index.** `parent`, wikilinks, and relation properties are one edge set with typed labels; tree, backlinks, graph, and relation columns read the same index. Every derived index gets a visible "rebuild" action.
- **NFM projection.** `project(record) → md` and `parse(md) → record` with `project(parse(md)) === md` over the golden corpus and the randomized 1,000-note corpus. Backups store records; export stores NFM; both restore.
- **Typed config.** Replace the flat `db.config` bag with a versioned settings record (prepares multi-space).
- **Migration.** v6 → v7 runs once, prompts for a portable backup first, is revision-protected, and is covered by fixture pairs and the randomized fidelity test.

Exit criteria: all 425+ Node checks green on the record model; golden corpus byte-identical; a 5,000-note vault saves a single note in < 20 ms; backup and export round-trip; no user-visible behavior change.

### Phase 3 — Collections and views (6–8 weeks)

Goal: Notion-class databases on plain files. Closes the number-one competitive gap.

Scope:
- **Collection** = a page whose properties declare a schema; members are its children or a query. Schema property types as in Phase 2. Templates per collection.
- **Views:** Table (resizable, reorderable, inline cell editing, virtualized past 200 rows), Board (group by select or status, drag between groups), List, Gallery (cover and properties), Calendar (any date property), Timeline (date range). Filters, sorts, groups, hidden properties, per-view templates.
- **Views are notes.** A view definition is a page (or a fenced `nf-view` block inside any page) serialized in NFM, so it is linkable, transcludable, versioned, and diffable.
- **Relations and rollups** across collections; **formulas** with a small sandboxed expression language (no `eval`).
- **Structure Health panel:** untyped notes, type mismatches, dangling links, duplicate IDs, orphaned children, with one-click fixes.
- **Chart block** bound to a view (count, sum, group by) rendered as inline SVG.
- **Manual sibling order** with an insert-between drop line in the tree.
- Interop: Obsidian Bases `.base` import/export adapter for table views (verify spec at build time).

Exit criteria: create a collection, add 500 pages, switch between six views under 100 ms, edit a cell and see NFM frontmatter change; relations and rollups update incrementally; views survive backup, export, and reload; migration corpus unchanged.

### Phase 4 — Editor core (6–10 weeks)

Goal: a Notion-class editing surface with inline formatting and nested blocks on the Phase 2 record model.

Decision: replace the hand-rolled raw/rendered canvas with **TipTap (ProseMirror)** and a custom NFM schema, parser, and serializer. Rationale: inline marks, nested nodes, collaboration bindings (`y-prosemirror`), and a mature extension ecosystem; the audit shows the current model cannot express marks or nesting without a rewrite anyway. Alternatives kept in the decision log: Lexical (smaller, less Markdown tooling), BlockNote (heavier, opinionated). A two-week spike at the start of Phase 3 validates the NFM round trip before this phase is committed.

Scope:
- NFM schema: paragraph, heading 1–6, bullet/numbered/task lists with children, quote, callout with children, toggle with children, code (language, Shiki lazy), divider, image (caption, width), table (rich cells), date/due chips, math (KaTeX lazy), bookmark card, column layout (`::: columns` container convention), synced block (generalized transclusion), page/date/tag mentions, block IDs.
- Inline marks: bold, italic, strikethrough, code, highlight, link, wikilink, underline.
- Floating format toolbar, drag handle with multi-block selection, "turn into", duplicate, move to page, copy link.
- Block comments as single-user annotations keyed by block ID (shared in Phase 8).
- Drop `marked` for rendering (the schema renders); keep DOMPurify for imported HTML.
- Progressive disclosure: a blank page is a cursor; typing `@due`, `[[`, or `---` reveals the affordance.

Exit criteria: every existing block feature has an equivalent; new blocks have NFM spec entries and fixtures; golden corpus byte-identical; typing p95 input-to-DOM < 50 ms on the 5,000-note corpus; two-pane single-writer contract preserved; editor route ≤ 120 KB gzip.

### Phase 5 — Work management (4–6 weeks)

Goal: ClickUp-class task handling on the collection model.

Scope: task pages (status, priority, due/start, estimate, parent, blocked-by) unified with inline `- [ ]` tasks through the task index; custom status sets per collection; subtasks; recurring tasks (RRULE in properties, next occurrence materialized on completion); reminders via the Notification API; sprints and milestones as collections; Timeline/Gantt with dependencies; dashboards (page with widget blocks: counts, progress, charts from views); Goals/OKR kit; light time tracking (start/stop log); "My work" home; "view as of date" and "what changed this week" from revisions.

Exit criteria: a project can be planned and tracked entirely inside NoteForge; Today/Overdue/Upcoming views stay exact; all data visible in NFM.

### Phase 6 — Spaces and knowledge management (4–6 weeks)

Goal: Confluence-class organization and page lifecycle.

Scope: multiple spaces (vaults) in one IndexedDB with a rail switcher and per-space settings; drag-and-drop across spaces; page status (draft, in review, verified, stale) with "verify until" and a stale queue; labels; templates gallery with previews and user-defined templates from any page; visual diff in history; "Publish space" static-site export (zip with navigation, search, theme) for read-only sharing; bookmark cards; installable vault kits (PARA, Zettelkasten, GTD, Meeting-OS).

Exit criteria: two spaces coexist with separate trees, views, and settings; a published export opens offline with working links; migration and backup include spaces.

### Phase 7 — Search, AI, and automation (4–6 weeks)

Goal: find and act on anything, with AI as an optional bring-your-own-key layer.

Scope: MiniSearch full-text index with field boosts and typo tolerance (worker-backed, lazy); optional semantic search via local embeddings (transformers.js, opt-in download) or the DaveLLM/Ollama endpoints; "Ask this space" with Claude (default `claude-sonnet-5`, BYO key) or Ollama; editor AI actions (summarize, rewrite, extract tasks, auto-tag, fill properties); automations (trigger: property change, schedule, page created → set property, move, create from template, notify) and buttons; forms that create collection pages; protocol handler `web+noteforge://`; a CLI over the exported folder. Keys stored locally and never exported in backups. No telemetry.

Exit criteria: 5,000-page search p95 < 100 ms; AI features fully usable offline with Ollama; automations logged and reversible via revisions.

### Phase 8 — Sync and collaboration (8–12 weeks, optional bet)

Goal: the same space on two devices, and real-time editing with a second person, without giving up local-first.

Scope: Yjs document per page (`y-prosemirror`, `y-indexeddb`); NFM serialized from the Y doc on save; providers in order: folder sync via File System Access on a user-synced folder (extends reconciliation; conflicts keep both copies), self-hosted relay (`y-websocket` on Cloudflare Durable Objects or a small VPS), Git-backed sync; presence and cursors; shared comments; share links via relay; minimal permissions (owner, editor, viewer).

Exit criteria: two browsers edit one page concurrently with no lost characters; offline edits merge on reconnect; backups restore without a server.

### Phase 9 — Platform and ecosystem (4–6 weeks)

Goal: meet users where they are and let others extend the product.

Scope: Tauri desktop app with a true file-system vault (NFM files are the store; IndexedDB the cache); mobile PWA polish (share sheet, install prompt, safe areas, window-controls overlay); importers (Notion export zip with databases as collections, Obsidian vault, Confluence HTML export, ClickUp CSV); exporters (PDF via print CSS, Obsidian folders); plugin API (block types, views, commands, themes) with two reference plugins; theme packs; one-command release.

Exit criteria: a Notion export imports with pages, databases, and properties intact; the desktop build ships from CI; the plugin API is documented.

## 5. Cross-cutting tracks

- **Accessibility:** axe in CI; keyboard-only and screen-reader smoke per phase; WCAG 2.2 AA; 24 px minimum targets.
- **Performance:** 5,000-page corpus in fixtures; per-route gzip budgets; interaction budgets (search, typing, view switch) in CI; Lighthouse CI ≥ 90.
- **Security:** CSP stays strict; sanitizer allowlist reviewed per new block; sandboxed formulas and automations; plugins off by default.
- **Documentation:** NFM spec, user guide, plugin docs; `README.md` and `ROADMAP.md` updated per phase; decision log in `docs/architecture/`.
- **Release:** exact-SHA CI, automated canonical sync, provenance parity, build meta tag, offline update proof, semver tags and CHANGELOG.

## 6. Decision points

| When | Decision | Recommendation |
|---|---|---|
| Phase 0 | Biome vs ESLint + Prettier | Biome |
| Phase 0 | `node --test` vs Vitest | `node --test` now (zero new deps); Vitest when component tests need a DOM |
| Phase 0 | Canonical sync Option A (dispatch + PR) vs Option B (release assets) | A now, B when tags exist |
| Phase 1 | Vanilla DOM + Zag vs framework for the shell | Vanilla + Zag now; revisit for Phase 3 if view code exceeds ~5k lines (Solid or Preact) |
| Phase 2 | Per-note keys vs per-block keys | Per-note now; per-block when sync lands |
| Phase 3 | Own view format vs Obsidian Bases | Own NFM format with a Bases adapter |
| Phase 4 | TipTap vs Lexical vs extend hand-rolled | TipTap after a two-week spike proves the NFM round trip |
| Phase 7 | Local embeddings vs remote | Both, opt-in, default off |
| Phase 8 | Relay hosting | Cloudflare Durable Objects first |
| Phase 9 | Tauri vs Electron | Tauri |

## 7. Costs

- Zero recurring cost through Phase 7 (static hosting, BYO AI keys).
- Phase 8 relay: about US$5–10/month self-hosted; a Cloudflare free tier may cover one user.
- Assets: none required (Lucide MIT, Inter/Geist OFL, TipTap MIT core).
- Time is the real cost: 32–42 weeks with parallel agent lanes.

## 8. First 10 working days (Phase 0 kickoff)

Sprint records live in [`docs/roadmap/sprints/`](sprints/); the first is [Phase 0 · Sprint 2](sprints/2026-09-26_phase0_sprint2.md).

1. Open the quick-fix PR (`.sr-only`, forced-colors selector, `aria-current`, labels, skip link, WEB-1 default light and pre-paint theme, dompurify bump).
2. Hand-sync the canonical deploy to `main`; confirm live hash parity.
3. Enable branch protection and Dependabot; add `.nvmrc`; fix the concurrency group.
4. Add the System by Dave `noteforge-sync.yml` dispatch workflow and nightly drift check; add the build meta tag.
5. Add Biome and `tsc --checkJs`; fix blocking errors only.
6. Run Node tests under `node --test` with JUnit and a count floor.
7. Capture golden-corpus snapshots and visual baselines of the current UI.
8. Replace the byte ceiling with per-route gzip budgets in `test/bundle-budget.mjs`.
9. Write NFM spec v1 from the existing parsers; commit the corpus; prune branches; tag `v1.1.0`.
10. Start the Phase 1 token file and icon sprite behind a feature flag; open the design review with screenshots at 390 / 1440 / 2560.
