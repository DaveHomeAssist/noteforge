# Collapsible note context

User request: hide the right-hand outline, backlinks and unlinked mentions together, reclaim editor space, and remember the choice.

## Smallest useful slice

A labelled panel button beside Properties toggles all three context regions. It stays available when collapsed. The current vault configuration stores `contextCollapsed`, defaulting to false, across note switches, reloads and both workspace panes. The existing editor width preference remains authoritative; Full width uses all available space. On narrow panes the toolbar wraps below the title and the stacked context can also be hidden.

The toggle updates layout and ARIA state in place: it does not rebuild a block editor, change a note, reset undo history or interrupt an in-progress save. New IDs for controlled sections are scoped to their editor. Existing storage error and conflict handling remain authoritative for preference persistence.

## Exclusions and dependencies

No new database schema, storage backend, sharing, catalog adapter, data migration, keyboard shortcut, resize handle or dependency. No ECP/runtime-parity claim. Preserve the delivered durability and recovery code. The previously reproduced mobile body-margin overflow is corrected with a formatting context and dynamic viewport shell sizing.

## Acceptance

- Toggle outline, backlinks and mentions together with pointer and keyboard; retain toggle focus and truthful accessible name/expanded state.
- Reclaim the column at desktop and Full width ultrawide sizes; keep the selected readable text measure otherwise.
- Persist open and closed states through reload and note changes; synchronize both split panes without discarding pending drafts.
- Keep mobile title and controls legible in both themes, with no document overflow at 375×812 or 1440×900.
- Pass focused shell and save/adoption checks, existing lint/type/unit/build/budget checks and required CI; review regenerated pinned-container screenshots.
- Verify source merge, mirror deployment, managed canonical sync and real live toggle/reload behavior independently.

## Current state

Implementation carried forward onto the current durable-write source; final candidate checks and release proof are recorded by the associated pull request and CI runs. Human/device acceptance is not inferred from automated browser checks.
