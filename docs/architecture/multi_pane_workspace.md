# Tabs and two-pane workspace state

Status: implemented and verified in Phase 6

## Context

The current App and Editor have one `currentId` and one mutable editor instance. Tabs and split view must not create simultaneous writers that race through the persistence queue or duplicate navigation history.

## Decision

### Persisted state

Workspace config is versioned independently inside the application config and contains only layout/navigation data:

```js
{
  version: 1,
  activePane: 'primary',
  panes: {
    primary: { tabs: [noteId], activeNoteId, scrollTop },
    secondary: { tabs: [noteId], activeNoteId, scrollTop },
  },
  split: { enabled, ratio },
  recentlyClosed: [noteId],
}
```

- Note IDs are unique across both tab arrays. A note can have only one editable owner.
- At most 20 open tab IDs and 10 recently closed IDs persist. Invalid, duplicate, trashed, or purged IDs are removed during normalization; archived IDs remain only when explicitly opened.
- `ratio` clamps to 0.25–0.75. Scroll positions are finite non-negative numbers and are restored only after their note renders.
- Content, undo stacks, selection, composition state, and unsaved text are never stored in workspace config.

### Single-writer handoff

- Switching tabs/panes, moving a tab, closing an editor owner, collapsing split view, or navigating away flushes the outgoing editor and waits for database durability before ownership changes.
- Opening a note already present in the other pane focuses its existing tab. “Move to other pane” transfers ownership after flush; it never creates a second editor for the same note.
- Background database emits do not rebuild an editor with unsaved input. The existing caret/composition guards become per-editor-owner contracts.
- A failed flush leaves the current owner visible, blocks the handoff, and announces the persistence problem.

### Navigation integration

Every open action goes through one navigation reducer with an origin flag (`user`, `back`, `forward`, `restore`, `reload`, or `programmatic`). Back/forward and persisted recents operate on note IDs and never add duplicate entries during replay. Pane/tab activation reuses this reducer rather than building a second history model.

### Responsive and accessible behavior

- Desktop may show two panes. Below the existing 760 px breakpoint, the UI presents one pane at a time without deleting the secondary tabs or state; a labelled control switches panes. Returning to desktop restores the split.
- Tab lists implement WAI-ARIA tabs: one tab stop, Left/Right arrows within a list, Enter/Space activation when manual activation is used, Delete/close with an accessible alternative, and clear selected/unsaved state.
- Drag reorder/move always has keyboard commands. The splitter is a focusable `separator` with value/min/max and Arrow-key resizing. Reduced motion disables pane/tab transition animation.
- Closing the active tab focuses the nearest remaining tab; closing the last tab focuses the New note action or valid empty state.

## Verification contract

- State normalization for duplicates, missing/Trash/Archive IDs, bounds, corrupt versions, and reload.
- Two-editor autosave race tests, same-note ownership prevention, failed-flush handoff, tab close/reopen/reorder/move, history deduplication, and independent scroll restore.
- WAI tab/splitter keyboard behavior, focus after close, screen-reader labels/states, reduced motion, 200% zoom, and mobile collapse/restore below 760 px.

## Consequences

The global uniqueness rule avoids concurrent edits to one note and lets the existing serialized database queue remain the durability authority. Mobile collapse changes presentation only, so responsive transitions cannot discard work or layout state.
