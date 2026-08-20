# Canonical titles, aliases, and rename-safe links

Status: accepted Phase 0 decision

## Context

Current wikilinks are extracted with a regular expression and resolved by case-insensitive title. That is insufficient for safe rewrites because code, escaped text, display aliases, fragments, duplicate titles, and future transclusion syntax need source-aware handling.

## Decision

### Identity and resolution

- Note ID is permanent identity. Title is the canonical human-readable target. Aliases are alternate target names, never IDs.
- Normalization trims surrounding whitespace, applies Unicode normalization and locale-independent case folding, and collapses comparison-only whitespace without rewriting the stored spelling.
- Resolution order is: exact normalized canonical title, then one unique normalized alias. Canonical titles always outrank aliases.
- Creating or renaming a live note rejects a collision with any live canonical title or unique alias. Import never guesses: duplicate titles, duplicate aliases, or title/alias collisions produce a repair report and block destructive rewrites involving those names.
- Trash and Archive are explicit query scopes. Normal autocomplete excludes them; recovery and repair flows may request them deliberately.

Aliases enter the Note model through the next sequential additive payload migration in Phase 2. In Phase 5, `aliases` in leading YAML frontmatter becomes the Markdown source of truth. The migration copies legacy alias metadata into frontmatter without discarding unknown YAML keys. Old JSON backups with alias metadata remain readable and are migrated forward; runtime resolution never maintains two independently editable alias stores.

### Parser contract

A single pure wikilink parser replaces transformation-by-regex. It returns ordered tokens with source ranges and structured fields:

```js
{
  start,
  end,
  target,
  display,
  fragment,
  embedded,
}
```

The parser recognizes normal links, display text, heading/block fragments, and transclusion markers while excluding fenced/inline code, escaped delimiters, and URL text. Extraction, rendering, autocomplete, backlinks, graph edges, rename planning, contextual snippets, mentions, fragment navigation, and transclusion all consume this parser or an index built from it.

### Rename transaction

1. Flush the editor and resolve the source note by ID.
2. Validate the new title against canonical titles and aliases.
3. Parse all affected live source Markdown and build a preview containing exact note IDs, link counts, source ranges, and resulting Markdown.
4. Rewrite only tokens whose canonical target resolves to the renamed note. Preserve display text, embedding marker, and heading/block fragment exactly. Never change code or unrelated same-spelling text.
5. Add the previous title to aliases unless it normalizes to an existing title/alias for that note.
6. Commit pre-change revisions for the renamed note and every rewritten note.
7. Apply the title, aliases, and rewritten Markdown through one serialized atomic database batch. A failed batch leaves all notes unchanged and reports the failure.

The confirmation identifies the number of notes and links. A no-link rename still adds the old title alias after confirmation. Imported ambiguity blocks the plan before revisions or writes begin.

### Derived navigation

- Backlinks retain source token range, nearest heading context, and a sanitized text snippet.
- Unlinked mentions use the same normalized title/alias index and Markdown exclusion ranges; conversion previews the exact source edit and creates a revision.
- Repeated headings receive deterministic occurrence-aware anchors. Fragment syntax is parsed now but block-link/transclusion rendering remains Phase 5.

## Verification contract

- Parser and source-range fixed points for plain/display/fragment/embed links, escapes, inline/fenced code, duplicate links, Unicode, and malformed delimiters.
- Canonical-first/unique-alias resolution, collision rejection, Trash/Archive scopes, and imported ambiguity reports.
- Rename preview and atomic application across many notes, display/fragment preservation, no regex edits inside excluded ranges, pre-change revisions, rollback on failure, and JSON backup preservation.
- Graph, backlinks, autocomplete, contextual snippets, unlinked mentions, command palette, and 390 px/keyboard confirmation all use the same resolution result.

## Consequences

Rename is deliberately a planned multi-note transaction rather than a title-field edit. The shared parser is more work than a regex but prevents each downstream link feature from inventing incompatible syntax or exclusion rules.
