# Leading YAML frontmatter and note properties

Status: implemented and locally verified in Phase 5

## Context

Properties and portable aliases require structured metadata in Markdown. NoteForge currently treats leading `---` as a divider and must not rewrite a user's body, YAML comments, unknown keys, or malformed source merely because the note was opened.

## Decision

### Dependency boundary

Phase 5 adds `yaml` 2.9.0 (ISC, zero runtime dependencies) behind
`src/utils/frontmatter.js`. The adapter is the only application module that imports
the package. It is lazy-loaded into a 104,706-byte production chunk; the Phase 5
controller, properties view, and properties CSS add 24,416 bytes, for 129,122 bytes
of Phase 5 deferred output. All assets remain same-origin under the existing CSP,
and `npm audit --audit-level=high` reports zero vulnerabilities.

The adapter uses the document/CST-preserving API with strict duplicate-key handling, no custom executable tags, bounded aliases, and a mapping root. It exposes parsed values, diagnostics, source ranges, the original frontmatter bytes, and the untouched body.

### Recognition and losslessness

- Frontmatter is recognized only when byte zero begins with a line containing exactly `---`, a closing `---` or `...` delimiter exists, and the document root is a mapping.
- A leading divider without a valid closing document remains ordinary Markdown.
- Opening, parsing, rendering, exporting, or saving an unchanged note returns the original Markdown bytes exactly, including YAML comments, quoting, key order, line endings, trailing spaces, and body bytes.
- A property edit mutates only the selected YAML document node, preserving other nodes/comments/order where the library supports it. The Markdown body is never reformatted.
- Malformed YAML remains visible as raw source with a useful diagnostic and source location. Property controls are read-only until the user fixes the source; the raw content is never hidden or replaced with defaults.

### Property model

First-class UI property values are text, finite number, boolean, ISO calendar date (`YYYY-MM-DD`), safe HTTP(S) URL, single select, and multi-select. Unknown keys and nested YAML values remain in the document and backup even when the property editor cannot edit them.

- `aliases` is a string array and becomes the canonical alias source after the Phase 5 migration.
- `noteforge_id` is the stable external-file identity used by folder reconciliation. It is immutable through the property UI.
- Dangerous URL schemes are rejected for typed URL properties. Unknown values are treated as data and never rendered as executable HTML.
- Search indexes normalized property values but retains Markdown/frontmatter as authority. Derived indexes are excluded from backups.

### Migration

The migration is additive and pure. For each note with Phase 2 alias metadata:

1. Parse valid leading frontmatter or create a new document without touching the body.
2. Merge normalized legacy aliases into `aliases` while preserving existing order and spelling.
3. Preserve every unknown key and comment.
4. Record the rewritten Markdown through the revision/migration boundary.

Malformed frontmatter blocks automatic rewriting for that note and produces a repair report; it is never silently replaced. Old backup envelopes retain their original schema version and migrate through the same chain.

Schema version 6 stores only a migration marker during the pure migration. The
lazy Phase 5 controller performs the Markdown rewrite after the current vault is
durable, captures `pre_frontmatter_alias_migration` revisions first, checks for a
stale note before committing, keeps compatibility alias metadata synchronized,
and records `repair_required` until every blocked note is fixed.

## Verification contract

- Byte-exact unchanged round trips for no frontmatter, valid frontmatter, comments, quotes, CRLF, unknown/nested keys, and a leading Markdown divider.
- Deterministic targeted property edits without body churn; duplicate keys and malformed YAML remain raw and diagnostic.
- Type validation, unsafe URL rejection, alias migration, immutable `noteforge_id`, property search filters, JSON backup/restore, and unknown-key preservation.
- Markdown parse/serialize fixed points around the body, XSS/adversarial YAML coverage, keyboard-labelled controls, focus/error announcement, and stacked 390 px layout.

## Consequences

Markdown remains the sole portable source of property truth. Using a narrow adapter avoids spreading YAML-library behavior through the application and allows a future parser replacement without changing editor, search, or reconciliation contracts.

The final Phase 5 local gate passed 395 Node checks, 376 browser component
assertions, 90 integrated checks, nine production/offline checks, the Vite build,
and the high-severity audit. The initial shell is 253,841 bytes, 3,339 bytes below
the authoritative ceiling.
