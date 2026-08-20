# Manual folder import and reconciliation

Status: accepted Phase 0 decision

## Context

The existing folder feature writes live notes as Markdown but has no stable external identity, read path, conflict planner, or rollback. Browser directory APIs vary, and title-only matching can merge unrelated files.

## Decision

### Scope and identity

Reconciliation is always user-initiated and one-shot. It is not background watching, two-way sync, or a cloud service.

- A Markdown file with valid leading frontmatter uses immutable `noteforge_id` as its primary identity.
- Without an ID, a normalized relative path plus normalized title may identify exactly one unchanged prior export mapping.
- A title/path heuristic that is missing, duplicated, or inconsistent is a **Conflict**, never an automatic update.
- Relative paths normalize separators and reject absolute paths, `..`, NUL, empty segments, and traversal outside the selected directory. Only selected `.md` files within size/count limits enter the plan.

### Deterministic plan

`src/utils/vault-import.js` is pure and returns stable, sorted items:

```js
{
  key,
  relativePath,
  externalId,
  destinationNoteId,
  status, // Add | Update | Conflict | Unchanged
  sourceHash,
  destinationHash,
  reasons,
}
```

The scan phase reads/decodes source text and metadata but cannot mutate the vault. Repeating a scan over identical folder and vault inputs produces byte-equivalent plan JSON.

- **Add**: no reliable existing identity; proposed new ID/title/path is shown.
- **Update**: stable ID maps to one note and content/approved metadata differ.
- **Unchanged**: stable identity and authoritative hashes match.
- **Conflict**: ambiguous identity, duplicate IDs, simultaneous divergent edits, invalid frontmatter, unsafe path, or unsupported data.

No status implies deletion. Missing external or internal files are reported only; Phase 6 never performs hidden deletes.

### Apply boundary

1. Present source/destination diff and an explicit decision for every Add, Update, or Conflict.
2. Flush the current editor.
3. Create and verify a downloaded portable backup. If download verification cannot complete, do not apply.
4. Commit pre-change revisions for every updated note.
5. Re-read selected file handles and verify source hashes have not changed since planning.
6. Apply confirmed actions through the serialized database batch API. Reject the batch before writing if any identity/hash precondition changed.
7. Emit a completion report with added, updated, unchanged, skipped, conflicted, and failed items. The report is downloadable and contains no note content unless the user explicitly includes it.

Interrupted or failed application is safe to rerun. Stable IDs and content hashes make completed items Unchanged; uncertain partial state becomes Conflict rather than replaying blindly.

### Browser and security boundaries

- Chromium uses the File System Access API for directory handles. Other supported browsers use `<input type="file" webkitdirectory>` or multiple-file selection as a read-only ingestion fallback.
- Unsupported APIs never produce partial writes. The UI explains the available fallback.
- Imported HTML is never trusted. Markdown remains text until the shared sanitized renderer displays it.
- Frontmatter parsing uses the bounded adapter; dangerous URLs, prototype-shaped keys, duplicate IDs, oversized files/payloads, invalid UTF-8, and path traversal produce explicit plan errors.

## Verification contract

- Stable-ID matching before path/title, ambiguity classification, filename collisions, nested folders, unknown frontmatter, path traversal, duplicate IDs, size limits, and deterministic plan ordering.
- Preview-only scan, portable-backup gate, revision gate, stale-source hash rejection, atomic batch behavior, interruption recovery, and repeated-run idempotence.
- Mocked directory API plus file-input fallback, keyboard-operable per-item decisions, focus/progress announcements, and 390 px review layout.

## Consequences

Reconciliation favors explicit conflicts over convenient but unsafe guessing. Requiring a portable backup adds one deliberate step, justified because the operation can touch many locally owned notes.
