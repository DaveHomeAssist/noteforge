# NoteForge Flavored Markdown (NFM) — Specification v1

Status: draft v1, 2026-09-26. Describes the syntax the parsers in `src/utils`
implement **today**. Nothing here is aspirational; every rule cites the
implementing file and function, and the conformance corpus in
`test/fixtures/nfm/corpus.json` was produced by executing those functions.

## 1. Purpose and scope

NFM is the plain-text authority for a note (`NOTEFORGE_2_ROADMAP.md` §1.2).
A note's `content` string is NFM. This document covers:

- the leading YAML document (frontmatter) and its typed properties;
- inline syntax that NoteForge interprets beyond CommonMark/GFM: `[[wikilinks]]`,
  `![[embeds]]`, `^block-ids`, `@date()`, `@due()`;
- block syntax with NoteForge semantics: callouts, `<details>` toggles, tasks,
  tables, code fences, headings/anchors;
- what the block model (`blocks.js`) preserves byte-for-byte and what it normalizes;
- what the HTML renderer allows through sanitization.

Out of scope (not encoded in NFM today): note title (the vault filename),
`tags`, `pinned`, `banner`, `parentId`, `archivedAt`, `createdAt`/`updatedAt`.
These live only in the JSON record (`src/core/note.js:Note`). `writeVaultToDir`
(`src/utils/vault.js`) writes `note.content` verbatim, so a `.md` file is exactly
the NFM source.

Three independent parsers read NFM; they do not share a lexer:

| Parser | Purpose | Entry points |
|---|---|---|
| `src/utils/blocks.js` | Editor block model, lossless-ish round trip | `parse`, `serialize` |
| `src/utils/wikilinks.js`, `headings.js`, `tasks.js`, `calendar.js`, `block-links.js` | Derived indexes (links, anchors, tasks, dates, block ids) | `parseWikilinks`, `extractHeadings`, `extractTasks`, `resolveBlockId` |
| `src/utils/markdown.js` (+ `marked`, DOMPurify) | Read-only HTML | `renderMarkdown`, `renderInline` |

Where they disagree, §18 records it. A conforming implementation must reproduce
each parser's behavior for its own consumers, not reconcile them.

## 2. Conformance levels

**Level R (reader).** Reproduces, for every corpus case, the `expect` values of
the pure functions named in the case's `checks` (see Appendix A). Concretely:
`splitFrontmatterSource`, `parseFrontmatter`, `parseWikilinks`,
`extractWikilinks`, `extractHeadings`, `resolveHeadingAnchor`,
`parseTaskDueText`, `extractTasks`, `inspectBlockIds`, `resolveBlockId`,
`parse`.

**Level W (writer).** In addition, `serialize(parse(md))` equals the corpus
`serialized` string, and applying `serialize`/`parse` again is a fixed point
(`fixedPoint: true` for every case). Byte-preservation is only promised for the
constructs in §17; a writer may apply only the normalizations listed there.

**Level H (renderer).** Produces HTML that survives the DOMPurify configuration
in §16 unchanged. (Not exercised by the Node corpus: DOMPurify has no DOM in Node.)

The corpus runner is `test/nfm-conformance.test.mjs`; regenerate the corpus only
after an intentional parser change with `node test/fixtures/nfm/build-corpus.mjs`
and review the diff as a behavior change.

## 3. Document structure

```
document  := frontmatter? body
frontmatter := "---" NL yaml-lines ( "---" | "..." ) ( NL | EOF )
body      := any bytes
```

- The boundary is detected without a YAML parser (`frontmatter-boundary.js:splitFrontmatterSource`).
- `blocks.js:parse` is **not** frontmatter-aware; callers must pass `split.body`
  (`block-editor.js:#loadSource`, `#applyMarkdown` do). Passing the whole
  document turns the delimiters into `divider` blocks (corpus `frontmatter-split-basic`).
- `blocks.js:parse` normalizes `\r\n` and `\r` to `\n` before splitting lines.
  `wikilinks.js`, `headings.js` split on `\n` and keep `\r` inside offsets;
  `tasks.js:sourceLines` treats `\r\n`, `\n`, `\r` as line breaks and reports
  offsets on the original bytes (corpus `tasks-crlf`, `headings-crlf-offsets`).

## 4. Frontmatter

### 4.1 Boundary — `frontmatter-boundary.js:splitFrontmatterSource`

```
opener  := ^ "---" ( "\r" )? "\n"          ; byte zero, exactly three dashes
closer  := ^ ( "---" | "..." ) ( "\r" )? ( "\n" | EOF )
```

Example: `---\ntitle: x\n---\nBody` → `{ raw: "---\ntitle: x\n---", yaml: "title: x\n", body: "Body", separator: "\n", newline: "\n", closing: "---" }`.

Rules (corpus `frontmatter-split-*`):
- A leading space, a BOM, or trailing whitespace on either delimiter defeats
  recognition; the whole source is then body (`hasFrontmatter: false`).
- If no closer exists, the leading `---` is an ordinary divider.
- `newline` is the first line's terminator (`\n` or `\r\n`) and is reused by edits.
- Invariant: `raw + separator + body === source`.
- `separator` is `""` when the closer is at EOF.

### 4.2 YAML subset — `frontmatter.js:parseFrontmatter`

Parsed with `yaml` 2.9.0 `parseDocument` using: YAML 1.2, `schema: 'core'`,
`customTags: []`, `merge: false`, `strict: true`, `uniqueKeys: true`,
`stringKeys: true`, `maxAliasCount: 20`, `mapAsMap: true`.

| Result | Condition |
|---|---|
| `status: 'none'` | no frontmatter |
| `status: 'invalid'` | `raw.length > 262144` (`MAX_FRONTMATTER_BYTES`), YAML error, duplicate key (`DUPLICATE_KEY`), unresolved tag (`TAG_RESOLVE_FAILED`), or root not a mapping (`mapping_required`) |
| `status: 'valid'` | root is a mapping or empty; `properties` is a `Map` |

Consequences of the core schema (corpus `frontmatter-types`, `frontmatter-yaml-safety`):
`yes`/`no` are strings; `~`, `null`, and empty values are `null`; `0x1F` is a
number; timestamps and `YYYY-MM-DD` stay strings; anchors/aliases expand;
`<<` merge keys are literal keys; `__proto__` is an inert Map key.

### 4.3 Typed properties — `frontmatter.js:normalizePropertyValue`, `inferPropertyType`

| UI type | Accepted input (`normalizePropertyValue`) | Inferred from (`inferPropertyType`) |
|---|---|---|
| `text` | any → `String` | string not matching date/url; key not `status`/`type` |
| `select` | any → `String` | string when key is `status` or `type` |
| `number` | finite `Number(raw)` else `invalid_number` | finite number |
| `boolean` | `true`/`'true'`/`false`/`'false'` else `invalid_boolean` | boolean |
| `date` | `YYYY-MM-DD` that is a real local calendar date (`isIsoDate`) else `invalid_date` | string passing `isIsoDate` |
| `url` | `http:`/`https:` URL (`isSafeHttpUrl`) else `unsafe_url` | string passing `isSafeHttpUrl` |
| `multi-select` | array, or comma-split string; trimmed, empties dropped, de-duplicated | array of strings |
| `unsupported` | throws `unsupported_type` | null, nested map, mixed array, non-finite number |

### 4.4 Reserved keys

- `aliases`: must be a string array (`frontmatter.js:aliasesFromProperties`);
  since schema v6 it is the canonical alias source (`src/app/phase5.js`).
- `noteforge_id`: external file identity for folder reconciliation
  (`src/utils/vault-import.js`); immutable via the editor —
  `setFrontmatterProperty`/`removeFrontmatterProperty` throw `immutable_property`.
- Property keys are 1–128 characters on one line (`KEY_RE`), else `invalid_key`.

### 4.5 Editing — `frontmatter.js:setFrontmatterProperty`, `removeFrontmatterProperty`, `composeSource`

Example: `---\na: 1\n---\nBody` + set `b: two` → `---\na: 1\nb: two\n---\nBody`.

Preserved (corpus `frontmatter-set-property`): comments, key order, unknown
nested values, the closing delimiter spelling (`---` or `...`), the frontmatter
newline style, the original separator, and every body byte.
Normalized: the YAML is re-emitted by `Document.toString({ lineWidth: 0 })`;
a missing separator becomes one `newline`; a note with no frontmatter gains
`---{nl}k: v{nl}---{nl}` using the body's newline style.
Edits on `status: 'invalid'` throw `invalid_yaml` with `diagnostics`.

Limitation: removing the last property leaves `{}` as the YAML body
(`---\n{}\n---\nBody`), which re-parses as valid and empty
(corpus `frontmatter-remove-last-property`).

## 5. Wikilinks — `wikilinks.js:parseWikilinks`

```
wikilink := "!"? "[[" body "]]"
body     := target-part ( "|" display )?          ; first "|" splits
target-part := target ( "#" fragment )?           ; first "#" splits
target   := trimmed text, non-empty, containing neither "[" nor "]" nor NL
fragment := trimmed text ( may start with "^" for a block id; may be "" )
display  := trimmed text ( may be "" )
```

Example: `[[Note#Heading|Shown]]` → `{ target: "Note", fragment: "Heading", display: "Shown", embedded: false, start: 0, end: 22 }`.

Token fields: `start`, `end` (half-open UTF-16 offsets of the whole token
including `!`), `targetStart`/`targetEnd` (the canonical-title bytes only),
`target`, `display`/`displayRaw`, `fragment`/`fragmentRaw`, `embedded`, `raw`.
`display` and `fragment` are `null` when absent, `""` when present but blank
(corpus `wikilink-empty-forms`).

Not a link (candidate skipped, scanning resumes after it):
- `[[` preceded by an odd run of backslashes (`escapedAt`); `\![[x]]` is a
  non-embedded link because only the `!` is escaped.
- `[[` inside an exclusion range (`markdownExclusionRanges`): the frontmatter
  document; ```` ``` ````/`~~~` fences (3+ chars, ≤3 leading spaces, closer must
  match char and be ≥ length; an unclosed fence runs to EOF); inline code spans
  (backtick runs of equal length, may cross newlines); URL runs
  `\b(?:https?://|www\.)[^\s<>()]+`.
- body containing a newline; empty target; target containing `[` or `]`
  (so `[[A [[B]]` yields nothing); no closing `]]` (ends scanning).
- Raw HTML lines and table cells are **not** excluded (corpus `wikilink-inside-html-and-table`).

`extractWikilinks` returns distinct targets in first-seen order, keyed by
`helpers.js:normalizeTitle` (NFKC, whitespace collapsed to one space, trimmed,
lower-cased); the first spelling wins. Resolution in `src/core/database.js:
resolveTitleResult` uses the same key: canonical title first, then a unique alias.

Rendering (`markdown.js:wikilinkExtension`): `<a href="#" class="wikilink[ wikilink--missing]" data-wikilink="Target" data-fragment="frag">text</a>`
where text is `display` or `Target#fragment` (an empty `display` or `fragment`
falls back to the bare target and omits `data-fragment`); `wikilink--missing`
when the normalized target is not in `setKnownTitles`. Rename rewrites replace only
`targetStart..targetEnd` (`wikilinks.js:rewriteWikilinkTargets`).

Limitation: `WIKILINK_RE` (exported for the tokenizer's `start`) is looser than
`parseWikilinks`; the tokenizer only accepts a token at index 0.

## 6. Embeds / transclusions

```
embed := "!" wikilink
```

- `parseWikilinks` sets `embedded: true` for any `![[...]]` (corpus `embed-*`).
- Only `![[Note#^id]]` transcludes: `markdown.js:wikilinkExtension.renderer`
  delegates to `transclusion.js:createTransclusionRenderer` when
  `embedded && fragment.startsWith('^')`. `![[Note]]` and `![[Note#Heading]]`
  render as ordinary links.
- The transclusion resolves the note via `context.resolveNote`, the block via
  `block-links.js:resolveBlockId`, renders `blockToMarkdown(block, { includeBlockId: false })`
  recursively, and emits `<aside class="transclusion" role="note" contenteditable="false">`.
  Placeholders: `unavailable`, `missing`, `duplicate`, `cycle`, `depth`
  (max 5, `renderMarkdown` clamps `maxDepth` to 1..5), `budget` (50 per render).
- In the block model an embed line is a `paragraph` (never an `image`; the
  image regex requires `](`).

## 7. Block identifiers — `blocks.js:readBlockId`, `block-links.js`

```
block-id-suffix := ( ^ | [ \t]+ ) "^" id [ \t]* $        ; BLOCK_ID_SUFFIX_RE
id              := [A-Za-z0-9] [A-Za-z0-9_-]{0,63}          ; BLOCK_ID_RE
```

Example: `Important decision ^decision-abc123` → paragraph `text: "Important decision"`, `meta.blockId: "decision-abc123"`.

- Applies to the block's *text* after classification, for types
  `paragraph`, `heading` (levels 1–3 only), `bullet`, `numbered`, `todo`, `quote`
  (`BLOCK_ID_TYPES`). `code`, `table`, `image`, `date`, `divider`, `raw`
  (including `####`+ headings) never carry ids (corpus `blockid-unsupported-types`).
- For a multi-line `quote` the suffix must end the last line.
- `serialize` re-emits `text + " ^" + id` (no space when text is empty); the
  original separator (tab, multiple spaces) and trailing whitespace are normalized.
- Ids are assigned only by the editor's Copy Block Link
  (`block-editor.js:assignBlockId`, using `helpers.js:uid`, shape
  `<base36 time>-<6 chars>`, retried until unique in the note), never by parsers.
- `resolveBlockId(md, "^id" | "id")` → `resolved` | `duplicate` | `missing` | `invalid`.
  `inspectBlockIds` lists occurrences and duplicates. Duplicates are never guessed.
- A `@date(...)` line with an id suffix is a paragraph with an id, not a date block.

## 8. Date tokens — `blocks.js:RE.date`, `calendar.js:extractDateBlocks`

```
date-block := ^ "@date(" YYYY "-" MM "-" DD ")" [ \t]* $   ; whole line, column 0
```

Example: `@date(2026-12-25)` → `{ type: "date", meta: { date: "2026-12-25" } }`; serializes to `@date(2026-12-25)`.

- Inline (`see @date(...) here`), indented, or malformed forms are paragraph text.
- `blocks.js` does **not** validate the calendar (`@date(2026-02-30)` is a date block);
  `calendar.js:extractDateBlocks` additionally requires `local-date.js:isCalendarDate`
  and skips both fence kinds, so an impossible date is a block in the editor but
  never a calendar item (corpus `date-forms`).
- Templates emit it as the first line of daily/meeting notes (`src/app/templates.js`).

## 9. Task lists and due tokens — `tasks.js`

```
task := ^ WS* ( "-" | "*" ) WS+ "[" ( " " | "x" | "X" ) "]" WS+ text $   ; TASK_RE
due  := WS+ "@due(" YYYY "-" MM "-" DD ")" WS* $                       ; DUE_RE, on task text only
```

Example: `- [ ] Ship release @due(2026-08-21)` → `{ checked: false, text: "Ship release", dueDate: "2026-08-21", dueSeparator: " ", trailingWhitespace: "" }`.

Rules (`parseTaskDueText`, `extractTasks`; corpus `due-*`, `tasks-*`):
- The token must be terminal, preceded by ≥1 whitespace (so `\@due(...)` and
  `Glued@due(...)` are text), a real calendar date, and not inside an unclosed
  inline-code span on that line. Only the last token counts.
- `@due()` outside a task line is plain text; `@date()` is never a due date.
- Tasks are indexed with the nearest preceding `#`-heading text, and both fence
  kinds are skipped. `1. [ ]` and `- []` are not tasks.
- `mutateTaskSource` rewrites exactly one verified line, keeping `markerPrefix`,
  `markerSuffix`, `dueSeparator`, and `trailingWhitespace`.
- Block model (`blocks.js:RE.todo`): `todo` with `meta.checked`, `meta.indent`;
  serialize emits `- [ ] ` / `- [x] ` (so `*` and `[X]` normalize). The due
  token stays inside `text`; the block model does not interpret it.

## 10. Callouts — `block-editor.js:parseCallout`, `#fillCallout`

```
callout := quote whose text matches ^ "[!" kind "]" WS* body     ; /s flag: body spans lines
kind    := note | tip | info | important | warning | caution       ; case-insensitive
```

Example: `> [!note] Title\n> body line` → block model `{ type: "quote", text: "[!note] Title\nbody line" }`; the editor renders a `.blk-callout` box with the kind's icon/label.

- Callouts exist only in the block editor's rendered view. `blocks.js` treats
  them as ordinary `quote` blocks (corpus `callout-quote`), and
  `markdown.js:renderMarkdown` (export, transclusion) has no callout rule: they
  render as a `<blockquote>` containing the literal `[!note]`.
- Unknown kinds render as plain quotes. The slash menu inserts `[!note] `.

## 11. Toggles — `blocks.js:RE.detailsOpen`, the `<details>` branch of `parse`

```
toggle-open  := ^ WS* "<details" ( WS attrs )? ">" WS* $      ; case-insensitive
toggle-close := ^ WS* "</details>" WS* $                       ; case-insensitive
```

Example: `<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>` → one `raw` block whose text is the exact source; serializes verbatim.

- Nesting depth is tracked; a ```` ``` ```` fence inside the toggle is copied
  verbatim so a literal `</details>` in code does not close it.
- An opener with content on the same line (`<details><summary>x</summary>`) is a
  single-line `raw` HTML block; the body then fragments and is not byte-preserved
  (corpus `toggle-not-recognized`). An unclosed toggle swallows to EOF.
- Rendering: DOMPurify allows `details`, `summary`, and the `open` attribute (§16).

## 12. Tables — `blocks.js:splitTableRow`, `alignOf`, `escCell`, table branch of `parse`/`renderBlockToMd`

```
table := header-row NL separator-row ( NL body-row )*
header-row/body-row := line containing "|"             ; border pipes optional
separator-row := ^ WS* "|"? WS* ":"? "-"+ ":"? WS* ( "|" WS* ":"? "-"+ ":"? WS* )* "|"? WS* $
```

Example: `| A | B |\n| :-- | --: |\n| 1 | 2 |` → `{ type: "table", meta: { rows: [["A","B"],["1","2"]], align: ["left","right"] } }` → `| A | B |\n| :--- | ---: |\n| 1 | 2 |`.

- Cells are trimmed; `\|` → `|` and `\\` → `\` decode, and `escCell` re-encodes
  both; a cell ending in a literal backslash keeps its column.
- Body rows end at the first blank line or line without `|`. Ragged rows are
  padded with `""` to the widest row; output always has border pipes and `---`
  separators (`:---`, `---:`, `:---:` for alignment).
- Wikilinks inside cells are parsed by `parseWikilinks` (not excluded).

## 13. Code fences — `blocks.js:RE.fence`

```
fence-open  := ^ "```" info $          ; blocks.js: exactly three backticks at column 0
fence-close := ^ "```" .* $            ; blocks.js: ANY line starting with ```
```

Example: ```` ```js\nconst x = 1;\n``` ```` → `{ type: "code", text: "const x = 1;", meta: { lang: "js" } }`.

- Body is verbatim; `lang` is the trimmed info string. An unclosed fence runs to
  EOF and gains a closing fence on serialize (corpus `fence-unclosed`).
- Quirks (corpus `fence-quirks`): a closer may carry text (```` ```js ```` closes);
  four backticks are read as `lang: "`"`; indented fences and `~~~` fences are
  paragraphs in the block model. The derived-index parsers (`wikilinks.js`,
  `headings.js`, `tasks.js`, `calendar.js`) recognize both ```` ``` ```` and
  `~~~`, 3+ chars, ≤3 leading spaces, and require a matching closer.

## 14. Headings and anchors — `headings.js`

```
heading := ^ "#"{1,6} WS+ text WS* $        ; column 0 only
slug    := visible(text).NFKC.lower, runs of non-[\p{L}\p{N}] → "-", trimmed; empty → "section"
anchor  := "heading-" slug ( "-" n )?        ; n = 2,3,... for repeated slugs in document order
```

Example: `## Café & Résumé!` → `{ level: 2, text: "Café & Résumé!", anchor: "heading-café-résumé" }`.

- `visibleHeadingText` strips a trailing `^id`, replaces `[[T|D]]` with `D` (or
  `T`), removes `* _ \` ~`, and drops trailing `#`s.
- `extractHeadings` skips the frontmatter document and both fence kinds; reports
  `start`/`end` offsets on the original source and 1-based `line`.
- `resolveHeadingAnchor(headings, fragment)` strips a leading `#`, returns `null`
  for empty or `^...` fragments, and matches `normalizeTitle(text)` or the slug
  (anchor minus `heading-`). `src/app/main.js:openNote` uses it for `[[Note#H]]`.
- Block model: levels 1–3 are `heading` blocks (`meta.level`), 4–6 are `raw`
  lines; `serialize` emits `#`×level + space + text. `blocks.js` keeps trailing
  `#`s in text where `extractHeadings` strips them.

## 15. Other block types — `blocks.js:parse`, `renderBlockToMd`

Classification order per line: blank, fence, toggle, table, divider, date, image,
heading, todo, bullet, numbered, quote, raw HTML, paragraph.

| Type | Recognized | Serialized as |
|---|---|---|
| `divider` | `---`, `***`, `___` (+ trailing WS) | `---` |
| `image` | `^!\[alt\]\(src\)$`, alt without `]`, src without `)`/WS | `![alt](src)` |
| `bullet` | `WS* [-*] WS+ text`; indent = floor(spaces/2), tab = 2 | `"  "×indent + "- " + text` |
| `numbered` | `WS* \d+ "." WS+ text` | renumbered 1..n per contiguous run (`numberedLabels`) |
| `quote` | consecutive `>`-lines, `>` + optional one space stripped | `"> " + line` per line |
| `raw` | `^\s*<[a-zA-Z!/]` HTML line, `####`+ headings, toggles | verbatim |
| `paragraph` | anything else; consecutive lines join with `\n` | verbatim text |

Lists: adjacent list blocks of any family are emitted tight (`\n`); a blank line
between two list blocks is recorded as `meta.blankBefore` and re-emitted as one
blank line, restarting numbering. `+` is not a bullet marker. Lazy quote
continuation (`> a\nb`) is a quote followed by a paragraph.

## 16. Escaping and sanitization — `markdown.js`

- `marked` runs with `gfm: true`, `breaks: true` (single newline → `<br>`), plus
  the `wikilink` inline extension. Frontmatter is stripped before rendering.
- `DOMPurify.sanitize(html, PURIFY_CONFIG)` with
  `ADD_TAGS: ['details', 'summary', 'aside']` and
  `ADD_ATTR: ['data-wikilink', 'data-fragment', 'target', 'rel', 'open', 'contenteditable', 'role', 'aria-label']`.
  Everything else is DOMPurify's default allow-list (no `script`, no event
  handlers, no `javascript:` URLs).
- `afterSanitizeAttributes` hook: any `<a data-wikilink>` gets `href="#"`; any
  `http(s)://` anchor gets `target="_blank" rel="noopener noreferrer"`.
- Inline text in wikilink anchors/transclusion labels is escaped by
  `helpers.js:escapeHtml`/`escapeAttr`.
- Markdown-level escaping: a backslash before `[[` (odd run) suppresses a link;
  `\^id` is not an id (the regex requires whitespace before `^`); `\@due(` is text.
  The block model preserves all such bytes verbatim (corpus `wikilink-escapes`).
- `renderInline` (DOM only) unwraps a lone `P|LI|H1-6|BLOCKQUOTE` wrapper.

## 17. Round-trip guarantees — `blocks.js:parse` + `serialize`

Invariants (all corpus cases): `serialize(parse(x))` is a fixed point after one
pass; `parse(serialize(b))` deep-equals `b` (ignoring random `id`).

Byte-for-byte preserved: paragraphs with soft breaks; `- ` bullets and `- [ ]`/`- [x]`
tasks with 2-space indents; `1.`-style lists already numbered 1..n; `> ` quotes
whose lines all start with `> `; ```` ``` ```` fences with a bare closer; tables
already in `| a | b |` form with `---` separators; `<details>` toggles (opener on
its own line); `@date()` lines; `![alt](src)` lines; `---` dividers; raw HTML
lines; `#`–`###` headings and `####`+ lines; `^id` suffixes separated by one space;
frontmatter (when split off first).

Normalized (not byte-preserved; corpus `roundTrip: false` cases): `\r\n` → `\n`;
trailing newline dropped; multiple blank lines → one; `*` bullets → `-`; `[X]` → `[x]`;
list numbers → sequential; 1/3/tab indents → 2-space steps; `***`/`___` → `---`;
`>x` → `> x` and bare `>` → `> `; lazy quote lines split off; trailing whitespace
after `@date()` / `^id` dropped; tab before `^id` → space; borderless or ragged
tables → bordered/padded; `:--` → `:---`; unclosed fence gains a closer;
`~~~` fences and indented fences become paragraphs; `<details>` with same-line
content fragments; a `+` list becomes paragraph text.

## 18. Known cross-parser inconsistencies (documented, not fixed)

1. Fences: `blocks.js` knows only column-0 ```` ``` ```` and closes on any ```` ``` ````-prefixed line; the index parsers accept `~~~`, 3+ markers, indentation, and require a matching closer.
2. `@date()` calendar validity: not checked by `blocks.js`, checked by `calendar.js`.
3. Callouts: rendered only by `block-editor.js`; invisible to `blocks.js` and `renderMarkdown`.
4. Block ids on `####`–`######` headings: stripped from visible text by `headings.js`, but never read by `blocks.js` (raw block), so `[[Note#^id]]` to such a heading is `missing`.
5. Trailing `#`s: stripped by `headings.js`, kept by `blocks.js`.
6. Frontmatter: `blocks.js:parse` sees delimiters as dividers; only callers that split first are lossless.
7. `removeFrontmatterProperty` of the last key writes `{}`.

## Appendix A — corpus format

`test/fixtures/nfm/corpus.json`: `{ "version": 1, "cases": [ { "id", "feature", "note", "source", "checks", "expect" } ] }`.
`checks` maps a check name to `true` or an argument; `expect[name]` is the JSON
projection of the function result:

| check | function(s) | projection |
|---|---|---|
| `wikilinks` | `parseWikilinks(source)` | full token array |
| `wikilinkTargets` | `extractWikilinks(source)` | string array |
| `blocks` | `parse`, `serialize` | `{ types, blocks:[{type,text,meta}], serialized, roundTrip, fixedPoint }` |
| `frontmatterSplit` | `splitFrontmatterSource(source)` | all fields except `source` |
| `frontmatter` | `parseFrontmatter`, `inferPropertyType` | `{ status, properties, propertyTypes, diagnostics:[{code,line,column}] }` |
| `setProperty` | `setFrontmatterProperty(source, key, value, {type})` per step | `[{ key, result \| error }]` |
| `removeProperty` | `removeFrontmatterProperty(source, key)` per key | `[{ key, result \| error }]` |
| `headings` | `extractHeadings(source)` | heading array |
| `resolveAnchors` | `resolveHeadingAnchor(extractHeadings(source), f)` per fragment | `[{ fragment, anchor }]` |
| `dueText` | `parseTaskDueText(source)` | `{ text, dueDate, separator, trailing }` |
| `tasks` | `extractTasks(source, { noteId: 'n' })` | per task: occurrence, offsets, sourceLine, checked, text, dueDate, dueSeparator, trailingWhitespace, heading |
| `blockIds` | `inspectBlockIds(source)` | `{ occurrences, duplicates }` |
| `resolveBlockIds` | `resolveBlockId(source, id)` per id | `[{ id, status, block:{type,text} \| null }]` |
