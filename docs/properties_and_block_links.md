# Properties, block links, and transclusion

NoteForge keeps these features portable: YAML properties and block identifiers
live in the note's Markdown, while search indexes and rendered embeds are derived.

## Note properties

A YAML document is recognized only at byte zero, between exact delimiter lines:

```yaml
---
status: active
priority: 2
reviewed: false
due: 2026-08-20
source: https://example.com/reference
topics:
  - research
  - design
aliases:
  - Earlier title
---
The Markdown body begins here.
```

Use **Properties** above the current note or run **Edit note properties** from the
command palette. Supported typed controls are text, finite number, boolean, ISO date,
HTTP(S) URL, single select, and multi-select. `noteforge_id` is visible but
immutable because Phase 6 folder reconciliation uses it as external identity.

Unknown and nested YAML values remain intact even when the typed form cannot edit
them. If YAML is malformed, typed controls are disabled and the exact raw source
plus a line/column diagnostic remains available. Opening or saving an unchanged
note preserves its frontmatter and body bytes. Property edits never reformat the
Markdown body.

Phase 2 alias metadata migrates once into the YAML `aliases` list behind a durable
revision. A malformed note is not rewritten; NoteForge reports that it needs YAML
repair and retries after the source is fixed.

Search properties with `prop:key`, `property:key`, or an exact normalized value
filter such as `prop:status=active`. Normal search text also matches property keys
and scalar values.

## Block links

Hover or focus a supported paragraph, heading, list item, task, or quote and use
**Copy Block Link**. NoteForge appends a stable trailing marker and copies a link:

```markdown
Important decision ^decision-abc123

[[Project#^decision-abc123]]
```

The marker survives supported block edits and moves because it is part of the
Markdown. IDs are 1–64 ASCII letters, digits, `_`, or `-`, beginning with a letter
or digit. Duplicate IDs are diagnosed rather than guessed.

Heading links continue to use `[[Note#Heading]]`. A block link uses
`[[Note#^id]]`; selecting either link opens the note at the exact target.

## Read-only transclusion

Prefix a block link with `!` to embed its rendered content:

```markdown
![[Project#^decision-abc123]]
```

Embeds use the same DOMPurify-sanitized Markdown renderer as ordinary blocks,
remain read-only, and link back to their source. Missing or duplicate targets show
an explicit placeholder. Nested embeds stop at depth 5, stop cycles by visited
note/block reference, and share a 50-embed render budget.

## Backup and offline behavior

Frontmatter, aliases, block IDs, and transclusion syntax are ordinary Markdown and
therefore round-trip through raw Markdown export, folder export, revision history,
and integrity-verified JSON backup. Property parsing/editing and transclusion are
lazy production chunks that the service worker precaches, so they are available on
first use while offline after the app has installed its current worker.
