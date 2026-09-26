# Changelog

All notable changes to NoteForge are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are git tags
on `main` and the live surfaces (systembydave.com/noteforge, the GitHub Pages
mirror) carry the deployed commit in `<meta name="noteforge-build">`.

## [Unreleased]

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
