# Workspace, clipper, and folder reconciliation

Phase 6 adds multi-note editing and explicit external-research intake without
changing Markdown authority, the `my-notes-app` IndexedDB database name, or the
portable backup format.

## Tabs and two panes

- Opening a note creates or activates one tab. A note ID can belong to only one
  pane, so the same note never has two editable owners.
- Use **Split view**, the move button on a tab, or drag and drop to arrange two
  panes. `Ctrl+Page Up` and `Ctrl+Page Down` cycle tabs; tab lists also support
  arrow focus, Enter/Space activation, Delete to close, and
  `Alt+Shift+Left/Right` keyboard reorder.
- Every ownership change flushes pending editor input and waits for authoritative
  note durability. A failed write leaves the current owner visible and blocks the
  switch.
- At widths below 760 px only one pane is presented at a time. The hidden pane,
  its tabs, independent scroll position, and split ratio remain in bounded
  workspace config. Content and unsaved editor state are never stored there.
- Workspace config retains at most 20 open tabs and 10 recently closed IDs.
  Missing or trashed IDs are discarded during normalization; corrupt config
  falls back to a valid single-pane state.

## Web clipper

Open **⋯ → Web clipper setup**, then drag **Clip to NoteForge** to the browser's
bookmarks bar or copy its source manually. The bookmarklet sends a bounded page
title, HTTP(S) source URL, selection, or plain page text to Quick Capture.

Nothing is saved on arrival. NoteForge clears the intake query immediately,
opens the normal Quick Capture review, and waits for a destination plus an
explicit **Save capture** action. Incoming HTML remains text until the shared
sanitized Markdown renderer displays it. Title, URL, selection, article, and
intake URL limits are 300, 2,048, 60,000, 100,000, and 8,000 characters. If the
encoded URL is too large, the bookmarklet uses the clipboard when permitted or
shows a manual-copy prompt.

## Reconcile a Markdown folder

Open **⋯ → Reconcile Markdown folder**. Chromium can use the File System Access
directory picker. Other browsers can use the folder-file input when supported or
select multiple `.md` files. These fallback inputs are read-only ingestion; no
browser support path writes back to the selected folder.

The scan accepts at most 1,000 UTF-8 Markdown files of at most 2 MiB each. It is
read-only and produces a deterministic, path-sorted plan:

- **Add** means no reliable existing identity matched.
- **Update** means a stable identity matched and only the selected source changed.
- **Unchanged** means no imported write is needed.
- **Conflict** means identity, path, YAML, Trash, or two-sided-change evidence is
  unsafe or ambiguous. NoteForge does not guess.

Valid leading `noteforge_id` frontmatter is the primary identity. Without it, a
prior path/title mapping must identify exactly one note. Paths are relative and
reject traversal, absolute paths, empty segments, NULs, and duplicate normalized
names. The review renders at most 50 items per page and retains explicit Apply or
Skip decisions while moving between pages. Missing files or notes never imply a
deletion.

## Apply, rollback, and recovery

Apply remains disabled until every Add or Update has an explicit decision. After
confirmation NoteForge:

1. downloads and verifies a complete portable JSON safety backup;
2. re-reads selected files and checks their SHA-256 hashes against the preview;
3. captures pre-change revisions for every updated note;
4. commits the complete selected replacement through the serialized database
   batch; and
5. exposes a content-free completion report with zero-deletion accounting.

If backup, source verification, revision preparation, or atomic persistence
fails, the apply fails closed. A successful partial rerun is safe: stable IDs,
stored mappings, and content hashes turn completed items into Unchanged, while
uncertain state becomes Conflict. To roll back an accepted apply, use Revision
history for an individual update or restore the downloaded portable backup for
the complete pre-apply vault.
