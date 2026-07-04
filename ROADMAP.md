# 🗺️ NoteForge — Roadmap

A phased plan for the next several rounds of features and upgrades. Each round is
a coherent theme that can ship on its own; ordering reflects dependencies and
risk, not a fixed schedule. Reprioritize freely — this is a guide, not a contract.

## Where we are today

Local-first notes app (vanilla JS + Vite, no framework). Shipped:

- **Block editor** — paragraph, H1–H3, bulleted/numbered/to-do lists, quote, code,
  divider, date blocks; slash menu, markdown shortcuts, full keyboard model,
  undo/redo, drag-reorder, paste-explode.
- **Knowledge graph** — `[[wikilinks]]` + autocomplete, derived backlinks, a
  force-directed graph view.
- **Retrieval** — tags + tag filter, full-text search with highlighting.
- **Presentation** — dark/light theme, per-note banner covers (gradient / upload /
  URL), JSON export/import.
- **Durability** — IndexedDB persistence (with localStorage migration + fallback),
  a `schemaVersion` migration runner, soft-delete Trash (restore / purge), and a
  strict production Content-Security-Policy. *(Round 1 — shipped.)*
- **Architecture** — markdown is the source of truth (`blocks.js` parse/serialize);
  banner/tags/deletedAt are note metadata; pure data layer decoupled from the DOM
  renderer; async persistence behind a coalescing write queue.
- **Retrieval & organization** — command palette (`Ctrl/⌘+P`), fuzzy + scoped search,
  pin & sort, and note templates. *(Round 2 — shipped.)*
- **Editor depth** — image blocks (drop/paste/upload), callouts, tables, and block
  multi-select. *(Round 3 — shipped.)*
- **Reach & polish** — installable PWA + offline service worker, light/dark/system
  theme, a Settings panel (font/width/autosave/default-template), an off-canvas mobile
  sidebar, and an accessibility pass. *(Round 4 — shipped.)*
- **Deferred depth (now shipped)** — **nested notes** (parent/child outline in the
  sidebar with collapse, add-child, and drag-to-nest), a **first-class editable table**
  grid and **collapsible toggles** in the editor, and **performance** work (a
  virtualized note list + a node-budgeted graph for large vaults). *(Depth round — shipped.)*
- **Quality** — 223 Node assertions (`npm test`) + 302 browser feature assertions
  (`npm run test:browser`, headless via Playwright), gated in CI on every push; an
  adversarial-review workflow is part of the dev loop, and a recent audit pass fixed
  14 verified issues (round-trip corruption, keyboard/ARIA gaps, a silent-save-failure
  warning, and navigation dead-ends).

## Guiding principles (keep these as we grow)

1. **Local-first, own-your-data.** No mandatory backend; the DB is portable.
2. **Markdown stays the source of truth.** New content features must round-trip
   losslessly through `parse()`/`serialize()`; metadata lives on the note.
3. **Earn every dependency.** Stay vanilla unless a feature genuinely needs a
   library (e.g. a real WYSIWYG core) — and justify it.
4. **Tested + reviewed.** Every substantive change gets round-trip/feature tests,
   an adversarial review, and a visual check before it's "done."

---

## Round 1 — Foundations & durability ✅ *(shipped)*

*Theme: make the data layer safe and scalable before piling on features. Highest
technical risk, lowest user-visible flash — do it first.*

**All items below shipped:** IndexedDB behind `storage.js` (async, blob-friendly)
with lazy localStorage migration + fallback; `schemaVersion` + a pure migration
runner (`migrations.js`); soft-delete Trash (restore / delete-forever / empty,
with a menu badge); a strict production Content-Security-Policy (dev-permissive
for HMR, injected by `vite.config.js`); and CI (`.github/workflows/ci.yml`) that
builds and runs both the Node and headless-browser suites on every push.

- **IndexedDB persistence** behind `storage.js`. `localStorage` caps at ~5 MB for
  the whole DB; banner uploads (data URLs) and a growing vault will hit that wall.
  Move to IndexedDB (async, ~hundreds of MB, blob-friendly). Keep the `storage`
  interface; add a one-time migration from `localStorage`.
- **Schema versioning + migrations.** Add a `schemaVersion` to the stored payload
  and a tiny migration runner, so future format changes are safe.
- **Data safety: trash + recovery.** Soft-delete (deleted notes go to a Trash with
  restore + purge) instead of the current hard `confirm()` delete. Guards against
  accidental loss of the only copy.
- **Content-Security-Policy** meta/header. Closes the residual "external `url()`
  fetch" surface the banner review flagged and hardens `data:`/`img` handling.
- **CI + automated browser tests.** GitHub Actions: `npm ci && npm run build &&
  npm test`, plus run `test/features.html` headlessly (Playwright or
  `chrome --headless`) so the 125 assertions gate every push instead of being
  run by hand.

**Done when:** notes + images persist in IndexedDB with a clean migration, deleting
is recoverable, and CI runs unit + browser tests green on every push.

---

## Round 2 — Organization & retrieval at scale ✅ *(mostly shipped)*

*Theme: the editor is strong, but finding and organizing many notes is still flat.*

**Shipped:** a **command palette** (`Ctrl/⌘+P`) blending fuzzy note-open, commands
(`>`), and heading jump (`#`); **ranked + scoped search** (`tag:`, `in:title`,
`has:banner`, `is:pinned`) with fuzzy highlighting; **pin** (float to top) and
**sort** (updated / created / title); and **templates** (daily / meeting / project).
**Nested notes** (originally deferred here) later shipped in the depth round: a
parent/child outline in the sidebar with collapse/expand (persisted), add-child, and
drag-to-nest — see below.

- **Command palette** (`Ctrl/⌘+P`) — fuzzy quick-open notes, jump to headings, and
  run actions (new note, toggle theme/graph, export…). Becomes the app's spine.
- **Search upgrades** — ranked/fuzzy results, scoped filters (`tag:`, `in:title`,
  `has:banner`), and a recent-notes list. Consider a lightweight index.
- **Note organization** — pin/favorite, sort options (updated/created/title/manual),
  and either nested notes (parent/child) or folders. Pick one model and commit.
- **Templates** — "New from template" (daily note, meeting, project) seeded from
  reusable markdown; ties in with the date block.

**Done when:** you can find any note in <2 keystrokes-worth of typing, pin/sort the
sidebar, and start a structured note from a template.

**Depends on:** nothing hard, but virtualized note list (Foundations track) helps if
the vault is large.

---

## Round 3 — Editor depth ✅ *(mostly shipped)*

*Theme: richer blocks, closing the gap with Notion/Obsidian for real documents.*

**Shipped:** block **images** (drop / paste / upload, downscaled, src-allowlisted,
serialized as `![alt](…)`); **callouts** (`> [!note]`-style boxes rendered from a
blockquote, so they stay plain markdown); and **block multi-select** (shift-click
range → delete / copy / cut as markdown). A **first-class editable table** grid
(edit cells in place, `Tab`/`Enter` navigation, ＋/－ Row & Col, header + per-column
alignment; parses to / serializes from a GFM table) and **collapsible toggles**
(`/toggle` → a `<details>` block, sanitized-allowlisted so it renders as a native
disclosure) landed in the follow-up depth round. **Still deferred:** the inline-WYSIWYG
stretch (would drive the ProseMirror/Milkdown fork below).

- **Inline & block images** — drop/paste an image into the body (reuses `image.js`
  downscaling); serialize as `![alt](data-or-url)`.
- **Callout / toggle (collapsible) blocks** — high-value Notion staples; serialize to
  a stable markdown convention (e.g. `> [!note]` callouts, `<details>` toggles).
- **First-class tables** — an editable table block instead of the current raw-block
  passthrough (add/remove rows & columns, tab navigation).
- **Block multi-select & clipboard** — shift-select ranges, copy/cut/paste blocks,
  duplicate; improves on today's single-block model.
- **Stretch: inline WYSIWYG marks** — bold-as-you-type etc. This is the one feature
  that may justify adopting a ProseMirror/Milkdown core (see Strategic forks). Only
  take it on if users ask; the hybrid raw/rendered model is deliberate.

**Done when:** images, callouts/toggles, and editable tables round-trip losslessly and
feel native in the block flow.

**Depends on:** Round 1 IndexedDB (inline images make the storage ceiling urgent).

---

## Round 4 — Reach & polish ✅ *(shipped)*

*Theme: meet users where they are — installable, mobile, accessible, configurable.*

**Shipped:** an installable **PWA** (web manifest + a runtime-caching **service
worker** for offline launch, registered in production only); a **Settings** panel
(theme light/dark/**system**, editor font size & width, autosave delay, default
new-note template); an **off-canvas mobile sidebar** with a toggle + backdrop; and an
**accessibility pass** (visible focus rings, ARIA-labelled icon controls, a
keyboard-navigable graph, focus-trapped/inert modals, `prefers-reduced-motion`).
*Note:* the icon ships as SVG (add rasterized PNGs if a store/older target needs them);
"theme scheduling" landed as **System** (follows the OS) rather than a night timer.

- **PWA** — web app manifest + service worker for offline install and launch. Natural
  fit for a local-first app.
- **Mobile** — a sidebar toggle (the overlay exists but has no open button on small
  screens), touch-friendly drag/reposition, and responsive editor width.
- **Accessibility pass** — ARIA roles for the block canvas/menus, keyboard-only menu
  and graph navigation, focus management across re-renders, visible focus rings.
- **Settings panel** — editor font size & width, autosave interval, theme scheduling
  (auto dark at night), default new-note template. (`config` already persists; give
  it a UI.)

**Done when:** the app installs offline, is usable one-handed on a phone, passes a
keyboard-only + screen-reader smoke test, and exposes real preferences.

---

## Round 5 — Sync & sharing (the big bet)

*Theme: multi-device and collaboration. Largest scope; only if the trajectory calls
for it (see Strategic forks). Keep local-first intact.*

- **File System Access API** — save the vault as real `.md` files in a chosen folder
  (Obsidian-compatible), with two-way sync to the on-disk copy. Biggest single
  "own your data" upgrade and a stepping stone to any sync.
- **Cloud sync / git** — optional: push/pull to a git remote or a sync service; define
  a conflict strategy (last-write-wins → CRDT if real-time is ever needed).
- **Publish / share** — ✅ *shipped:* a note exports to a **self-contained, read-only
  HTML page** (rendered + inline-styled, wikilinks flattened, no external assets) or to
  raw Markdown, and the **graph exports as a standalone SVG** (inlined styles) from its
  toolbar. Still open: true shareable *links* (needs hosting/sync below).

**Done when:** the same vault is editable on two devices without clobbering, and a
note can be shared as a link/file.

---

## Cross-cutting tracks (run continuously, not a "round")

- **Performance** — ✅ *shipped:* the note list **virtualizes** (windows fixed-height
  rows past ~80 notes); the graph **caps** a large vault to its most-connected nodes
  with a scaled iteration count (always keeping the open note) and **caches its force
  layout** — re-opening the graph or switching the active note reuses positions instead
  of recomputing the O(n²) layout. Still open: incremental relayout on partial graph
  changes (profile before optimizing).
- **Testing & tooling** — grow the feature suite alongside features; consider Vitest +
  jsdom for component logic; keep the adversarial-review step in the loop.
- **Docs** — keep `README.md` current; add short "how it works" notes for the block
  model and the storage/sync boundary.

## Strategic forks (decide before Rounds 3 & 5)

1. **Personal tool vs. shareable product.** Personal → prioritize Rounds 2–3 depth.
   Product → pull PWA/mobile/a11y (Round 4) and sharing (Round 5) forward.
2. **Stay local-only vs. add sync.** Sync is the difference between "great single-device
   app" and "daily driver everywhere." It's the heaviest lift — commit deliberately.
3. **Vanilla vs. an editor framework.** The block editor is intentionally hand-rolled.
   If inline WYSIWYG or collaborative editing becomes a must, that's the moment to
   evaluate ProseMirror/Milkdown — accepting a custom markdown serializer and a custom
   `[[wikilink]]` node as the cost.

## Suggested near-term sequence

~~`Round 1 (IndexedDB + trash + CI)`~~ ✅ → ~~`Round 2 (palette + search + pinning)`~~ ✅
→ ~~`Round 3 (editor depth)`~~ ✅ → ~~`Round 4 (reach & polish)`~~ ✅ → ~~`Depth round
(nested notes + first-class tables/toggles + list/graph virtualization)`~~ ✅ → **next:
decide fork #2 (local-only vs. sync). If sync → `Round 5` (File System Access `.md` vault
first). Otherwise: the inline-WYSIWYG stretch (fork #3) or the remaining performance
items (incremental graph relayout).**
