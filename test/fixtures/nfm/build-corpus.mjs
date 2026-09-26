// Regenerates corpus.json by EXECUTING the repo's pure functions. Nothing in
// "expect" is hand-written. Lives at test/fixtures/nfm/build-corpus.mjs.
// Run: node test/fixtures/nfm/build-corpus.mjs
// Only regenerate after an intentional parser change; review the diff as a
// behavior change, never as noise.
import { writeFileSync } from 'node:fs';
import { parseWikilinks, extractWikilinks } from '../../../src/utils/wikilinks.js';
import { parse, serialize } from '../../../src/utils/blocks.js';
import { splitFrontmatterSource } from '../../../src/utils/frontmatter-boundary.js';
import { parseFrontmatter, setFrontmatterProperty, removeFrontmatterProperty, inferPropertyType } from '../../../src/utils/frontmatter.js';
import { extractHeadings, resolveHeadingAnchor } from '../../../src/utils/headings.js';
import { parseTaskDueText, extractTasks } from '../../../src/utils/tasks.js';
import { resolveBlockId, inspectBlockIds } from '../../../src/utils/block-links.js';

// ---- dispatcher (kept textually identical to nfm-conformance.test.mjs) ----
const plain = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
const stripBlocks = (blocks) => blocks.map((b) => ({ type: b.type, text: b.text, meta: b.meta || {} }));

async function runCheck(name, source, arg) {
  switch (name) {
    case 'wikilinks':
      return plain(parseWikilinks(source));
    case 'wikilinkTargets':
      return plain(extractWikilinks(source));
    case 'blocks': {
      const blocks = parse(source);
      const serialized = serialize(blocks);
      return plain({
        types: blocks.map((b) => b.type),
        blocks: stripBlocks(blocks),
        serialized,
        roundTrip: serialized === source,
        fixedPoint: serialize(parse(serialized)) === serialized,
      });
    }
    case 'frontmatterSplit': {
      const { source: _omit, ...rest } = splitFrontmatterSource(source);
      return plain(rest);
    }
    case 'frontmatter': {
      const parsed = await parseFrontmatter(source);
      const properties = parsed.properties;
      const propertyTypes = {};
      for (const [key, value] of properties) propertyTypes[key] = inferPropertyType(value, key);
      return plain({
        status: parsed.status,
        properties,
        propertyTypes,
        diagnostics: parsed.diagnostics.map(({ code, line, column }) => ({ code, line, column })),
      });
    }
    case 'setProperty': {
      const results = [];
      for (const step of arg) {
        try {
          const result = await setFrontmatterProperty(source, step.key, step.value, step.type ? { type: step.type } : {});
          results.push({ key: step.key, result });
        } catch (error) {
          results.push({ key: step.key, error: error.code });
        }
      }
      return plain(results);
    }
    case 'removeProperty': {
      const results = [];
      for (const key of arg) {
        try {
          results.push({ key, result: await removeFrontmatterProperty(source, key) });
        } catch (error) {
          results.push({ key, error: error.code });
        }
      }
      return plain(results);
    }
    case 'headings':
      return plain(extractHeadings(source));
    case 'resolveAnchors': {
      const headings = extractHeadings(source);
      return plain(arg.map((fragment) => ({ fragment, anchor: resolveHeadingAnchor(headings, fragment) })));
    }
    case 'dueText':
      return plain(parseTaskDueText(source));
    case 'tasks':
      return plain(extractTasks(source, { noteId: 'n' }).map((task) => ({
        occurrence: task.occurrence,
        sourceStart: task.sourceStart,
        sourceEnd: task.sourceEnd,
        sourceLine: task.sourceLine,
        checked: task.checked,
        text: task.text,
        dueDate: task.dueDate,
        dueSeparator: task.dueSeparator,
        trailingWhitespace: task.trailingWhitespace,
        heading: task.heading,
      })));
    case 'blockIds':
      return plain(inspectBlockIds(source));
    case 'resolveBlockIds':
      return plain(arg.map((id) => {
        const resolved = resolveBlockId(source, id);
        return { id, status: resolved.status, block: resolved.block ? { type: resolved.block.type, text: resolved.block.text } : null };
      }));
    default:
      throw new Error(`Unknown check: ${name}`);
  }
}
// ---- end dispatcher ----

const cases = [];
const add = (id, feature, source, checks, note) => cases.push({ id, feature, note, source, checks });

// ---------------- wikilinks ----------------
add('wikilink-forms', 'wikilinks', 'See [[Note]] [[Note|Shown]] [[Note#Heading]] [[Note#^abc]] [[Note#Heading|Shown]] [[Résumé#Ünïcode|Ålias]] here.', { wikilinks: true, wikilinkTargets: true },
  'Bare, alias, heading fragment, block fragment, fragment+alias, Unicode. display/fragment are null when absent; a block fragment keeps its caret; offsets are UTF-16 code units.');
add('wikilink-whitespace-trim', 'wikilinks', '[[  A  # H  |  D  ]]', { wikilinks: true },
  'target/fragment/display are trimmed; raw forms keep bytes; targetStart/targetEnd skip padding.');
add('wikilink-empty-forms', 'wikilinks', '[[]] [[|x]] [[#frag]] [[Note#]] [[Note|   ]]', { wikilinks: true },
  'Empty target is not a link; empty fragment/display after # or | are empty strings, not null.');
add('wikilink-multiple-pipes-and-hashes', 'wikilinks', '[[Note|a|b]] [[A#B#C]]', { wikilinks: true },
  'Only the first pipe and first hash split; the rest stays in display/fragment.');
add('wikilink-escapes', 'wikilinks', '\\[[Escaped]] [[Real]] \\\\[[Double]] \\![[Not embed]]', { wikilinks: true, blocks: true },
  'Odd backslash run escapes [[; \\\\ is a literal backslash; \\! escapes only the embed bang.');
add('wikilink-inline-code-excluded', 'wikilinks', '`[[Code]]` and `multi\n[[Line]]` then [[Real]]', { wikilinks: true },
  'Inline code (including spans crossing a newline) is excluded.');
add('wikilink-fences-excluded', 'wikilinks', '```\n[[Fence]]\n```\n~~~md\n[[Tilde]]\n~~~\n[[Real]]', { wikilinks: true, blocks: true },
  'Both ``` and ~~~ fences exclude links in wikilinks.js; blocks.js only knows ``` (tilde fence becomes a paragraph).');
add('wikilink-url-excluded', 'wikilinks', 'https://example.test/[[URL]] www.example.test/[[W]] [[Real]]', { wikilinks: true },
  'http(s):// and www. URL runs are excluded.');
add('wikilink-malformed', 'wikilinks', '[[Broken [[Nested]] [[A]B]] [[Broken across\nlines]] [[Real]] [[Unclosed', { wikilinks: true },
  'Targets containing [ or ] are rejected; a newline inside [[...]] rejects that candidate; an unclosed [[ ends scanning.');
add('wikilink-frontmatter-excluded', 'wikilinks', '---\nlink: "[[In YAML]]"\n---\n[[Body]]', { wikilinks: true },
  'The leading YAML document is an exclusion range.');
add('wikilink-dedup-normalized', 'wikilinks', '[[Note]] [[note]] [[NOTE|x]] [[Other#h]] [[ＣＶ]] [[cv]] [[Résumé]] [[Résumé]]', { wikilinkTargets: true },
  'extractWikilinks dedups by NFKC + case fold + whitespace collapse; first spelling wins.');
add('wikilink-inside-html-and-table', 'wikilinks', '<details>\n<summary>S</summary>\n[[Inside]]\n</details>\n\n| a |\n| - |\n| [[Cell]] |', { wikilinks: true, blocks: true },
  'Raw HTML and table cells are NOT exclusion ranges.');

// ---------------- embeds ----------------
add('embed-block', 'embeds', '![[Note#^abc]]', { wikilinks: true, blocks: true },
  'Only ![[Note#^id]] transcludes; in the block model it is an ordinary paragraph.');
add('embed-whole-note-and-heading', 'embeds', '![[Note]] ![[Note#Sec|Shown]]', { wikilinks: true },
  'embedded=true but fragment is not ^id, so markdown.js renders these as plain links, not transclusions.');

// ---------------- block ids ----------------
add('blockid-supported-types', 'block-ids', 'Para ^id1\n\n# Head ^h-1\n\n- item ^b_2\n\n1. one ^n1\n\n- [ ] Task ^t1\n\n> quote ^q3',
  { blocks: true, blockIds: true, resolveBlockIds: ['id1', '^h-1', 'b_2', 'n1', 't1', 'q3'] },
  'paragraph, heading(1-3), bullet, numbered, todo, quote carry meta.blockId; leading ^ is optional when resolving.');
add('blockid-unsupported-types', 'block-ids', '```\ncode ^c4\n```\n\n| a |\n| - |\n| b ^t5 |\n\n#### Deep ^d4\n\n@date(2026-07-01) ^dt',
  { blocks: true, blockIds: true, resolveBlockIds: ['c4', 't5', 'd4', 'dt'] },
  'code, table, raw (h4-h6) never carry ids; a @date line with a suffix is not a date block but a paragraph WITH an id.');
add('blockid-grammar', 'block-ids', 'A ^bad.id\n\nB ^' + 'a'.repeat(65) + '\n\nC ^' + 'a'.repeat(64) + '\n\nD ^ABC\n\nE^glued\n\n^alone\n\nF ^-lead\n\nG ^id  \n\nH\t^tab',
  { blocks: true },
  'Id = [A-Za-z0-9][A-Za-z0-9_-]{0,63}, preceded by space/tab (or at line start); anything else stays literal text. Trailing whitespace is dropped and a tab separator becomes one space on serialize.');
add('blockid-duplicates', 'block-ids', 'Para ^a1\n\n# H ^h\n\nAgain ^a1', { blockIds: true, resolveBlockIds: ['a1', 'h', 'zz', 'bad.id'] },
  'Duplicates are diagnosed (status duplicate), not guessed; invalid ids report invalid.');
add('blockid-quote-last-line-only', 'block-ids', '> a\n> b ^qid\n\n> c ^first\n> d', { blocks: true },
  'For a multi-line quote the id must end the LAST line; an id on an earlier line is literal text.');

// ---------------- date / due ----------------
add('date-block', 'date-tokens', 'Before\n\n@date(2026-12-25)\n\nAfter', { blocks: true },
  '@date(YYYY-MM-DD) alone on a line is a date block.');
add('date-forms', 'date-tokens', 'see @date(2026-07-01) here\n\n@date(nope)\n\n  @date(2026-07-01)\n\n@date(2026-07-01)   \n\n@date(2026-02-30)', { blocks: true },
  'Inline, malformed, or indented forms stay paragraphs; trailing whitespace is dropped on serialize. blocks.js accepts any \\d{4}-\\d{2}-\\d{2} (2026-02-30 becomes a date block); calendar.js extractDateBlocks additionally requires a real calendar date.');
add('due-basic', 'due-tokens', 'Ship release  @due(2026-08-21)  ', { dueText: true },
  'Trailing @due(YYYY-MM-DD) preceded by whitespace; the exact separator and trailing whitespace are captured so rewrites are byte-exact.');
add('due-rejections', 'due-tokens', '- [ ] Invalid @due(2026-02-30)\n- [ ] Escaped \\@due(2026-08-21)\n- [ ] `code @due(2026-08-23)`\n- [ ] Mid @due(2026-08-21) first\n- [ ] Glued@due(2026-08-21)\n- [ ] @due(2026-08-21)\n- [ ] Two @due(2026-01-01) @due(2026-08-21)\n\nPara @due(2026-08-21)',
  { tasks: true, blocks: true },
  'Impossible dates, backslash-escaped, inside inline code, non-terminal, no leading whitespace, or bare token: no due. Only the last token counts. Paragraphs are never tasks.');
add('tasks-recognition', 'task-lists', '# H\n- [ ] a @due(2026-08-21)\n* [X] b\n  - [x] Done  @due(2026-08-22)  \n1. [ ] not a task\n- [] no\n-  [x]  spaced\n\n## Next\n- [ ] under next',
  { tasks: true, blocks: true },
  'Task = optional indent, - or *, [ ]/[x]/[X], then whitespace. Heading context is tracked. * and [X] normalize to - and [x] on serialize.');
add('tasks-fence-excluded', 'task-lists', '~~~md\n- [ ] Hidden @due(2026-08-24)\n~~~\n```\n- [ ] Hidden too\n```\n- [ ] Visible',
  { tasks: true, blocks: true },
  'extractTasks skips both fence kinds; blocks.js turns the tilde fence into a paragraph and a bullet-less line.');
add('tasks-crlf', 'task-lists', '- [ ] One\r\n- [x] Two @due(2026-08-21)\r\n', { tasks: true, blocks: true },
  'extractTasks keeps CRLF byte offsets; blocks.js normalizes CRLF to LF and drops the trailing newline.');

// ---------------- callouts ----------------
add('callout-quote', 'callouts', '> [!note] Title\n> body line', { blocks: true },
  'A callout is a quote block whose text starts with [!kind]; only block-editor.js renders it specially (kinds: note, tip, info, important, warning, caution).');
add('callout-unknown-kind', 'callouts', '> [!custom] x\n\n> [!WARNING] upper', { blocks: true },
  'Unknown kinds are plain quotes in the editor; the kind is lower-cased before lookup.');
add('quote-normalization', 'quotes', '>quote\n>\n> more\n\n> a\nb\n\n>', { blocks: true },
  '"> " is re-emitted for every line (so ">" gains a trailing space); lazy continuation lines are NOT part of the quote.');

// ---------------- toggles ----------------
add('toggle-basic', 'toggles', 'before\n\n<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>\n\nafter', { blocks: true },
  'A line that is exactly <details ...> starts one raw block that ends at the matching </details>.');
add('toggle-nested-and-fence', 'toggles', '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nInner body\n\n</details>\n\n```html\n</details>\n```\n\nOuter body\n\n</details>', { blocks: true },
  'Nesting depth is tracked (the outer block closes on its own </details>) and a literal </details> inside a ``` fence does not close the toggle.');
add('toggle-attributes-and-case', 'toggles', '<details class="x" open>\n<summary>S</summary>\n</details>\n\n<DETAILS>\n<summary>T</summary>\n</DETAILS>\n\n  <details>\n<summary>U</summary>\n  </details>  \nafter', { blocks: true },
  'Attributes, upper case, and surrounding whitespace are accepted on both tags.');
add('toggle-not-recognized', 'toggles', '<details><summary>x</summary>\nbody\n</details>\n\n<details>\n<summary>S</summary>\nunclosed', { blocks: true },
  'An opener with content on the same line is a plain HTML line and the body fragments (not lossless); an unclosed toggle swallows to EOF.');

// ---------------- frontmatter ----------------
add('frontmatter-split-basic', 'frontmatter', '---\ntitle: x\n---\nBody', { frontmatterSplit: true, frontmatter: true, blocks: true },
  'Byte-zero --- line, closing --- line. blocks.parse is NOT frontmatter-aware: callers must split first (the editor does).');
add('frontmatter-split-variants', 'frontmatter', '---\r\n# keep\r\ntitle: "Quoted"\r\n...\r\nBody  \r\n\r\n', { frontmatterSplit: true, frontmatter: true },
  '... is an accepted closing line; CRLF newline is detected and preserved; raw + separator + body reassemble the source.');
add('frontmatter-split-eof-dots', 'frontmatter', '---\na: 1\n...', { frontmatterSplit: true, frontmatter: true, setProperty: [{ key: 'b', value: 'x' }] },
  'A ... closing line at EOF yields an empty separator and body; an edit preserves ... and inserts one newline where the separator was missing.');
add('frontmatter-split-rejected', 'frontmatter', ' ---\na: 1\n---\nBody', { frontmatterSplit: true },
  'Leading space: not frontmatter.');
add('frontmatter-split-rejected-bom', 'frontmatter', '\ufeff---\na: 1\n---\nBody', { frontmatterSplit: true },
  'A BOM before --- defeats recognition.');
add('frontmatter-split-rejected-trailing-space', 'frontmatter', '---\na: 1\n--- \nBody', { frontmatterSplit: true },
  'Delimiter lines must be exactly --- or ... (a trailing space breaks the closing line).');
add('frontmatter-split-unclosed', 'frontmatter', '---\nA leading Markdown divider\n\ntext', { frontmatterSplit: true, blocks: true },
  'No closing line: the --- is an ordinary divider.');
add('frontmatter-types', 'frontmatter', '---\nstatus: active\ntype: doc\ntitle: Plain\npriority: 2\nratio: 1.5\nreviewed: false\ndue: 2026-08-20\nsource: https://example.com/reference\ntopics:\n  - research\n  - design\naliases:\n  - Earlier title\nempty:\nnul: null\ntilde: ~\nyes_str: yes\nquoted_date: "2026-08-20"\nts: 2026-08-20T10:00:00Z\nnested:\n  a: 1\nmixed: [1, a]\nhex: 0x1F\n---\nBody',
  { frontmatter: true },
  'YAML 1.2 core schema: yes is a string, ~ and empty are null, timestamps stay strings, hex is a number. inferPropertyType maps values to UI types (status/type keys become select).');
add('frontmatter-invalid-yaml', 'frontmatter', '---\na: [\n---\nbody', { frontmatter: true, setProperty: [{ key: 'b', value: 'x' }] },
  'Malformed YAML: status invalid with a line/column diagnostic; property edits refuse with invalid_yaml.');
add('frontmatter-duplicate-key', 'frontmatter', '---\na: 1\na: 2\n---\nbody', { frontmatter: true },
  'Duplicate keys are rejected (uniqueKeys).');
add('frontmatter-unknown-tag', 'frontmatter', '---\nv: !unknown value\n---\nbody', { frontmatter: true },
  'Custom tags are rejected (TAG_RESOLVE_FAILED becomes invalid).');
add('frontmatter-not-a-mapping', 'frontmatter', '---\n- not\n- a mapping\n---\nbody', { frontmatter: true },
  'A sequence or scalar document is invalid (mapping_required).');
add('frontmatter-empty-and-braces', 'frontmatter', '---\n---\nbody', { frontmatter: true, setProperty: [{ key: 'a', value: 'x' }] },
  'An empty document is valid with no properties.');
add('frontmatter-yaml-safety', 'frontmatter', '---\na: &x 1\nb: *x\nbase: &b {x: 1}\nd:\n  <<: *b\n__proto__: safe\n---\nbody', { frontmatter: true },
  'Anchors/aliases expand (alias cap 20); merge keys are NOT applied (<< is a literal key); properties are a Map so prototype-shaped keys are inert.');
add('frontmatter-set-property', 'frontmatter', '---\n# retained\nalpha: one\nnoteforge_id: stable-1\nunknown:\n  keep: true\n---\r\nBody bytes  \r\n',
  { setProperty: [
    { key: 'count', value: '3.5', type: 'number' },
    { key: 'ready', value: 'true', type: 'boolean' },
    { key: 'due', value: '2026-08-20', type: 'date' },
    { key: 'due', value: '2026-02-30', type: 'date' },
    { key: 'site', value: 'https://example.com/a', type: 'url' },
    { key: 'site', value: 'javascript:alert(1)', type: 'url' },
    { key: 'labels', value: 'one, two, one', type: 'multi-select' },
    { key: 'alpha', value: 'changed' },
    { key: 'noteforge_id', value: 'changed', type: 'text' },
    { key: '', value: 'x' },
  ], removeProperty: ['alpha', 'noteforge_id', 'missing'] },
  'Edits rewrite only the YAML node: comments, key order, unknown nesting, the CRLF body separator and body bytes survive. noteforge_id is immutable.');
add('frontmatter-set-on-plain-note', 'frontmatter', 'Body\r\nmore', { setProperty: [{ key: 'b', value: 'two' }] },
  'Setting a property on a note without frontmatter inserts a document using the body newline style.');
add('frontmatter-remove-last-property', 'frontmatter', '---\na: 1\n---\nBody', { removeProperty: ['a'], setProperty: [{ key: 'b', value: 'x' }] },
  'Removing the only property leaves a literal {} YAML body (which re-parses as valid and empty).');

// ---------------- headings ----------------
add('headings-levels', 'headings', '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six', { headings: true, blocks: true },
  'extractHeadings sees levels 1-6; blocks.js models 1-3 as heading blocks and keeps 4-6 as raw lines.');
add('headings-duplicate-anchors', 'headings', '# Repeat\n## Repeat\n# repeat\n## !!!\n## ???', { headings: true, resolveAnchors: ['Repeat', '#Repeat', 'REPEAT', 'repeat-2', 'repeat-3', 'section', 'section-2', 'Nope', '^abc', ''] },
  'Slugs are NFKC + lower + non-alphanumeric runs to -; duplicates get -2, -3; empty slugs become section. resolveHeadingAnchor matches visible text or slug and never ^block fragments.');
add('headings-visible-text', 'headings', '## See [[Target|Shown]] and [[Other#frag]]\n## **Bold** _it_ `code` ~~s~~\n## Section ^sec-1\n## Title ##\n## Café & Résumé!', { headings: true, blocks: true },
  'Visible text drops wikilink syntax (alias or target), emphasis marks, a trailing ^id, and trailing #s; blocks.js keeps "Title ##" verbatim.');
add('headings-exclusions', 'headings', '---\na: 1\n---\n```\n# hidden\n```\n~~~md\n## also hidden\n~~~\n# shown\n  ## indented\n#nospace\n# ', { headings: true, blocks: true },
  'Frontmatter and both fence kinds are skipped; indented, space-less, or empty headings are not headings.');
add('headings-crlf-offsets', 'headings', '# One\r\n## Two\r\n', { headings: true },
  'Offsets count the \\r; the trailing \\r is trimmed from the text.');

// ---------------- tables ----------------
add('table-alignment', 'tables', '| A | B | C |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |', { blocks: true },
  'Alignment is captured and re-emitted as :---, ---:, :---:.');
add('table-escapes', 'tables', '| a | b |\n| --- | --- |\n| x\\|y | C:\\\\path |\n| x\\\\ | y |', { blocks: true },
  '\\| and \\\\ decode symmetrically; a cell ending in a literal backslash keeps its column.');
add('table-borderless-and-ragged', 'tables', 'A | B | C\n--- | ---\n1', { blocks: true },
  'Border pipes are optional; ragged rows are padded to the widest row; output always has border pipes.');
add('table-ends-at-non-pipe-line', 'tables', 'intro\n| a |\n| - |\n| 1 |\nno pipe\n| 2 |', { blocks: true },
  'A table needs a separator on the next line; the body stops at the first line without a pipe (or a blank).');

// ---------------- code fences ----------------
add('fence-basic', 'code-fences', '```js\nconst x = `${name}`;\n[[Not a link]]\n```', { blocks: true, wikilinks: true },
  'Body is verbatim; lang is the trimmed info string.');
add('fence-unclosed', 'code-fences', '```js\nlet x\n', { blocks: true },
  'An unclosed fence runs to EOF and gains a closing fence on serialize.');
add('fence-quirks', 'code-fences', '```js\nx\n```js\ny\n\n````\n```\n````\n\n  ```\nz\n  ```', { blocks: true },
  'blocks.js closes on ANY line starting with ```; a 4-backtick fence is read as lang "`"; indented fences are paragraphs.');

// ---------------- lists ----------------
add('list-markers-and-indent', 'lists', '* a\n+ b\n- c\n\t- tab\n    - four\n   - three', { blocks: true },
  '- and * are bullets (+ is not); indent = floor(spaces/2) with tab = 2 spaces; serialize emits - and 2-space indents.');
add('list-blank-separation', 'lists', '- a\n\n\n- b\n\n1. mix\n2. bake\n\n1. cool\n2. eat', { blocks: true },
  'A blank between same-family items is kept as meta.blankBefore (one blank line) and restarts numbering.');
add('list-numbered-renumber', 'lists', '3. a\n7. b\n\n- x\n1. y\n- [ ] z', { blocks: true },
  'Numbers are regenerated sequentially; mixed list families stay tight.');
add('list-divider-lookalike', 'lists', '***\n\n___\n\n- - -', { blocks: true },
  '*** and ___ are dividers normalized to ---; "- - -" is a bullet whose text is "- -".');

// ---------------- paragraphs and misc ----------------
add('paragraph-soft-breaks', 'paragraphs', 'line a\nline b\n\npara two\n\n\n\npara three', { blocks: true },
  'Consecutive plain lines are one paragraph; multiple blank lines collapse to one.');
add('image-block', 'images', '![a cat](https://example.com/cat.jpg)\n\n![](x.png)\n\nsee ![x](y.png) here\n\n![a](http://x/(1).png)', { blocks: true },
  'Only a line that is exactly ![alt](src) with no ) or whitespace in src is an image block.');
add('crlf-and-trailing-newline', 'misc', 'a\r\nb\r\n\r\nc\n', { blocks: true },
  'CRLF is normalized to LF and the trailing newline is dropped by serialize (not byte-preserving).');
add('empty-document', 'misc', '', { blocks: true, wikilinks: true, headings: true, frontmatterSplit: true },
  'An empty note parses to one empty paragraph.');
add('everything-document', 'misc', ['# H1', '## H2', '### H3', '', 'A paragraph with **bold** and a [[Link]].', '', '- bullet one', '- bullet two', '', '1. first', '2. second', '', '- [ ] open task @due(2026-08-21)', '- [x] done task', '', '> a quote line', '> second quote line', '', '```js', 'const x = 1;', '```', '', '@date(2026-07-01)', '', '---', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '<details>', '<summary>More</summary>', '', 'Hidden', '', '</details>', '', 'Closing paragraph. ^end'].join('\n'),
  { blocks: true, wikilinks: true, headings: true, tasks: true, blockIds: true },
  'Every block type in one document is a byte-exact fixed point.');

const out = { version: 1, generatedBy: 'test/fixtures/nfm/build-corpus.mjs (expect values are executed against src/utils, never hand-edited)', cases: [] };
for (const c of cases) {
  const expect = {};
  for (const [name, arg] of Object.entries(c.checks)) expect[name] = await runCheck(name, c.source, arg);
  out.cases.push({ id: c.id, feature: c.feature, note: c.note, source: c.source, checks: c.checks, expect });
}
const ids = new Set(out.cases.map((c) => c.id));
if (ids.size !== out.cases.length) throw new Error('duplicate case id');
writeFileSync(new URL('./corpus.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.cases.length} cases`);
