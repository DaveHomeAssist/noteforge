# Phase 0 · Sprint 2 — Gates and safety nets (2026-09-26)

Parent plan: [NoteForge 2 roadmap](../NOTEFORGE_2_ROADMAP.md), Phase 0 "Foundation and release safety".
Audit: [2026-09-25 comprehensive audit](../../audit/2026-09-25_comprehensive_audit.md).

## Where Phase 0 stood at sprint start

| Roadmap item | State on `main` at `b18407c` |
|---|---|
| Week-1 quick fixes: `.sr-only`, hardening selectors, `aria-current`, labels, skip link | Done (`2db5af1`) |
| WEB-1: light default, pre-paint theme boot, mobile toggle, `theme-color`, `color-scheme` | Done (`b18407c`) |
| Canonical deploy re-synced; automated `repository_dispatch` sync, nightly drift check, build stamp | Done (`f2a9b79`, System by Dave `68bd522`) |
| `dompurify` 3.4.16, Dependabot config, `.nvmrc`, `engine-strict`, Node 22 + 24 matrix, concurrency fix | Open |
| `node --test` runner with JUnit and a count floor | Open |
| Biome lint + `tsc --checkJs` gates | Open |
| Golden corpus (`renderMarkdown`, `parse`/`serialize`) | Open |
| NFM spec v1 + conformance corpus | Open |
| `CHANGELOG.md`, `v1.1.0` tag, plan doc moved under `docs/implementation/` | Open |
| Branch protection, Dependabot alerts toggle, merged-branch deletion | Open — repository settings and remote deletions, Dave's call |
| `@playwright/test` conversion, axe, visual baselines; budget policy v2; release-please | Open — next sprint |

## Sprint goal

Every push to `main` is checked by lint, type, unit (counted), browser, build, and budget gates on two Node majors, and the parser/renderer behavior that the rewrite must preserve is frozen in executable form.

## Scope and acceptance

| # | Item | Acceptance |
|---|---|---|
| S2-1 | Toolchain pins and CI hardening | `.nvmrc`=22, `.npmrc` `engine-strict=true`, `dompurify` ^3.4.16, `.github/dependabot.yml` (npm + actions, grouped minor/patch, weekly). `verify` runs on Node 22 and 24; a push to `main` never cancels an in-flight `main` run (PR runs still supersede each other); JUnit uploaded as a CI artifact; Pages artifact uploaded from the Node 22 leg only. |
| S2-2 | Node test harness | `npm test` runs `node --test` over `test/*.test.mjs` with spec + JUnit reporters and fails below the case floor in `test/run-node-tests.mjs`. The three legacy assert scripts register each check as a `node:test` case so the count is real (floor 425). |
| S2-3 | Static gates | `npm run lint` = Biome lint over `src/` with zero errors (intentional exceptions documented inline); `npm run typecheck` = `tsc --noEmit --checkJs` over `src/core` and `src/utils` under `jsconfig.json`, gated by a committed error-count ratchet that may only go down. Both run in CI before tests. Formatter deliberately off this sprint (whole-tree churn needs a quiet window). |
| S2-4 | Golden corpus | `test/golden/blocks/*.json` freezes `parse()` shape and `serialize(parse())` for every seed note and schema-v3 fixture note; `test/golden/render/*.html` freezes browser-rendered `renderMarkdown()` HTML for the same sources. Node test and features.html section compare; `node test/golden/update.mjs` regenerates deliberately. |
| S2-5 | NFM spec v1 | `docs/spec/nfm.md` documents today's syntax with implementing file:function per rule; `test/fixtures/nfm/corpus.json` + `test/nfm-conformance.test.mjs` execute it. |
| S2-6 | Release hygiene | `CHANGELOG.md` (Keep a Changelog), version 1.1.0, `date_project_implementation_plan.txt` moved to `docs/implementation/`, README test section updated, annotated tag `v1.1.0` pushed once the release is live on both surfaces. |

## Deferred, with reasons

- **Branch protection on `main`** and **Dependabot alerts**: GitHub settings changes. Branch protection also changes how every agent lands work (PR-only), so it is Dave's decision; the recommended rule set is in the roadmap.
- **Delete the 11 merged remote branches**: remote deletion; list in the sprint report, one command to run.
- **Biome formatter sweep**: touches nearly every file; run in a window with no other session holding the checkout.
- **Budget policy v2 (per-route gzip budgets)**: policy change to the authoritative ceiling in `docs/implementation/performance_budgets.md`; propose, don't slip in.
- **`@playwright/test` conversion, axe, visual baselines, release-please**: next sprint, on top of the JUnit and golden groundwork.

## Execution order

S2-1 → S2-2 → S2-3 → S2-4 → S2-5 → S2-6, each landing green on `npm run test:all` locally and on CI before the next starts.

## Status (closed 2026-09-26)

| Item | 🚦 | Evidence |
|---|---|---|
| S2-1 Toolchain + CI | 🟢 | `.nvmrc`, `.npmrc`, `.github/dependabot.yml`, `dompurify` 3.4.16; `verify (node 22)` and `verify (node 24)` legs; `cancel-in-progress` only for pull requests; JUnit uploaded per leg; Pages artifact from the Node 22 leg. |
| S2-2 Test harness | 🟢 | `npm test` → `test/run-node-tests.mjs`: 541 `node:test` cases (was 115 counted + 3 opaque scripts), floor 520, JUnit at `test-results/junit.xml`. |
| S2-3 Static gates | 🟢 | `npm run lint`: 0 errors, 0 warnings, 1 info over 102 files (36 errors fixed, 3 CSS-only rules disabled with reasons in `biome.jsonc`). `npm run typecheck`: 56 errors across 15 files frozen in `test/typecheck-baseline.json`; any file exceeding its entry fails CI. Formatter off (deferred). |
| S2-4 Golden corpus | 🟢 | 11 sources (4 seed + 7 schema-v3 fixture notes); `test/golden/blocks/` (10 byte-identical round trips, 1 normalizing) checked in Node; `test/golden/render/` captured in Chromium and compared in `test/features.html` (12 checks). `node test/golden/update.mjs` regenerates. |
| S2-5 NFM spec v1 | 🟢 | `docs/spec/nfm.md` (18 sections, every rule cites file:function); `test/fixtures/nfm/corpus.json` 71 cases, all `expect` values machine-generated by `build-corpus.mjs` (regeneration is byte-identical); `test/nfm-conformance.test.mjs` 72 tests. |
| S2-6 Release hygiene | 🟢 | `CHANGELOG.md`, version 1.1.0, plan doc moved, README test section, roadmap pointer. Tag `v1.1.0` is created on the sprint commit after its deploy is verified on both live surfaces. |
| Budget | 🟢 | Lint refactors pushed the shell 243 B over the 257,180 B ceiling; deferring the settings-dialog CSS with its lazy module (as the palette CSS already is) brought it to 257,022 B (158 B below). |

## Findings for later phases (from the NFM and golden work)

- Seven cross-parser inconsistencies are recorded in `docs/spec/nfm.md` §18 (fence grammar differs between `blocks.js` and the index parsers; callouts are editor-render only and leak `[!note]` into exported HTML; block ids on `####`+ headings are never indexed; `blocks.js:parse` is not frontmatter-aware; `removeFrontmatterProperty` of the last key writes `{}`; trailing `#`s and `@date()` validity differ). Phase 2 (record model) and Phase 4 (editor core) must resolve, not inherit, these.
- Not encoded in NFM today: `title`, `tags`, `pinned`, `banner`, `parentId`, `archivedAt`, timestamps. A vault `.md` file is exactly `note.content`. Embeds transclude only the `#^id` form.
- One schema-v3 fixture (`v3-06-recoverable-draft`) does not round-trip byte-for-byte through `parse`/`serialize`; the golden records the normalized form so a future fix is a visible diff, not a silent change.
- Browser flake: "Phase 6 persists independent primary and secondary scroll positions" waits on a real 350 ms timer and failed once in five runs. The fixed-clock injection in the Phase 0 harness item is the fix.

## Hand-offs that need Dave

- **Branch protection** (roadmap: require the `verify` job, require PRs, linear history, delete branch on merge). This changes how every agent lands work; today they push to `main` directly per the workspace rules.
- **Dependabot alerts**: GitHub → Settings → Code security (version updates are configured in-repo).
- **Merged remote branches** (11): `claude/bold-ptolemy-aco6jp`, `codex/noteforge_phase0` … `phase7`, `fix/phase7-calendar-due-date`, `law/build-toward-the-whole`. One command: `git branch -r --merged origin/main | grep -v 'origin/main' | sed 's#origin/##' | xargs -n1 git push origin --delete`.
- **Formatter sweep**: `npx biome format --write src test vite.config.js && npm run test:all`, in a window with no other session holding the checkout, then enable `formatter` in `biome.jsonc` and add `biome ci` to the workflow.
- **Budget policy v2** (per-route gzip budgets replacing the byte ceiling) and **`@playwright/test` + axe + visual baselines**: proposed for Sprint 3.
