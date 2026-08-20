# Recovery and backups

NoteForge provides three deliberately different recovery layers.

## Revision history

Open the current note, then choose **⋯ → Revision history**. Revisions are captured
after a successful durable edit, not on each keystroke. Content and metadata are
stored once by SHA-256 and referenced by immutable records. The default retention
is 50 revisions per note and 90 days; the newest revision is always retained.

**Restore revision** shows the exact content and metadata changes, asks for explicit
confirmation, and commits a `pre_restore` safety revision before changing the note.
It keeps the note ID and creation date. **Restore as copy** creates a new top-level,
live note with a unique title and leaves the original untouched.

## Local snapshots

Backup center creates at most one successful daily snapshot per UTC day and one
weekly snapshot per UTC Monday-start week. It retains seven daily and four weekly
snapshots. Snapshots include every live and trashed note, raw settings, stable IDs,
and the vault schema. They share content-addressed blobs with revision history.
Automatic capture is attempted after each app launch when recovery initializes;
Backup center can also create the current daily snapshot on demand. A tab left open
across a UTC day or week boundary does not run a continuous snapshot timer.

Permanently deleting a note from Trash removes its local revision history and any
local snapshot containing it after the authoritative vault deletion succeeds.
Startup reconciliation completes cleanup interrupted by a closed tab or transient
storage failure. A separately downloaded portable backup is unaffected.

Revisions and local snapshots live in the same browser storage as the vault. They
may be evicted or lost when site data is cleared, so they are not portable backups.

## Portable JSON backup

Choose **⋯ → Backup center → Download JSON backup**. Before download, NoteForge:

1. Includes all live and trashed notes, exact Markdown, metadata, settings, IDs,
   and schema version in a versioned envelope.
2. Computes and verifies a SHA-256 integrity digest.
3. Downloads deterministic JSON suitable for independent storage.

To restore, choose the JSON file, select **Verify backup**, and then **Restore
preview**. NoteForge rejects malformed data, duplicate IDs, unsupported future
formats/schemas, digest mismatches, and note metadata the application cannot apply
exactly before presenting a plan. The plan lists added, updated, removed, unchanged,
live, and trashed notes. Restore requires a second explicit confirmation and creates
a pre-restore portable safety download before atomically replacing the current vault.

Keep downloaded backups somewhere independent of the browser profile and test a
representative backup periodically with **Verify backup**.

## Storage support

| Environment | Current notes | Revisions | Local snapshots | Portable backup |
| --- | --- | --- | --- | --- |
| IndexedDB available | Yes | Yes | Yes | Yes |
| `localStorage` fallback | Yes, within browser quota | Unavailable | Unavailable | Yes |
| Storage quota pressure | Current-note writes remain priority | Pauses before reserve is consumed | Pauses before reserve is consumed | Download remains available while the current vault can be read |

Backup center reports the active backend, quota estimate when the browser exposes
one, last current-note persistence, last revision capture, last local snapshot,
last verified downloaded backup, queued current-note writes, and any degraded
recovery state separately. Quota-paused optional history remains intact but is
unavailable until storage has room and history is resumed or the app reloads.
