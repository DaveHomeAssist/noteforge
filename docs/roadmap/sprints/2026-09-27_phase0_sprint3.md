# Phase 0 · Sprint 3 — Browser gates, budgets, release (2026-09-26 → 27)

Parent plan: [NoteForge 2 roadmap](../NOTEFORGE_2_ROADMAP.md), Phase 0 "Foundation and release safety".
Previous: [Sprint 2](2026-09-26_phase0_sprint2.md). Go: Dave, 2026-09-26 ("execute the next phase or phases").

## Sprint goal

Close Phase 0: every PR runs Biome (lint and format), tsc, unit, Playwright, axe,
visual, and budget gates; the known flake is fixed; the dependency majors blocked
on the budget land; releases are cut from a version bump.

## Scope and status

| # | Item | 🚦 | Evidence |
|---|---|---|---|
| S3-1 | Biome formatter sweep, `biome ci` in CI | 🟢 | PR #12 (`d6b72ce`). 2-space, single quotes in JS, double in CSS, 120 columns. Production JS byte-identical after hash normalization; shell unchanged at 257,022 B. `.git-blame-ignore-revs` lists the sweep. |
| S3-2 | `@playwright/test` replaces `test/run-features.mjs` | 🟢 | PR #13 (`00ab8f7`). Features spec (443 checks, floor 440) and the eight smokes as separate tests; one CI retry, traces and report on failure; global setup starts one warmed dev server and one production preview. |
| S3-3 | Fixed clock | 🟢 | Every context starts at 2026-09-16 11:00 America/New_York, `en-US`, and runs forward. It exposed a tab-close race in the Phase 6 in-page check (fixed in the test); the 350/250 ms sleeps are polls. |
| S3-4 | axe in CI | 🟢 | `test/e2e/a11y.spec.mjs`: 16 surfaces × both themes at 1440, plus the 390 shell, WCAG 2.2 AA tags, ratchet at 85 violating nodes (color-contrast 67, aria-required-children 10, target-size 8). Phase 1 exit takes it to zero. |
| S3-5 | Visual baselines | 🟢 | 24 screenshots (shell, palette, settings, Trash × 2 themes × 390/1440/2560) compared only in the Playwright image matching the lockfile (`visual` job, required by `verify`). Independent container runs match exactly. `visual-baselines.yml` regenerates. |
| S3-6 | Budget policy v2 | 🟢 | Ten per-route gzip budgets (`test/bundle-budgets.json`) at measured + 10%; policy, raise procedure, and log in `performance_budgets.md`. |
| S3-7 | Dependency majors | 🟢 | `marked` 18 merged (#11, `c64aae5`, +1.7 KiB gzip shell, golden and screenshots identical). Vite 8 (#10) failed the new budget for a real reason, Rolldown pulling the lazy YAML parser into the Daily route; #14 (`81a74d9`) lands it with Rolldown code-splitting groups. System by Dave sync and verify were dry-run against that build. |
| S3-8 | Release automation | 🟢 | `release` job tags and publishes a GitHub Release when `package.json` names an untagged version. Replaces release-please (decision log). |

## Findings

- **The fixed clock and the baselines found three sources of nondeterminism in the product, not just the tests.** Sample notes were seeded in a tight loop, so a millisecond race decided their list order. They are now stamped 1 ms apart in seed order, with Welcome first. The note list had no tie-break for equal timestamps; it now falls back to title, then id. The workspace tab bar appears after idle initialization, so scans and screenshots now wait for it.
- **Mobile menus are off-screen, not hidden.** At 390 px the overflow menu button counts as visible while the sidebar is closed. Test helpers key on the mobile bar's toggle. Phase 1's bottom tab rail removes the pattern.
- **The axe baseline** (`test/e2e/a11y-baseline.json`) is mostly primary buttons (white on `--accent`, 4.07:1 light and 2.9:1 dark), tag chips, active states, and dimmed calendar days. It also covers the workspace tablist's missing `role="tab"` children and 20 px tab close/move targets. All are Phase 1 token and primitive work.
- **The 2560 px shell** keeps a narrow centered column with empty sides (visible in `shell-*-2560.png`). This is WEB-3, and Phase 1 fixes it.

## Phase 0 exit criteria

| Criterion | 🚦 | Evidence |
|---|---|---|
| Canonical and mirror serve identical hashes from an automated sync; drift check green | 🟢 | `noteforge-sync.yml` ran on NoteForge's own dispatch for every main deploy since 2026-09-26 05:48 ET; nightly drift check green. |
| Biome, tsc, unit, Playwright, axe, visual, and budget gates run on every PR | 🟢 | `deploy.yml` `verify (node 22/24)` + `visual` → `verify`. |
| `v1.1.0` exists | 🟢 | Tag on `a8111b3`; `v1.2.0` (this PR, tagged by the new `release` job) closes Phase 0. |
| NFM spec and golden corpus committed | 🟢 | Sprint 2. |
| Accessibility and WEB-1 quick fixes live on both surfaces | 🟢 | Sprint 1 fixes; live stamps match `main`. |

## Hand-offs that need Dave (unchanged from Sprint 2)

- **Branch protection on `main`.** Require the `verify` check, require PRs, linear history, and delete branches on merge. It changes how every agent lands work.
- **Dependabot alerts.** Turn them on in the repository's Code security settings. Version updates already run.
- **Delete the merged remote branches:** `git branch -r --merged origin/main | grep -v 'origin/main' | sed 's#origin/##' | xargs -n1 git push origin --delete`.
