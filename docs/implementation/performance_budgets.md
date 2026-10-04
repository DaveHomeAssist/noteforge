# Performance and storage budgets

These budgets apply to every feature phase. Measurements use Node 22 and the CI browser/machine unless a release report names an approved exception and its owner.

## Interaction budgets

| Surface | Corpus and measurement | Required result |
| --- | --- | --- |
| Search | 1,000 schema-valid notes; time from an input event to the final visible and accessible result count after any scheduled work | p95 under 150 ms over at least 20 representative queries after warm-up |
| Editor input | 500-character typing/composition scenario while autosave, a background database emit, and a note metadata update occur | No dropped/duplicated characters, no unexpected caret or selection movement, no interrupted IME composition, and p95 input-to-DOM reflection under 50 ms |
| Derived views | 1,000 notes with links, tasks, dates, and properties; open and update one note | No full-vault synchronous rebuild on an ordinary keystroke; p95 visible update under 150 ms |
| Long lists | 1,000 results, revisions, tasks, or reconciliation rows | Windowed/virtualized rendering or equivalent bounded DOM; keyboard focus and announcements must remain correct across windows |
| Workspace restore | Maximum supported persisted tabs with a two-pane layout | First usable note appears without waiting for non-active panes; invalid/deleted IDs are discarded without a blocking error |

Search baseline on 2026-08-19: pure `rankNotes()` over 1,000 notes measured 0.098 ms median and 0.179 ms p95 on Node `v22.22.1`. This diagnostic leaves nearly all of the 150 ms interaction budget available for event handling, rendering, and accessibility state updates.

## Build budget (policy v2, from 2026-09-27)

Every route has a gzip budget in `test/bundle-budgets.json`. `npm run test:budget`
(`test/bundle-budget.mjs`) measures a finished `dist/` with Vite's build manifest
(moved to `build-meta/manifest.json`, never deployed) and fails when any route is
over. CI runs it after every build on Node 22 and 24.

- **What a route counts.** `shell` is `index.html` plus every CSS and JavaScript
  file the entry loads before the app is usable. Every other route counts only
  what it adds on top of the shell: its lazy chunks, their static imports, and
  their stylesheets. `precache` is every file the service worker stores for
  offline use. Each file is gzipped at level 9 and the sizes are summed.
- **Why gzip.** Users download compressed bytes; raw bytes over-penalize
  repetitive code and under-penalize dense code. Raw sizes are still printed.
- **Initial budgets.** Measured gzip plus 10%, rounded up to the next KiB, on
  2026-09-27 at `main` plus the Playwright suite (Node 22.22.1, Vite 6.4.3).
  `collections` joins the table when Phase 3 builds it.
- **Adding a lazy feature.** Add its entry modules to an existing route or a new
  one in the same PR. A route entry the build does not contain fails the gate
  (exit 2), so a renamed module cannot silently drop out of a budget.

| Route | Loads | Measured gzip | Budget |
| --- | --- | ---: | ---: |
| shell | first paint | 75,571 B | 83,968 B (82 KiB) |
| editor | outline, backlink index, navigation | 5,389 B | 6,144 B |
| graph | graph view | 3,092 B | 4,096 B |
| recovery | history, backup center, recovery, backup core | 26,160 B | 29,696 B |
| retrieval | palette and its command list, find/replace, saved views, archive, bulk actions, link tools | 24,139 B | 29,696 B (raised 2026-10-01) |
| daily | daily notes, capture, tasks, calendar | 19,629 B | 22,528 B |
| properties | properties view, YAML parser | 43,344 B | 48,128 B |
| workspace | tabs and panes, clipper, folder reconciliation | 24,665 B | 27,648 B |
| settings | settings, Trash | 4,193 B | 5,120 B |
| dialogs | in-app confirm dialog and toasts, on first use | 3,001 B | 4,096 B |
| banner | note banner picker, gradient presets, Reposition (added 2026-10-01) | 2,181 B | 3,072 B |
| conflicts | comparison, draft recovery and resolution (Phase 1 repair) | 6,252 B | 7,168 B |
| storageRecovery | read-only recovery reader before activation | 2,183 B | 3,072 B |
| vaultRefresh | clean-window reconciliation and resume watcher | 2,254 B | 3,072 B |
| precache | everything offline | 220,873 B | 243,712 B |

### Measurements

| Date | Change | shell | daily | properties | precache |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026-09-27 | Budgets set (Vite 6.4.3, marked 15) | 75,571 B | 19,629 B | 43,344 B | 220,873 B |
| 2026-09-27 | marked 18, Vite 8 (Rolldown groups for the runtime and YAML) | 74.1 KiB | 18.5 KiB | 41.1 KiB | 210.9 KiB |
| 2026-10-01 | Before Tier 1 split (`db9971f`) | 82,352 B | 19,631 B | 42,177 B | 230,324 B |
| 2026-10-01 | Tier 1 split: banner picker and palette command list leave the shell | 80,242 B | 19.2 KiB | 41.2 KiB | 232,013 B |
| 2026-10-03 | Conflict recovery checkpoint, not releasable | 84,022 B (54 B over) | 19,633 B | 42,246 B | 243,817 B (105 B over) |
| 2026-10-03 | Window refresh checkpoint, not releasable | 84,735 B (767 B over) | 19.2 KiB | 41.3 KiB | 245,709 B (1,997 B over) |
| 2026-10-03 | Separate per-window session state, not releasable | 85,269 B (1,301 B over) | 19,653 B | 42,259 B | 246,229 B (2,517 B over) |

The session-state change adds no dependencies and does not raise any limit.
Its build remains blocked by the existing shell/precache budgets. It separates
window navigation from the durable write queue; layout storage failure does not
become a note-save failure. Final emitted sizes must be rechecked after the
remaining Phase 1 integration and compatibility work.

The window refresh route uses the same new-route calculation. Existing shell
and precache limits remain unchanged and failing; there is no approved exception.
The following local persistence diagnostics use synthetic 1,000/5,000-note
vaults in Playwright Chromium, Firefox and WebKit on this Mac. Twenty measured
ordinary saves follow five warm-up saves. Timings span Database mutation through
the completed current-write flush; optional history is replaced by a no-op, and
these are not full editor, paint, physical-device or release performance gates.

| Engine | Notes | Save p95 | One clean refresh |
| --- | ---: | ---: | ---: |
| Chromium | 1,000 | 0.3 ms | 10.9 ms |
| Chromium | 5,000 | 0.2 ms | 47.2 ms |
| Firefox | 1,000 | 1 ms | 20 ms |
| Firefox | 5,000 | 1 ms | 84 ms |
| WebKit | 1,000 | 1 ms | 50 ms |
| WebKit | 5,000 | 1 ms | 184 ms |

Each 25-save run wrote the changed note 25 times and made 75 total IDB puts
(note, vault metadata and persistence timestamp), with no cursor scans during
those saves. The separate refresh reads the full vault and rebuilds derived
state. These measurements do not establish constant-time serialization, indexing,
refresh or user interaction. Timer resolution and host load affect short samples.
The maintained scenario is `test/e2e/vault-refresh.spec.mjs`; the reviewed run
completed all 177 durability cases with no failures.

The conflict checkpoint adds two lazy routes using the policy v2 new-route
calculation (measured gzip plus 10%, rounded up to KiB). Existing limits are
unchanged. The optional revision lease now belongs to the recovery route, which
measures 26,349 B against 29,696 B. No dependency was added. The shell remains
54 B over its existing limit; the offline cache is 105 B over. This is
a failed release gate, not an approved exception. Additional Phase 1 work must
address the actual emitted output before release; these intermediate sizes are
not promises of final headroom.

Vite 8 without the Rolldown groups put the YAML parser in the Daily route (49.0 KiB against 22 KiB); the budget gate caught it (PR #14).

### Raising a budget

A budget rises only in a pull request that edits `test/bundle-budgets.json` and
appends a row to the log below with the measured size, the cause, what was tried
first (deferring code to a lazy route, dropping a dependency), and who approved
it. Prefer moving code out of `shell`: a feature that is not needed for first
paint belongs in a lazy route, with its CSS loaded alongside it.

### Budget log

| Date | Route | Old | New | Cause | Approved |
| --- | --- | ---: | ---: | --- | --- |
| 2026-09-27 | all | raw 257,180 B shell ceiling | table above | Policy v2 replaces the raw initial-shell ceiling (roadmap Phase 0) | Dave (roadmap Phase 0, "execute the next phase", 2026-09-26) |
| 2026-09-27 | dialogs (new) | none | 4,096 B | New lazy route for src/ui/dialogs.js (Phase 1 in-app confirm and toasts); measured 3,001 B + 10% | Phase 1 go (2026-09-26) |
| 2026-10-01 | shell | 83,968 B | 83,968 B (held) | No raise. With 1,616 B of headroom left at `db9971f`, the remaining Phase 1 shell work goes behind lazy routes first: this split moves the banner picker and the palette command list out (82,352 to 80,242 B). Slash/link/block menus are the next candidate | Dave, 2026-10-01 (approved holding the shell and splitting first) |
| 2026-10-01 | retrieval | 26,624 B | 29,696 B | The palette command list (`src/app/palette-commands.js`, about 1.6 KB gzip) now loads with the palette instead of the shell; measured 26,849 B + 10% | Dave, 2026-10-01 (same approval) |
| 2026-10-01 | banner (new) | none | 3,072 B | New lazy route for `src/components/banner-picker.js` and its CSS; measured 2,181 B + 10% | Dave, 2026-10-01 (same approval) |

## Build budget history (policy v1, raw initial-shell ceiling, until 2026-09-26)

The initial shell was the uncompressed `index.html` plus the CSS and JavaScript files it references directly. Hashes and source maps do not affect the calculation.

- Baseline: 214,316 bytes.
- Hard ceiling without an approved exception: 257,180 bytes (+20%, rounded up).
- Diagnostic per-artifact ceilings: HTML 8,500 bytes, CSS 31,493 bytes, JavaScript 217,187 bytes. The total ceiling is authoritative; a justified shift between CSS and JavaScript is allowed.
- Every phase recorded exact `wc -c` values after `npm run build` and compared the total with this baseline; from Sprint 2 until policy v2, `test/bundle-budget.mjs` computed the total from `dist/` and failed above the hard ceiling.
- A dependency addition must also record license, installed version, audit result, CSP impact, and its contribution to production output.

Phase 1 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
11,367 bytes + directly referenced CSS 31,795 bytes + directly referenced JavaScript
199,720 bytes = 242,882-byte initial shell, 14,298 bytes below the 257,180-byte
ceiling. The accessible recovery dialog/control markup puts HTML 2,867 bytes above
its diagnostic ceiling, and the responsive recovery styles put CSS 302 bytes above
its diagnostic ceiling. Direct JavaScript remains 17,467 bytes below its diagnostic
ceiling, so the authoritative combined budget remains green without an exception.
Recovery service/store/view/verifier chunks total 69,822 additional bytes;
they are initialized after `app.ready` during idle time or on first recovery use and
are build-time precached for offline first use. Full HTML/CSS/JavaScript output is
312,704 bytes. No dependency was added in this phase.

Phase 2 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
6,353 bytes + directly referenced CSS 31,477 bytes + directly referenced JavaScript
219,249 bytes = 257,079-byte initial shell, 101 bytes below the authoritative
257,180-byte ceiling. JavaScript is 2,062 bytes above its diagnostic ceiling, offset
by HTML being 2,147 bytes below its diagnostic ceiling and CSS being 16 bytes below;
the combined budget remains green without an exception. The production HTML is
minified during the build, and navigation, outline, contextual indexing, Link tools,
and recovery remain genuinely post-usable chunks. Deferred CSS/JavaScript totals
101,990 bytes and is build-time precached for offline first use; full HTML/CSS/
JavaScript output is 359,069 bytes. No dependency was added in this phase.

Phase 3 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
5,094 bytes + directly referenced CSS 31,941 bytes + directly referenced JavaScript
216,300 bytes = 253,335-byte initial shell, 3,845 bytes below the authoritative
257,180-byte ceiling. CSS is 448 bytes above its diagnostic ceiling, offset by HTML
being 3,406 bytes below its diagnostic ceiling and JavaScript being 887 bytes
below; the combined budget remains green without an exception. Archive, saved-view,
find/replace, bulk-action, graph, settings, Trash, Link tools, and recovery UI remain
post-usable chunks and are build-time precached for offline first use. Deferred CSS/
JavaScript plus the service worker total 165,998 bytes; full HTML/CSS/JavaScript
output is 419,333 bytes. No dependency was added in this phase.

Phase 4 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
5,442 bytes + directly referenced CSS 31,941 bytes + directly referenced JavaScript
219,791 bytes = 257,174-byte initial shell, 6 bytes below the authoritative
257,180-byte ceiling. JavaScript is 2,604 bytes and CSS is 448 bytes above their
diagnostic ceilings, offset by HTML being 3,058 bytes below its diagnostic ceiling;
the combined budget remains green without an exception. Daily/capture/task/calendar
orchestration, views, services, date/task parsers, and responsive styles remain
post-usable chunks and are build-time precached for offline first use. The task
dashboard renders at most 50 rows per visible group page, while pure derivation over
1,000 notes remained under 5 ms in repeated final Node 22 checks. Deferred CSS/
JavaScript plus the service worker total 211,450 bytes; full HTML/CSS/JavaScript/
service-worker output is 468,624 bytes. No dependency was added in this phase.

Phase 5 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
5,442 bytes + directly referenced CSS 25,335 bytes + directly referenced JavaScript
223,064 bytes = 253,841-byte initial shell, 3,339 bytes below the authoritative
257,180-byte ceiling. JavaScript is 5,877 bytes above its diagnostic ceiling,
offset by HTML being 3,058 bytes and CSS being 6,158 bytes below their diagnostic
ceilings; the combined budget remains green without an exception. YAML parsing,
the Phase 5 controller, Properties view, and responsive styles remain post-usable
chunks and are build-time precached for offline first use. Their deferred output is
129,122 bytes: `yaml` 104,706, controller 14,702, Properties JavaScript 6,575,
and Properties CSS 3,139. All deferred CSS/JavaScript plus the 5,040-byte service
worker total 352,784 bytes; full HTML/CSS/JavaScript/service-worker output is
606,625 bytes. The exact pinned dependency is `yaml` 2.9.0, ISC licensed with no
runtime dependencies; it is imported only by `src/utils/frontmatter.js`, adds no
CSP origin or directive, and the high-severity audit reports zero vulnerabilities.

Phase 6 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
5,592 bytes + directly referenced CSS 25,335 bytes + directly referenced JavaScript
225,969 bytes = 256,896-byte initial shell, 284 bytes below the authoritative
257,180-byte ceiling. JavaScript is 8,782 bytes above its diagnostic ceiling,
offset by HTML being 2,908 bytes and CSS being 6,158 bytes below their diagnostic
ceilings; the combined budget remains green without an exception. Workspace,
clipper, folder planning/reconciliation, and responsive styles remain post-usable
chunks and are build-time precached for offline first use. Their deferred output
is 59,159 bytes; all deferred CSS/JavaScript plus the 5,293-byte service worker
total 412,451 bytes, and full HTML/CSS/JavaScript/service-worker output is 669,347
bytes. Reconciliation renders at most 50 plan rows per accessible page. No
dependency was added in this phase, and the high-severity audit reports zero
vulnerabilities.

Phase 7 measurement on 2026-08-20 (Node 22.22.1, Vite 6.4.3): `index.html`
5,592 bytes + directly referenced CSS 25,335 bytes + directly referenced JavaScript
226,096 bytes = 257,023-byte initial shell, 157 bytes below the authoritative
257,180-byte ceiling. JavaScript is 8,909 bytes above its diagnostic ceiling,
offset by HTML being 2,908 bytes and CSS being 6,158 bytes below their diagnostic
ceilings; the combined budget remains green without an exception. The deferred
accessibility hardening stylesheet adds forced-colors, increased-contrast, and
reduced-motion rules without increasing the initial CSS. Exact-ID incremental
derived caches prevent ordinary note saves from rebuilding task, calendar, or
property indexes across the 1,000-note corpus; the final Node gate kept the
combined incremental update under 150 ms and the 20-query search p95 under 150 ms.
All deferred CSS/JavaScript plus the 5,348-byte service worker total 415,522 bytes;
full HTML/CSS/JavaScript/service-worker output is 672,545 bytes across 71 files.
No dependency was added in this phase, and the high-severity audit reports zero
vulnerabilities.

WEB-1 theme measurement on 2026-09-25 (Node 25.8.1 locally, Vite 6.4.3):
`index.html` 6,047 bytes + directly referenced CSS 24,199 bytes + directly
referenced JavaScript 226,865 bytes = 257,111-byte initial shell, 69 bytes below
the authoritative 257,180-byte ceiling. JavaScript is 9,678 bytes above its
diagnostic ceiling, offset by HTML being 2,453 bytes and CSS being 7,294 bytes
below theirs; the combined budget remains green without an exception. The shell
gained a hashed single-line pre-paint theme boot script, a mobile top-bar theme
toggle, a `color-scheme` declaration per theme root, theme.js mirror/meta sync,
and (from the canonical-sync work merged the same evening) the 12-character
`noteforge-build` stamp; the production CSP meta is now spliced in unescaped
(about 70 bytes) and six dead rules (the unused segmented control and legacy
textarea editor) left `styles.css`. No dependency was added.

## Revision and backup storage bounds

- Revision bodies and metadata snapshots are content-addressed by SHA-256. Identical content is stored once even when referenced by multiple revision records or rolling snapshots.
- Default revision retention is 50 records per note and 90 days. Both limits are configurable within documented safe ranges; pruning applies the age limit and then the count limit while retaining the newest revision.
- Unreferenced content-addressed blobs are garbage-collected after retention or note purge. Failed garbage collection may be retried but must be visible in storage health diagnostics.
- Rolling local vault snapshots retain at most 7 successful daily snapshots and 4 successful weekly snapshots. They share the content-addressed blob store with revisions.
- Before any history/snapshot write, the storage service checks available quota when supported. It pauses optional history before current-note persistence is endangered and reports the degraded state. It never deletes current notes to make room for history.
- The `localStorage` fallback does not store revision bodies or rolling vault snapshots. The UI reports history as unavailable and continues current-note persistence only.
- A downloaded JSON backup is the only device-independent portable backup in this program. Local revisions and local snapshots must never be labeled as equivalent to a downloaded backup.

## Index and cache bounds

- Backlink, unlinked-mention, task, calendar, property, and recent-note indexes are derived and rebuildable. They are excluded from authoritative JSON backups.
- Derived indexes update incrementally after a durable note save. A full rebuild is allowed at migration/startup or after detected corruption, never on each keystroke.
- Navigation history retains 100 entries per session. Session-persisted recents retain 50 unique live note IDs.
- Per-window session workspace persistence retains at most 20 open tab IDs. Mobile collapse does not duplicate pane/editor state. Neither field is a new shared-vault write.
- Transclusion renders to a maximum depth of 5 and tracks visited note/fragment references to terminate cycles.

## Gate policy

A budget breach blocks phase release unless the repository maintainer approves a written exception that includes the measured regression, user impact, mitigation, and follow-up owner. Correctness, data preservation, accessibility, and current-note durability take precedence over retaining optional history or caches.
