# Changelog

All notable changes to NoteForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are git tags
on `main` and the live surfaces (systembydave.com/noteforge, the GitHub Pages
mirror) carry the deployed commit in `<meta name="noteforge-build">`.

## [Unreleased]

### Added
- Design tokens (`src/styles/tokens.css`): primitive scales, semantic light and dark colors with text-on-accent and text-on-danger pairs, spacing, type, radius, elevation, motion, layers, and target sizes.
- In-app confirmation dialog and notices (`src/ui/dialogs.js`) in place of the browser's blocking `alert()` and `confirm()`; permanent deletes are styled as destructive and focus Cancel first.
- Undo for moving a note to Trash, in the notice that confirms it.
- Alt+Shift+M moves the focused workspace tab to the other pane.
- Labelled Close and Move buttons for the active workspace tab in the workspace toolbar, reachable by touch screen readers.
- App shell icon rail: sidebar toggle, search, Quick Capture, tasks, calendar, graph, theme, and settings in a left column; on phones the same rail is a bottom bar of 44 px targets.
- The notes sidebar collapses (rail button or Ctrl/⌘+\\) and resizes from 240 to 480 px by dragging or with the arrow keys; both are remembered.
- Wide editors show a context column beside the text with the outline, backlinks, and unlinked mentions; each editor decides by its own width, so split panes and phones keep one column.
- The More actions menu is grouped into Create, Views, Knowledge, Data, and App, with separators and a shortcut hint for Today's note. It works from the keyboard: arrow keys, Home, End, and first letters move between items; Escape closes it and returns focus to its button.
- The slash menu groups block types under Text, Lists, and Insert, with an icon for each. Screen readers hear it as a list of options controlled by the block being typed in, with the active option announced as it changes.
- Alt+Shift+↑ and Alt+Shift+↓ move the current block up or down, keeping the caret; the move can be undone.
- A block action menu opens from a block's drag handle or with Ctrl/⌘+/: Turn into…, Duplicate (without the block's link ID), Move up, Move down, and Delete, all keyboard-operable and undoable.
- The command palette groups results under Recent, Notes, Commands, and Headings (the best match's group first), shows each command's keyboard shortcut as keys, and on screens 1024 px and wider previews the highlighted note or command beside the list.
- On tablets (761–1023 px) the notes sidebar floats over the editor from the rail instead of squeezing it. It starts closed and closes after you pick a note, press Escape, or tap the editor; tablet toggles do not change the desktop collapse setting.
- Tasks, Calendar, Archive, and Trash open in the main area in place of the editor, as the graph does, instead of in dialogs. Their rail buttons show which view is active; pressing one again, Escape, Close, or opening a note returns to the editor. Global shortcuts keep working while they are shown.

### Changed
- Dialogs, the command palette, the More actions menu, and the slash menu fade in over 120–180 ms, and the phone sidebar slides on the same motion tokens; with reduced motion requested, they appear at once.
- Callout headers, the note tree's expand/collapse buttons, and the notice close button use icons instead of emoji and "▸", "▾", and "×" characters. The accessibility gate now also rejects those characters in controls, and it scans notices.
- Heading results in the command palette use heading icons instead of "H1"–"H6" text.
- The block gutter's insert and drag handles are icons with accessible names instead of "+" and "⋮⋮" characters.
- Every text and background color pair meets WCAG AA contrast in both themes; the accessibility gate reports zero violations and now fails on any.
- Moving a note to Trash no longer asks first (it is recoverable); emptying the Trash and permanent deletes still confirm.
- Workspace tab close and move buttons are 24 px targets and pointer-only; keyboard users close with Delete and move with Alt+Shift+M.

### Fixed
- A confirmation opened over another dialog left the dialog beneath it interactive, and one Escape closed both; dialogs now stack, only the topmost is interactive, and each Escape closes one.
- Global keyboard shortcuts no longer act behind an open confirmation.
- Destructive and primary buttons keep AA contrast on hover (the destructive hover measured 1.14:1).
- The "Add banner" control no longer fades below AA contrast.
- On phones the workspace toolbar fits on one row and the note title row keeps Properties, Pin, and Delete on screen.
- The More actions menu scrolls instead of running past the bottom of short screens, and its shortcut hints align to the right edge.
- In wide editors an empty note's body was 41 px wide and could not be clicked, and short notes were centered; the text column now fills its width.
- At 768 px the editor had 396 px beside the sidebar and clipped the note title.
- Closing a dialog whose trigger was hidden meanwhile (a closed menu or overlay) now returns focus to a visible control instead of the page.
- Arrowing through the slash menu past its visible height now scrolls the active option into view.

## [1.2.0] - 2026-09-27

Closes Phase 0 of the NoteForge 2 roadmap: every pull request now runs the lint,
format, type, unit, end-to-end, accessibility, screenshot, and size gates the
rewrite will be held to.

### Added
- Playwright Test suite (`playwright.config.mjs`, `test/e2e/`): the in-page feature suite and the eight end-to-end smokes as separate tests, one CI retry, traces and an HTML report for failures.
- A fixed, forward-running test clock (2026-09-16 11:00 America/New_York), so date fixtures and rendered times are identical on every machine.
- Accessibility gate: axe-core scans of 16 surfaces in both themes, held to a ratchet (`test/e2e/a11y-baseline.json`, 85 violating nodes, may only go down).
- Screenshot baselines of the shell, command palette, settings, and Trash in both themes at 390, 1440, and 2560 px, compared in the pinned Playwright container; the `Visual baselines` workflow regenerates them.
- Per-route gzip budgets (`test/bundle-budgets.json`): shell, editor, graph, recovery, retrieval, daily, properties, workspace, settings, and the offline precache, with a raise procedure and budget log in `docs/implementation/performance_budgets.md`.
- A `release` job that tags the deployed commit and publishes a GitHub Release whenever `package.json` names an untagged version.
- Architecture and process decision log (`docs/architecture/decisions.md`).

### Changed
- Sample notes are seeded in a fixed order with Welcome first, and the note list breaks equal timestamps by title, then id, so its order no longer changes between loads.
- The source tree is formatted by Biome; CI runs `biome ci`.
- `marked` 18, Vite 8 (Rolldown), `yaml` 2.9.1, Playwright 1.63.0, `actions/deploy-pages` 5.0.1. Rolldown's runtime and the YAML parser are split into their own chunks, so the Daily route does not load YAML.

### Removed
- `test/run-features.mjs` (replaced by Playwright Test) and the raw 257,180-byte initial-shell ceiling (replaced by per-route budgets).

### Fixed
- A race in the Phase 6 workspace check: pane scroll offsets were set before a tab close finished restoring the next tab's offset.

## [1.1.0] - 2026-09-26

Phase 0 of the NoteForge 2 roadmap: audit quick fixes, release safety, and the
gates the rewrite will be held to.

### Added
- Comprehensive audit and the ten-phase NoteForge 2 roadmap under `docs/audit/` and `docs/roadmap/`.
- Skip link, a real `.sr-only` utility, `aria-current="page"` on the active note row, and accessible names for the title, pin, and delete controls.
- Light theme default with a pre-paint theme boot script (no dark-mode flash), a theme toggle in the mobile bar, per-theme `theme-color`, and `color-scheme`.
- `<meta name="noteforge-build">` build stamp and a release dispatch that keeps the canonical systembydave.com copy in sync with `main`.
- `node --test` runner with a JUnit report and a case floor (`npm test`), Biome lint (`npm run lint`), and a `tsc --checkJs` per-file ratchet (`npm run typecheck`), all run in CI on Node 22 and 24.
- Golden corpus for `parse()`/`serialize()` and browser-rendered `renderMarkdown()` output (`test/golden/`).
- NFM (NoteForge Markdown) spec v1 with an executable conformance corpus (`docs/spec/nfm.md`, `test/fixtures/nfm/`).
- Dependabot configuration (grouped minor/patch, weekly), `.nvmrc`, and `engine-strict`.

### Changed
- Frontmatter aliases are the single alias authority; folder exports record their mappings for reconciliation.
- The initial-shell byte ceiling is computed from `dist/` instead of hand-recorded; command-palette and settings styles load with their lazy modules.
- `dompurify` 3.4.16.

### Fixed
- Forced-colors and high-contrast rules targeted a class that did not exist (`.note-item--active`); they now outline the real active row.
- Screen-reader announcements no longer grow the page below the 100vh shell.
- A newer push to `main` no longer cancels an in-flight `main` deployment.

## [1.0.0] - 2026-08-20

Integrated release of phases 0–7: durable local-first storage with migrations,
revision history and the backup center, link integrity and knowledge
navigation, retrieval lifecycle and bulk workflows, daily capture with tasks and
calendar, properties and precise block references, the multi-pane workspace,
web clipper, and Markdown-folder reconciliation. Safari compatibility recorded.

## Earlier (unversioned, July 2026)

Rename to NoteForge, deployment under `/noteforge`, graph export as SVG, whole
vault export to Obsidian-compatible Markdown, shareable note export, SEO metadata.
