# Revision history and backup recovery

Status: accepted Phase 0 decision

## Context

NoteForge currently persists complete note snapshots through one coalesced write queue. Rename rewrites, bulk replacement, frontmatter migration, and folder reconciliation need recovery points, but capturing every keystroke would waste quota and could compete with current-note durability. Local history must also never be described as a portable backup.

The IndexedDB identity remains `my-notes-app`, object store `kv`, and database version `1` unless an IndexedDB object-store migration is separately justified. Revision data uses new keys inside the existing store.

## Decision

### Records and content addressing

A revision record is immutable and contains:

```js
{
  id,
  noteId,
  createdAt,
  reason,
  contentHash,
  metadataHash,
  parentRevisionId,
  schemaVersion,
}
```

- `reason` is one of `autosave`, `pre_import`, `pre_reconcile`, `pre_bulk_replace`, `pre_rename`, `pre_restore`, or `manual`.
- `contentHash` is SHA-256 over the exact UTF-8 Markdown bytes.
- `metadataHash` is SHA-256 over canonical JSON containing every authoritative note field except `content`. Keys use a fixed order; arrays retain user order.
- Content and metadata blobs are stored once under namespaced content-addressed keys. Revision records reference them and never duplicate large image-bearing Markdown when hashes match.
- Per-note revision indexes are derived from immutable records and may be rebuilt. A failed index update cannot make the underlying record unreachable to recovery tooling.

`storage.js` will add namespaced enumeration and atomic batched operations. A revision boundary that protects a destructive operation must commit its blobs, record, and index before the destructive note batch begins.

### Capture boundaries

- Normal editing captures after a completed durable autosave, not on input or debounce scheduling. Identical content and metadata do not create a new record.
- Import, reconciliation, vault-wide replacement, rename rewriting, and restore capture the affected current states before mutation.
- A restore first creates and durably commits a `pre_restore` safety revision of the current note. Only then may it apply the selected revision.
- Current-note persistence remains higher priority than optional history. A history failure reports degraded recovery but does not report the current note as saved unless the current-note write itself succeeded.

### Retention and quota

- Defaults are 50 revisions per note and 90 days. The newest revision is always retained; age pruning runs before count pruning.
- Safe configurable ranges are 10–200 revisions and 7–365 days. Invalid settings normalize to the defaults.
- After record pruning, unreferenced content/metadata blobs are garbage-collected in bounded batches. Garbage collection is retryable and never deletes a blob with a live reference.
- Rolling local vault snapshots retain at most 7 successful daily and 4 successful weekly snapshots and reuse the same content-addressed blobs.
- When quota information is available, optional history pauses before it threatens current-note persistence. The UI reports the pause and offers portable backup actions.
- IndexedDB-unavailable/localStorage fallback exposes history and local snapshots as unavailable. It does not attempt large revision writes in localStorage.

### Restore behavior

- **Restore** keeps the note ID and `createdAt`, applies the selected content and restorable metadata, clears neither Trash nor Archive implicitly, and sets `updatedAt` to the restore time. The user previews the exact fields that will change.
- **Restore as Copy** creates a new live top-level note with a new ID, the selected content/metadata, a non-colliding title ending in ` (restored copy)`, fresh timestamps, and no Trash marker. The original note is untouched.
- A malformed or incomplete revision is rejected before any note write. Unknown future revision schema versions are not downgraded or relabeled.

### User-facing language

- **Revision history** and **local snapshot** are browser-local recovery aids and may be evicted with site data.
- **Downloaded JSON backup** is the portable, device-independent artifact.
- Storage health shows backend, last current-note persistence, last revision capture, last local snapshot, last verified downloaded backup, quota where available, and any degraded state separately.

## Verification contract

- SHA-256 deduplication across notes, revisions, and snapshots.
- Capture only after durable autosave and before every destructive boundary.
- Per-note age/count retention, blob reference safety, bounded garbage collection, and quota failure.
- Restore safety revision, exact preview, restore-as-copy isolation, malformed/future record rejection, and serialized queue ordering.
- IndexedDB fallback status, keyboard/focus behavior, 390 px layout, large data-URL Markdown, and language that never equates local history with a downloaded backup.

## Consequences

This adds storage/index complexity but gives later multi-note mutations a common rollback boundary. Content addressing and hard retention bounds prevent history from growing without limit. Recovery is visibly reduced when durable IndexedDB is unavailable rather than silently pretending to work.
