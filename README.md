# 📝 NoteForge

[![Deploy](https://github.com/DaveHomeAssist/noteforge/actions/workflows/deploy.yml/badge.svg)](https://github.com/DaveHomeAssist/noteforge/actions/workflows/deploy.yml)

**Live demo → https://systembydave.com/noteforge/** &nbsp;·&nbsp; mirror: https://davehomeassist.github.io/noteforge/

A local-first personal notes app inspired by Obsidian & Notion. Markdown notes
with `[[wikilinks]]`, automatic backlinks, tags, full-text search, a link graph,
and dark mode — all stored in your browser, no backend required.

## Features

- **Command palette** (`Ctrl/⌘+P`) — the keyboard spine. Fuzzy quick-open notes,
  run any action (new note, templates, toggle theme/graph, Trash, export…). Type
  `>` to restrict to commands, `#` to search headings across all notes.
- **Notion-style block editor** — each paragraph, heading, list item, to-do,
  quote, code, **divider**, or **date** is its own block. The focused block shows
  raw markdown; the rest render live (bold, links, checkboxes). Type `/` for a
  **slash menu** to insert or convert block types; hover a block for `+` / drag
  (`⋮⋮`) handles.
- **Divider & date blocks** — `/divider` (or `---`) inserts a rule; `/date`
  inserts a date chip with a native picker. Both are click-to-select,
  Backspace-to-delete. Dates persist as `@date(YYYY-MM-DD)` in the markdown.
- **Images, callouts, tables & toggles** — drop / paste / upload an image
  (auto-downscaled, src allowlisted); `/callout` for a `> [!note]`-style highlighted
  box (note / tip / warning / …); `/table` for an **editable grid** — edit cells in
  place, `Tab`/`Enter` to move between them, ＋/－ Row & Col buttons, header +
  per-column alignment; `/toggle` for a collapsible `<details>` section. All
  round-trip as markdown.
- **Block multi-select** — shift-click a range of blocks, then Backspace to delete
  or Ctrl/⌘+C / X to copy / cut them as markdown.
- **Nested notes** — give a note a parent to build an outline in the sidebar:
  disclosure twists collapse/expand subtrees (persisted), ＋ adds a child, and
  drag-and-drop re-nests (drop on empty space to promote to the top level).
- **Banner images** — a Notion-style cover per note: pick a gradient preset,
  upload an image (auto-downscaled to a compact data URL), or paste an image URL,
  then reposition or remove it. Stored as note metadata, so it never touches the
  markdown; values are allowlisted so imported banners can't inject CSS `url()`
  beacons.
- **Trash & recovery** — deleting a note moves it to the **Trash** (🗑 in the
  ⋯ menu) instead of destroying it. Restore it, or delete it forever / empty the
  Trash when you're sure. A badge shows how many notes are waiting.
- **Revision history** — every completed durable edit creates a browser-local,
  SHA-256-deduplicated recovery point. Compare the current note with an older
  revision, restore it after a separately confirmed safety capture, or create a
  restored copy without changing the original. History retains 50 revisions per
  note for up to 90 days by default.
- **Backup center** — inspect the active storage backend and quota, create rolling
  local daily/weekly snapshots, and download a complete, integrity-verified JSON
  backup containing live notes, Trash, stable IDs, settings, and schema version.
  Uploaded backups are verified and previewed before an explicit full-vault restore.
- **Markdown shortcuts** — `# ` → heading, `- ` → bullet, `1. ` → numbered,
  `[] ` → to-do, `> ` → quote, ` ``` ` → code, `---` → divider. Enter splits /
  continues lists; Backspace at the start demotes then merges; Tab indents.
- **Rename-safe `[[wikilinks]]`** — type `[[` for canonical-title and alias
  autocomplete. Display text, heading fragments, and embeds parse from one
  source-aware grammar; rename previews every affected note/link, captures safety
  revisions, rewrites atomically, and keeps the old title as an alias.
- **Outline, contextual backlinks, and mentions** — an H1–H6 outline jumps to
  deterministic duplicate-safe anchors; backlinks show source heading/snippet;
  plain-text mentions can be previewed and converted to exact wikilinks.
- **Knowledge navigation** — labelled Back/Forward controls keep bounded session
  history, while the command palette presents 50 persisted unique recent notes.
- **Graph view** (🕸️) — a force-directed map of how your notes connect.
- **Tags** — add `#tags` as chips; filter the sidebar by tag.
- **Pin & sort** — pin notes to float them to the top; sort the sidebar by
  Updated, Created, or Title. The list **virtualizes** (windows its rows) past ~80
  notes; the graph caps a large vault to its most-connected nodes and **caches its
  layout** (re-opening or switching the active note skips the force relayout), so
  both stay responsive as the vault grows.
- **Export a note** (from the command palette) — **as a self-contained HTML page**
  (rendered, styled, offline-ready, safe to share) or **as raw Markdown** (`.md`).
  **Export the graph** as a standalone **SVG** image from the graph toolbar.
- **Save your vault to a folder** — write every note out as an **Obsidian-compatible
  `.md` file** into a folder you pick (via the File System Access API, on Chromium
  browsers), titles preserved so `[[wikilinks]]` keep resolving.
- **Templates** — start a Daily / Meeting / Project note prefilled with a date
  block and headings (from the palette or the ⋯ menu).
- **Ranked, scoped search** (`Ctrl/⌘+K`) — fuzzy-ranked with match highlighting,
  plus filters: `tag:<name>`, `in:title`, `has:banner`, `is:pinned`.
- **Theme** — light / dark / **system** (follows your OS), persisted.
- **Settings** (⚙ in the ⋯ menu) — theme, editor font size & width, autosave delay,
  and the default template for new notes.
- **Installable PWA** — a web manifest + service worker so it installs to your
  home screen / dock and launches **offline**.
- **Mobile-friendly** — an off-canvas sidebar with a toggle, responsive editor.
- **Accessible** — visible focus rings, ARIA-labelled controls, a keyboard-navigable
  graph, focus-trapped modals, and `prefers-reduced-motion` support.
- **JSON export / import** and one-click sample notes.
- **Autosave** to **IndexedDB** + block-level **undo/redo** — nothing to press.
- **XSS-safe** — all rendered markdown is sanitized with DOMPurify, and the
  production build ships a strict **Content-Security-Policy**.

Markdown is always the source of truth: blocks are an in-memory view produced by
a lossless `parse()`/`serialize()` bridge, so backlinks, search, graph, and
export operate on the same `.md` content and are unaffected by the editor.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + P` | Command palette (notes · `>` commands · `#` headings) |
| `Ctrl/⌘ + N` | New note |
| `Ctrl/⌘ + K` | Focus search |
| `Ctrl/⌘ + G` | Toggle graph view |
| `Alt + Left` / `Alt + Right` | Back / forward through opened notes |
| `Ctrl/⌘ + Z` / `Shift+Ctrl/⌘ + Z` | Undo / redo (within the editor) |
| `/` | Open the block slash menu |
| `[[` | Wikilink title autocomplete |
| `Esc` | Close menu / leave graph view |
| `Tab` / `Shift+Tab` | Indent / outdent a list item (else insert spaces) |

## Run it

Node.js 22 is the supported CI/runtime baseline.

```bash
npm install
npm run dev      # http://localhost:5175
```

Build for static hosting:

```bash
npm run build    # outputs dist/
npm run preview  # serve the build locally
```

## Data & storage

Notes and settings persist in **IndexedDB** (async, blob-friendly, hundreds of
MB) behind the swappable `storage.js` interface. Older data saved to
`localStorage` is migrated automatically on first load, and if IndexedDB is
unavailable (e.g. private mode) the app transparently falls back to
`localStorage`. A `schemaVersion` + migration runner (`migrations.js`) keeps the
on-disk format upgradeable. Deleted notes are soft-deleted to the Trash so they
survive a reload until purged.

Schema version 4 adds normalized note aliases without changing the permanent note
ID or Markdown authority. Canonical titles always outrank aliases; ambiguous
imported identities remain intact but are reported for explicit repair.

Revision history and rolling snapshots use namespaced keys in the same unchanged
`my-notes-app` IndexedDB database and share content-addressed blobs. They are
browser-local recovery aids, not independent backups. If IndexedDB is unavailable,
current-note persistence continues through the existing `localStorage` fallback,
while history and local snapshots report themselves unavailable instead of risking
the smaller fallback quota. Use **⋯ → Backup center → Download JSON backup** for a
portable artifact. See [Recovery and backups](docs/recovery.md) for retention,
verification, restore, and browser-support details.

## Tests

```bash
npm test          # Node: markdown<->blocks round-trip, migrations, note model
npm run test:browser   # Headless (Playwright/Chromium): full interactive feature suite
npm run test:all       # both
```

`test/roundtrip.test.mjs` (260 assertions) proves the `parse()`/`serialize()`
round-trip is lossless (blocks incl. images, tables, toggles — even nested toggles
and backslash-bearing table cells), exercises the schema-migration runner, the fuzzy
matcher and scoped-search parser, the note model (soft-delete + pin + `parentId`), the
nesting tree helpers, the note-export builder, the vault-export filenames, the
settings normalizer / theme resolver, the PWA manifest, and deterministic
schema-version-3 preservation fixtures (including a 1,000-note vault). Dedicated
database, revision, backup, and integrated-recovery suites add 88 Phase 1 checks
covering durable capture ordering, SHA-256 deduplication, retention/garbage
collection, quota/fallback behavior, rolling snapshots, malformed backups, restore
safety, large embedded images, and atomic full-vault replacement. The 12-check
link-integrity suite covers schema-v4 aliases, parser ranges/exclusions, atomic
rename and repair plans, heading anchors, contextual indexes, navigation, backup
fidelity, and a 1,000-note incremental-update budget. The complete Node gate is
360 checks.
`test/features.html` (339 assertions) drives
the editor (incl. images, callouts, editable tables, toggles, multi-select), banner,
Trash, command palette, sidebar sort/pin/search/nesting, list virtualization, graph
layout caching, note + graph + vault export, settings, and the keyboard-navigable
graph and recovery views in a real browser; `npm run test:browser`
runs it headlessly via
`test/run-features.mjs` (boots Vite, waits for the summary the page publishes to
`document.title`, then runs 15 integrated recovery checks and 16 Phase 2 link and
navigation checks at 390 px, plus four production/offline checks (including
first-use Link tools) and fails on
unexpected browser runtime, console, request, or HTTP errors). Both suites gate every push through GitHub Actions
(`.github/workflows/deploy.yml`), which also publishes the build to GitHub Pages.

## Architecture

```
src/
├── app/
│   ├── main.js         # App controller: wiring, views, shortcuts, palette, settings, mobile
│   ├── templates.js    # Daily / meeting / project note templates
│   ├── pwa.js          # Registers the service worker (production only)
│   └── seed.js         # Sample interlinked notes for first run
├── components/
│   ├── editor.js       # Shell: banner, title, tags, pin, backlinks, configurable autosave
│   ├── block-editor.js # Block canvas: slash menu, images, callouts, editable tables, toggles, multi-select, undo, drag
│   ├── banner.js       # Per-note cover: strip, picker (gradients/upload/URL), reposition
│   ├── command-palette.js # Ctrl/⌘+P: fuzzy notes + commands + heading jump (uses modal.js)
│   ├── settings-view.js   # Settings modal (theme/font/width/autosave/default template)
│   ├── history-view.js    # Accessible revision compare/restore/restore-copy workflow
│   ├── backup-view.js     # Storage health, local snapshots, portable verify/restore UI
│   ├── outline-view.js    # Keyboard H1-H6 outline and deterministic heading jumps
│   ├── link-tools-view.js # Previewed rename, mention conversion, ambiguity repair
│   ├── modal.js        # Reusable accessible modal: inert background, focus trap, restore
│   ├── trash-view.js   # Trash modal: restore / delete-forever / empty; menu count badge
│   ├── note-list.js    # Sidebar: nested outline tree, sort, pin, tag filter, scoped + fuzzy-ranked search, virtualized
│   └── graph.js        # Self-contained force-directed SVG link graph (keyboard-navigable)
├── core/
│   ├── note.js         # Note model: content + metadata (aliases, tags, banner, Trash, hierarchy)
│   ├── database.js     # In-memory store + pub/sub + coalesced async persistence + soft-delete/Trash
│   ├── migrations.js   # Pure schema-version migration runner (Node-testable)
│   ├── storage.js      # IndexedDB + fallback, namespaced keys, atomic batch/status APIs
│   ├── revision-store.js # Content-addressed revisions, retention/GC, rolling snapshots
│   ├── recovery-service.js # Durable history and verified restore application boundary
│   ├── backup.js       # Deterministic portable envelope, SHA-256 verify, restore preview
│   ├── knowledge-index.js # Rebuildable contextual backlinks and unlinked mentions
│   └── link-operations.js # Atomic rename/repair/conversion plans with revision gates
├── ui/
│   ├── theme.js        # Resolved data-theme from light/dark/system (matchMedia), persisted
│   └── settings.js     # Pure settings defaults / normalize / theme resolution
├── utils/
│   ├── blocks.js       # Pure markdown <-> block parse()/serialize() bridge (incl. image / table / toggle blocks)
│   ├── tree.js         # Pure nesting helpers: build/flatten a note forest, ancestor/descendant checks (cycle-safe)
│   ├── export.js       # Pure note-export builder: self-contained shareable HTML doc + filename slug
│   ├── download.js     # Tiny shared blob-download helper (note HTML/MD, graph SVG, JSON backup)
│   ├── vault.js        # Save-to-folder: safe/de-duped .md filenames + File System Access write loop
│   ├── wikilinks.js    # Source-aware link tokens/ranges and exact target rewrites
│   ├── link-analysis.js # Context snippets and exclusion-aware mention scanning
│   ├── headings.js     # H1-H6 extraction and occurrence-aware anchors
│   ├── navigation.js   # Bounded session history and persisted recent-note reducer
│   ├── markdown.js     # marked + wikilink extension + DOMPurify sanitize + renderInline()
│   ├── fuzzy.js        # Pure fuzzy subsequence matcher + safe highlight (palette/search)
│   ├── search-query.js # Pure scoped-search parsing (tag:/in:title/…) + note ranking
│   ├── image.js        # Client-side image downscale/compress (banners + inline images)
│   └── helpers.js      # ids, escaping, debounce, dates
└── styles.css          # Tokenized light/dark theme
public/                 # manifest.webmanifest, sw.js (service worker), icon.svg
test/roundtrip.test.mjs # Node invariants: blocks, migrations, note model, fuzzy, search, settings, manifest
test/features.html      # Browser feature suite (editor, banner, Trash, palette, settings, graph)
test/run-features.mjs   # Headless runner for features.html (npm run test:browser)
test/link-integrity.test.mjs # Node invariants for Phase 2 identity/link/navigation behavior
vite.config.js          # Build + dev server; injects the Content-Security-Policy
```

**Design notes**

- **Markdown is the source of truth.** `blocks.js` is the *only* bridge to
  `note.content`; `parse(serialize(b))` deep-equals `b` and `serialize(parse(md))`
  is a fixed point (see `npm test`). The link graph, tags, search, and export all
  read `note.content` and are unaffected by the editor.
- **Raw-when-focused / rendered-when-blurred.** You type into a single flat text
  node (raw markdown), which sidesteps the worst contenteditable/caret bugs, while
  blurred blocks render through the shared `renderMarkdown` → DOMPurify path, so
  wikilinks stay clickable and the editor never hand-builds HTML.
- Components subscribe to the `Database`'s pub/sub; the editor skips re-render
  while a block is focused/composing/menu-open **or** has unsaved edits, so an
  autosave or a background change never clobbers your caret or drops content.
- Persistence lives behind `storage.js` (now IndexedDB) so the backend can later
  be swapped for the File System Access API or a sync server without touching the
  rest of the app. Reads are synchronous off an in-memory `Map` for a snappy UI;
  writes go through a coalescing, serialized queue so keystroke-rate saves never
  race or block the editor.
- Current-note durability remains higher priority than optional history. Revision
  capture starts only after the matching note snapshot commits; a history/quota
  failure reports degraded recovery separately and never relabels a failed note
  write as saved. Destructive revision restore first commits a `pre_restore`
  safety record, while portable restore verifies and previews the full replacement
  before one storage batch updates memory.
