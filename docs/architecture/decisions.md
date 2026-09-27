# Architecture and process decisions

One row per decision that changes how NoteForge is built, tested, or released.
Newest first. The roadmap's decision points (docs/roadmap/NOTEFORGE_2_ROADMAP.md §6)
are recorded here when they are taken.

| Date | Decision | Why | Revisit when |
| --- | --- | --- | --- |
| 2026-09-27 | Releases are cut by a `release` job on `main`: when `package.json` names a version with no tag, the job tags the deployed commit and publishes a GitHub Release from that version's CHANGELOG section. release-please and Conventional Commits are not adopted. | release-please needs GitHub Actions to open pull requests, which this repository does not allow; the version-bump job needs only `contents: write`. Without release-please, Conventional Commits would only change commit style for every agent. | Actions may open pull requests here, or releases become frequent enough that hand-written CHANGELOG sections lag. |
| 2026-09-27 | Budget policy v2: per-route gzip budgets in `test/bundle-budgets.json`, measured from Vite's build manifest, replace the raw 257,180-byte initial-shell ceiling. | Users download compressed bytes; one raw ceiling had 158 B of headroom and blocked a dependency update without saying which experience it cost. | A route needs a raise (budget log in performance_budgets.md). |
| 2026-09-27 | Browser tests run under Playwright Test with a fixed, forward-running clock (2026-09-16 11:00 America/New_York). | Retries, traces, and per-smoke reports; date fixtures had already broken CI once. The fixed clock exposed a tab-close race the real clock hid. | A test needs real time (set NOTEFORGE_E2E_REAL_CLOCK=1 to compare). |
| 2026-09-27 | Screenshot baselines are compared only inside `mcr.microsoft.com/playwright` at the lockfile's version. | Font rasterization differs by OS; one pinned image makes baselines exact. | Playwright is bumped: regenerate with the Visual baselines workflow. |
| 2026-09-27 | Accessibility is gated by an axe ratchet (`test/e2e/a11y-baseline.json`) rather than zero violations. | 85 known violating nodes predate the design system; a ratchet stops regressions now and Phase 1 takes the count to zero. | Phase 1 exit (axe clean): delete the baseline and require zero. |
| 2026-09-26 | Biome for lint and format; `node --test` for unit tests; canonical sync Option A (dispatch). | Roadmap §6 recommendations, taken in Phase 0 Sprint 2 and the 2026-09-25 sync work. | See roadmap §6. |
