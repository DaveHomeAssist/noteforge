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

## Upgrading from an earlier NoteForge

The first time this version opens, it moves your notes into per-note storage
automatically. The notes, settings and schema an earlier version saved are copied
exactly and left untouched in their original place, and a copy of both original
stores is kept for recovery. If the original data cannot be read or uses a format
this version does not understand, NoteForge opens the read-only recovery reader
instead and writes nothing.

A notice then asks you to close NoteForge tabs that were opened before the update.
An older tab keeps working until it is closed, but its saves no longer change your
notes. Anything it saves appears under **Changes need review**, labelled as saved in
an older NoteForge window after the update. For each one you can compare it with
the saved note, keep the saved version, save it as a copy, or replace the saved note
with it. A note deleted in an older tab is never deleted for you: you can keep it or
delete it yourself. Settings changed in an older tab are kept in the recovery archive
and are not applied. Two older tabs can still overwrite each other before NoteForge
notices, as they always could; the last version they saved is kept for review.

The GitHub Pages mirror and systembydave.com keep separate browser storage. Each
upgrades on its own the first time you open it.

## Storage support

| Environment | Current notes | Revisions | Local snapshots | Portable backup |
| --- | --- | --- | --- | --- |
| IndexedDB available | Yes | Yes | Yes | Yes |
| No IndexedDB (`localStorage` only) | Read only: the recovery reader shows and exports saved notes; editing is off | Unavailable | Unavailable | Yes, for supported saved data |
| Storage quota pressure | Current-note writes remain priority | Pauses before reserve is consumed | Pauses before reserve is consumed | Download remains available while the current vault can be read |

Backup center reports the active backend, quota estimate when the browser exposes
one, last current-note persistence, last revision capture, last local snapshot,
last verified downloaded backup, queued current-note writes, and any degraded
recovery state separately. Quota-paused optional history remains intact but is
unavailable until storage has room and history is resumed or the app reloads.
