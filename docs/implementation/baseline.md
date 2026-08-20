# Phase 0 baseline

Recorded: 2026-08-19 (America/New_York)

## Source authority and isolation

- Repository: `https://github.com/DaveHomeAssist/noteforge.git`
- Starting commit: `30565783c4643913d1725c09db969e8c7a165c6f`
- `origin/main`: `30565783c4643913d1725c09db969e8c7a165c6f` after `git fetch --prune origin`
- The primary checkout at `/Users/daverobertson/Code/noteforge` had one pre-existing user modification in `date_project_implementation_plan.txt`. It was not changed, staged, or included in this work.
- Baseline and implementation work ran in the clean isolated worktree `/Users/daverobertson/Documents/Codex/2026-08-19/go/work/noteforge_phase0` on `codex/noteforge_phase0`, created directly from the starting commit.
- The canonical integration checkout at `/Users/daverobertson/Code/system-by-dave` was clean and aligned with `origin/main` at `b0bdb7604c435227d8895e86bce0db28efa52cb4`; it remained read-only during this baseline.
- GitHub CLI authentication was available for `DaveHomeAssist` with repository and workflow access.

## Toolchain

The shell default was Node `v25.8.1`, which is outside the supported project baseline. All baseline commands used the Homebrew Node 22 binary by prepending `/opt/homebrew/opt/node@22/bin` to `PATH`.

| Tool | Verified version |
| --- | --- |
| Node.js | `v22.22.1` |
| npm | `10.9.4` |

## Verification results

| Gate | Command | Result |
| --- | --- | --- |
| Deterministic install | `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm ci` | Pass; 20 packages installed, 21 audited, 0 vulnerabilities |
| Node suite | `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test` | Pass; 227 passed, 0 failed |
| Browser suite | `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run test:browser` | Pass; 306 passed, 0 failed |
| Production build | `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build` | Pass; 34 modules transformed |
| Dependency audit | `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm audit --audit-level=high` | Pass; 0 vulnerabilities |

The browser runner could not find Playwright's bundled Chromium and used its documented system Chrome fallback. The run still completed with zero unexpected page, console, request, or HTTP errors. CI installs Playwright Chromium and remains the authoritative bundled-browser gate.

## Build baseline

Exact uncompressed bytes from the clean production build:

| Artifact | Bytes | Vite gzip report |
| --- | ---: | ---: |
| `dist/index.html` | 7,083 | 2.08 kB |
| `dist/assets/index-C0aK3v7O.css` | 26,244 | 5.79 kB |
| `dist/assets/index-ZAQxfTk9.js` | 180,989 | 56.46 kB |
| Initial shell total | 214,316 | n/a |
| Entire `dist/` tree | 219,285 | n/a |

The Phase 0 initial-shell ceiling is 257,180 uncompressed bytes, which is the baseline HTML, CSS, and JavaScript total plus 20%, rounded up. See [performance_budgets.md](performance_budgets.md) for the measurement contract.

## Search baseline

A deterministic 1,000-note corpus was queried with `rankNotes("needle tag:perf", notes)` after 20 warm-up runs, followed by 100 measured runs under Node `v22.22.1`:

- median: 0.098 ms
- p95: 0.179 ms
- maximum: 0.304 ms

This is a pure-query diagnostic, not the full interaction gate. The release budget measures browser input through a settled, accessible result list.

## Baseline conclusion

The verified starting point satisfies the minimum 227 Node and 306 browser assertions and all build/audit gates. The only local caveats are the preserved user modification in the primary checkout, the out-of-contract default Node version, and the documented Chrome fallback used for the local browser run.
