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

## Build budget

The initial shell is the uncompressed `index.html` plus the CSS and JavaScript files it references directly. Hashes and source maps do not affect the calculation.

- Baseline: 214,316 bytes.
- Hard ceiling without an approved exception: 257,180 bytes (+20%, rounded up).
- Diagnostic per-artifact ceilings: HTML 8,500 bytes, CSS 31,493 bytes, JavaScript 217,187 bytes. The total ceiling is authoritative; a justified shift between CSS and JavaScript is allowed.
- Every phase records exact `wc -c` values after `npm run build` and compares the total with this baseline.
- A dependency addition must also record license, installed version, audit result, CSP impact, and its contribution to production output.

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
- Navigation history retains 100 entries per session. Persisted recents retain 50 unique live note IDs.
- Workspace persistence retains at most 20 open tab IDs. Mobile collapse does not duplicate pane/editor state.
- Transclusion renders to a maximum depth of 5 and tracks visited note/fragment references to terminate cycles.

## Gate policy

A budget breach blocks phase release unless the repository maintainer approves a written exception that includes the measured regression, user impact, mitigation, and follow-up owner. Correctness, data preservation, accessibility, and current-note durability take precedence over retaining optional history or caches.
