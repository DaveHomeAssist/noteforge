# NoteForge release checklist

This checklist separates local code proof, NoteForge CI/mirror deployment, System by Dave synchronization, canonical deployment, and live interaction proof. A successful command, HTTP 200, or matching source tree is not a substitute for the later surfaces.

## 1. Establish source authority

Use an isolated clean worktree when the primary checkout contains user changes. Never stage, discard, or infer ownership of those changes.

```bash
export NF_REPO=/absolute/path/to/clean/noteforge/worktree
cd "$NF_REPO"
git fetch --prune origin
git status --porcelain=v1
git rev-parse HEAD
git rev-parse origin/main
git remote -v
gh auth status
```

Required before editing:

- Full porcelain output is empty, including untracked files.
- The worktree descends from the fetched `origin/main`; record the 40-character starting SHA.
- The remote is `DaveHomeAssist/noteforge`.
- Node/npm are invoked from the Node 22 toolchain. The default shell runtime does not count if it is another major.
- The System by Dave checkout is inspected read-only. Synchronization waits until the NoteForge exact-SHA workflow is green.

## 2. Gate every NoteForge phase locally

```bash
cd "$NF_REPO"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
npm ci
npm run test:all          # check, typecheck, unit, browser (features + smokes), a11y, build, budget
npm audit --audit-level=high
git diff --check
```

Required results:

- Node cases meet or exceed the floor in `test/run-node-tests.mjs` with zero failures.
- The in-page suite meets or exceeds the floor in `test/e2e/features.spec.mjs`, all eight smokes pass, and no test reports an unexpected `console.error`, `pageerror`, failed request, or HTTP 4xx/5xx.
- The axe ratchet passes; if a count dropped, the lowered `test/e2e/a11y-baseline.json` is committed.
- Screenshot baselines are compared by the CI `visual` job only (pinned Playwright container). An intended UI change regenerates them with `gh workflow run visual-baselines.yml --ref <branch>`, then `gh run download <id> -n visual-baselines -D test/e2e/__screenshots__`; review every changed image before committing.
- Local runs may use an installed Chrome (`PW_CHANNEL=chrome`) when reported. CI runs Playwright's Chromium.
- The build completes without unexplained warnings.
- Audit reports no high or critical vulnerability.
- Schema fixture migrations, Markdown fixed points, backup envelopes, accessibility regression checks, and the feature row's explicit exit criteria pass.
- Working tree contains only intended reviewable changes; generated files are inspected.

Inspect production artifacts:

```bash
test -f dist/index.html
test -f dist/sw.js
test -f dist/manifest.webmanifest
! rg -n '__BUILD_HASH__' dist/sw.js
! rg -n '__PRECACHE_ASSETS__' dist/sw.js
rg -n "const CACHE = 'noteforge-[0-9a-f]{12}'" dist/sw.js
rg -n 'Content-Security-Policy|https://systembydave.com/noteforge/' dist/index.html
rg -n "noteforge-build content=$(git rev-parse --short=12 HEAD)" dist/index.html
find dist -maxdepth 2 -type f -print0 | sort -z | xargs -0 wc -c
```

- `npm run test:budget` passes: every route in `test/bundle-budgets.json` is within its gzip budget, or the PR raises it with a budget-log row in `performance_budgets.md`.
- The effective production CSP is meta-delivered by Vite; do not falsely require a Pages response header or `frame-ancestors` from the meta policy.
- Service-worker activation deletes stale `noteforge-*` caches only. The executable sentinel-cache regression must pass.

## 3. Review, commit, and push the phase

- Review the complete diff for accidental formatting churn, secrets, fixture realism, migration reversibility, and documentation/count drift.
- Re-run the smallest affected test after the final edit, then the full local gates.
- Commit only the intended phase slice and push its focused branch immediately.
- Pull requests run the full `verify` job (install, audit, Node tests, Playwright Chromium browser tests, and build) without uploading or deploying Pages. Require that check when a PR is used; local gates and diff review still precede every push.
- Merge only a releasable phase. After merge, fetch and verify local/fetched/remote `main` resolve to the same 40-character SHA.
- For the durable-write migration (option C, NF-DUR-MIG-01, Dave 2026-10-04), synthetic activation and module tests are not release acceptance. Require the actual 7114047 build against the candidate on disposable origins: a legacy tab open across activation and saving through IndexedDB, the localStorage fallback, a BFCache-restored legacy page, a legacy client loaded after activation, interruption before and after the marker, quota failure, a pending legacy draft, the two-legacy-window residual, backup/reopen/restore, and instrumented proof that the candidate never writes legacy current state. If any acknowledged legacy save goes uncaptured, keep activation disabled, preserve the evidence and bring the counterexample to Dave. Track evidence in `durable_writes.md`.

## 4. Prove exact-SHA NoteForge CI and mirror deployment

After the reviewed phase is on NoteForge `main`:

```bash
cd "$NF_REPO"
git fetch --prune origin
export NF_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain=v1)"
test "$NF_SHA" = "$(git rev-parse origin/main)"
test "$NF_SHA" = "$(git ls-remote origin refs/heads/main | awk '{print $1}')"
export NF_RUN_ID="$(gh run list --repo DaveHomeAssist/noteforge --workflow deploy.yml --branch main --event push --commit "$NF_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$NF_RUN_ID"
gh run watch "$NF_RUN_ID" --repo DaveHomeAssist/noteforge --exit-status
gh run view "$NF_RUN_ID" --repo DaveHomeAssist/noteforge --json headSha,status,conclusion,url,jobs
test "$(gh run view "$NF_RUN_ID" --repo DaveHomeAssist/noteforge --json headSha --jq .headSha)" = "$NF_SHA"
test "$(gh run view "$NF_RUN_ID" --repo DaveHomeAssist/noteforge --json conclusion --jq .conclusion)" = success
```

The workflow must use Node 22, run dependency audit, Node tests, installed Playwright Chromium browser tests, build, and Pages deployment. Record the run URL and exact head SHA. Do not synchronize System by Dave from a merely local or branch build.

## 5. Synchronize the canonical System by Dave source

Since 2026-09-25 this section runs itself: the `deploy` job of `deploy.yml` sends a `noteforge-release` `repository_dispatch` to `DaveHomeAssist/system-by-dave` (repository secret `SYSTEM_BY_DAVE_DISPATCH_TOKEN`), whose `.github/workflows/noteforge-sync.yml` builds the exact SHA under Node 22, runs the commands below, commits `noteforge: sync to <sha>` to its `main`, and deploys. Its nightly `noteforge-drift.yml` fails when the canonical provenance or the live `noteforge-build` stamp lags NoteForge `main`. Use the manual steps only when the automation is unavailable, or to re-sync or roll back by hand: `gh workflow run noteforge-sync.yml --repo DaveHomeAssist/system-by-dave -f sha=<40-character sha>`.

System by Dave has a separate Node 24 contract. Stop if its primary checkout is dirty, has untracked files, is behind/diverged, or no longer matches remote `main`.

```bash
export SBD_REPO=/Users/daverobertson/Code/system-by-dave
cd "$SBD_REPO"
git fetch --prune origin
test -z "$(git status --porcelain=v1)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "$(git ls-remote origin refs/heads/main | awk '{print $1}')"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
npm ci
npm run sync:noteforge -- --source "$NF_REPO/dist" --source-commit "$NF_SHA"
npm run verify:noteforge
npm run sync:noteforge -- --source "$NF_REPO/dist" --source-commit "$NF_SHA"
```

The second sync must report `changed=0 deleted=0` and leave no additional diff. Confirm provenance directly:

```bash
NF_SHA="$NF_SHA" node -e "const p=require('./noteforge/source_provenance.json'); if(p.sourceCommit!==process.env.NF_SHA) process.exit(1)"
```

Run every repository gate under Node 24:

```bash
npm run verify:av
npm run verify:gear-reference
npm run verify:indexing
npm run verify:portfolio-schemas
npm run verify:public-navigation
npm run verify:throwline
npm run verify:noteforge
npm run typecheck:av-workbook
npm run test:av-workbook
npm run build:av-workbook
npm audit --audit-level=high
python3 scripts/gen_sitemap.py
git diff --check
```

After staging only intended canonical artifacts, regenerate and require no unstaged drift:

```bash
npm run build:av-workbook
python3 scripts/gen_sitemap.py
git diff --exit-code -- av-workbook sitemap.xml
git diff --cached --check
```

Canonical `index.html` intentionally differs from the mirror because synchronization injects the breadcrumb, public navigation, and shell offsets. All provenance-declared non-index artifacts must remain byte-identical to the reviewed NoteForge build.

## 6. Commit, push, and prove exact-SHA canonical CI

- Review the System by Dave diff for unrelated files and generated-file churn.
- Commit/push the intended synchronization and verification changes.
- Verify local `HEAD`, fetched `origin/main`, and remote `refs/heads/main` are the same 40-character SHA.
- Locate/watch the exact commit in repository `DaveHomeAssist/system-by-dave`, workflow `deploy-pages.yml`, and require `headSha` match plus `conclusion=success` before any live claim.
- Record the run URL. System CI must use Node 24 and pass all repository verification groups listed above.

## 7. Verify mirror and canonical live state

Poll with cache-busting query parameters until deployment convergence; workflow success alone is insufficient.

Required source/provenance checks:

- `https://davehomeassist.github.io/noteforge/` and `https://systembydave.com/noteforge/` return HTTP 200.
- Live `source_provenance.json.sourceCommit` on the canonical route equals `NF_SHA`.
- The `<meta name=noteforge-build>` stamp on both surfaces is a prefix of `NF_SHA`: `curl -s https://systembydave.com/noteforge/ | rg -o 'noteforge-build content=[0-9a-f]+'`.
- Every canonical artifact declared by provenance hashes to its declared value.
- Every declared non-index artifact matches local `dist/` and the mirror byte-for-byte.
- Mirror `index.html` matches local `dist/index.html`; canonical `index.html` matches its provenance hash and contains exactly one breadcrumb, navigation stylesheet/script, shell style, canonical URL, manifest, and effective meta CSP.
- The System sitemap contains `https://systembydave.com/noteforge/`.

Required disposable-profile checks on both surfaces:

- Desktop and 390×844 layouts have no overlap, clipped action, or horizontal overflow.
- Collect `console.error`, `pageerror`, failed request, and HTTP 4xx/5xx; require zero unexpected entries.
- Exercise representative acceptance flows for every feature completed by the release, including migration and backup restore with sanitized fixtures.
- Wait for `navigator.serviceWorker.ready`, warm the shell, go offline, and reload successfully.
- Before first activation, create an unrelated sentinel Cache Storage entry. After activation it must still exist, while exactly one key matches `/^noteforge-/`.
- For update proof, reuse a disposable pre-deploy profile, call `registration.update()`, verify the active worker/cache changes, and verify only the previous NoteForge cache is removed. A fresh-profile install alone is not update proof.
- Verify an existing-profile schema-v3 vault retains IDs, Markdown, images, tags, banners, hierarchy, Trash, and settings after the worker/app update.

## 8. Close the release

- Both repositories are clean and aligned with remote `main`.
- Completion report lists exact source SHAs, workflow run URLs, local gates, live provenance/hash results, desktop/390 px/offline/service-worker results, and completed/failed/skipped/follow-up items.
- Any unavailable source is Grey/unverified, a confirmed failure is Red, and unclear evidence is marked explicitly. Never call the program complete while a feature row, migration, deployment, or live proof is missing.
