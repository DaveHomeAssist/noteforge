# Component clarity

The six reviewed surfaces repeat commands, hide purpose behind icons and give secondary controls too much space. This increment keeps the current design language and makes notes the primary task.

## Approved slice

1. Group rail destinations and utilities; labels work on hover and keyboard focus.
2. Keep the site breadcrumb compact and subordinate; preserve canonical navigation.
3. Share the desktop tab row with workspace actions; label secondary tab commands in a menu while preserving keyboard alternatives.
4. Remove per-tab move icons, retain close and make selection distinct from focus.
5. Show context-open state consistently, group note actions and move deletion into a note menu. Existing note text is never rewritten; improve only newly loaded sample content.
6. Simplify search with separate shortcut/help, compact empty saved views, list heading/count/sort, explicit bulk selection, and labeled/resettable tag filters.

## Flow and acceptance

Users can search, filter, save and restore views, select notes for bulk actions, navigate tabs, move/close/reopen notes, use split panes and show context without losing drafts or keyboard access. All six surfaces work in light/dark themes, at 375x812, 1440x900, 1440x540 and 3840x900. Documents never scroll at the root. Keyboard focus, accessible names and safe soft-delete/undo remain available.

No new dependencies, data schema, migration or synchronization. Preferences continue through existing storage paths. Risks are focus after menu actions, narrow split panes, virtualized selection and hosted breadcrumb integration. Verify focused flows and existing browser/a11y/regression gates, review screenshots, then merge and verify both published origins.

Verification also covers reload after moving the only open tab: an empty first pane must not retain a second editable owner. Search help overlays without shifting click targets.
