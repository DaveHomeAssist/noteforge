# Markdown task due dates and calendar dates

Status: implemented and verified in Phase 4

## Context

NoteForge already round-trips task-list lines and standalone `@date(YYYY-MM-DD)` blocks. Tasks need portable due dates without converting Markdown into hidden metadata or changing ordinary date blocks. Calendar behavior must use local calendar dates rather than UTC serialization.

## Decision

### Syntax

The supported task syntax is a trailing marker on a Markdown task-list line:

```md
- [ ] Submit release notes @due(2026-08-21)
```

- The marker is recognized only on a parsed task-list item, after at least one separating space, as the final non-whitespace token.
- The value must be an exact Gregorian `YYYY-MM-DD` calendar date. Invalid or impossible dates remain ordinary visible task text and produce no due-date metadata.
- Escaped markers and markers inside inline code are ordinary text.
- The parser retains the original source text. Parse/serialize without an edit is byte-stable; changing a due date replaces or removes only the terminal marker.
- `@date()` keeps its existing standalone block meaning. It is never interpreted as a task due date, and `@due()` outside a task line is ordinary Markdown.

### Identity and source mutation

An indexed task reference contains note ID, parsed task occurrence, source range, normalized line hash, checked state, text, due date, and heading context. Before toggling or editing, the database verifies the current source range/hash. If the source changed, it reparses and resolves one unambiguous occurrence or asks the user to retry; it never toggles a same-text task by guess.

Task mutations operate on source Markdown, create the normal autosave/revision boundary, and update derived task/calendar indexes only after durable save. Duplicate task text is supported because identity includes occurrence and verified source context.

### Date semantics

- Daily-note titles and task/date markers represent local calendar dates without a timezone.
- “Today” is built from local year, month, and day fields. Code must not use `toISOString().slice(0, 10)` for local-day selection.
- Today/Overdue/Upcoming comparisons operate on calendar tuples, not elapsed milliseconds, so daylight-saving transitions cannot move an item to another day.
- Archive and Trash are excluded from ordinary task/calendar aggregation. Explicit scoped views may include Archive but never mutate hidden source without opening it.

### Views and accessibility

- The task dashboard groups Today, Overdue, Upcoming, No Date, completed state, note, and tag from one derived index.
- Month/week calendar views combine Daily-note titles, standalone `@date()` blocks, and task `@due()` markers. Selecting an empty day invokes the idempotent Daily-note command.
- Calendar grids follow the WAI keyboard pattern (arrow navigation, Home/End within a week, Page Up/Down for period changes) and expose a mobile agenda alternative with the same items and source links.
- Task toggles use native controls, announce saved/failed status through a shared polite status region, and never report completion before persistence succeeds.

## Verification contract

- Valid, invalid, escaped, code-contained, duplicate, checked, nested, CRLF, and whitespace forms are fixed points.
- Due-date edits change only the marker; task toggles verify the exact source occurrence and create revisions.
- Local-midnight, month/year rollover, leap day, daylight-saving, and multiple-time-zone tests prove calendar-date semantics.
- Dashboard/Calendar filters match Archive/Trash rules; keyboard, screen-reader names/status, 200% zoom, and 390 px agenda behavior pass.

## Consequences

The suffix is portable and human-readable, while the verified source reference prevents duplicate visible text from causing the wrong line to change. Derived indexes remain disposable and rebuildable from Markdown.
