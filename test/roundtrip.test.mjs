// Node round-trip tests for the pure markdown<->blocks bridge (src/utils/blocks.js).
// Run with: npm test
import { parse, serialize } from '../src/utils/blocks.js';
import { sampleNotes } from '../src/app/seed.js';
import { Note, normalizeBanner } from '../src/core/note.js';
import { runMigrations, detectVersion, CURRENT_SCHEMA_VERSION } from '../src/core/migrations.js';
import { fuzzyMatch, fuzzyHighlight } from '../src/utils/fuzzy.js';
import { parseQuery, noteMatchesFilters, scoreNote, rankNotes } from '../src/utils/search-query.js';
import { normalizeSettings, resolveTheme, DEFAULT_SETTINGS } from '../src/ui/settings.js';
import { Database } from '../src/core/database.js';
import { buildForest, flattenForest, isDescendant, ancestorChain } from '../src/utils/tree.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (extra ? '\n      ' + extra : '')); }
};

const strip = (blocks) => blocks.map((b) => ({ type: b.type, text: b.text, meta: b.meta || {} }));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- fixed point + block-stability over the seed corpus ---
for (const note of sampleNotes) {
  const md = note.content;
  const b1 = parse(md);
  const s1 = serialize(b1);
  const b2 = parse(s1);
  const s2 = serialize(b2);
  ok(`fixed point: ${note.title}`, s1 === s2, `s1!==s2`);
  ok(`block stability: ${note.title}`, eq(strip(b1), strip(b2)));
  ok(`parse(serialize(b))==b: ${note.title}`, eq(strip(b1), strip(parse(serialize(b1)))));
}

// --- structural expectations ---
const cheat = parse(sampleNotes.find((n) => n.title === 'Markdown Cheatsheet').content);
ok('table becomes a first-class table block', cheat.some((b) => b.type === 'table' && Array.isArray(b.meta.rows) && b.meta.rows[0].includes('Syntax')));
ok('js code block preserved with template literal',
  cheat.some((b) => b.type === 'code' && b.meta.lang === 'js' && b.text.includes('${name}')));

const welcome = parse(sampleNotes.find((n) => n.title === 'Welcome').content);
ok('welcome has an h1 heading', welcome.some((b) => b.type === 'heading' && b.meta.level === 1));
ok('welcome has unchecked todo', welcome.some((b) => b.type === 'todo' && b.meta.checked === false));
ok('welcome has checked todo', welcome.some((b) => b.type === 'todo' && b.meta.checked === true));
ok('welcome preserves nested todo indent', welcome.some((b) => b.type === 'todo' && (b.meta.indent || 0) >= 1));
ok('welcome has a blockquote', welcome.some((b) => b.type === 'quote'));
ok('welcome keeps [[wikilinks]] in text',
  welcome.some((b) => b.text.includes('[[Markdown Cheatsheet]]')) &&
  welcome.some((b) => b.text.includes('[[Wikilinks & Backlinks]]')));

// --- edge cases ---
ok('empty -> single empty paragraph', eq(strip(parse('')), [{ type: 'paragraph', text: '', meta: {} }]));

const soft = parse('line a\nline b');
ok('soft break stays one paragraph', soft.length === 1 && soft[0].text === 'line a\nline b');
ok('soft break round-trips', serialize(soft) === 'line a\nline b');

const twoP = parse('para one\n\npara two');
ok('blank line splits paragraphs', twoP.length === 2);
ok('two paragraphs round-trip', serialize(twoP) === 'para one\n\npara two');

const nums = parse('1. one\n2. two\n3. three');
ok('numbered list parses 3 items', nums.filter((b) => b.type === 'numbered').length === 3);
ok('numbered list renumbers on serialize', serialize(nums) === '1. one\n2. two\n3. three');
const shuffled = [nums[2], nums[0], nums[1]];
ok('numbered renumbers after reorder', serialize(shuffled).startsWith('1. three\n2. one\n3. two'));

// two separate numbered lists must NOT fuse or renumber across the blank line
const twoNum = '1. mix\n2. bake\n\n1. cool\n2. eat';
ok('two numbered lists round-trip exactly', serialize(parse(twoNum)) === twoNum);
ok('two numbered lists stay separate blocks', parse(twoNum).filter((b) => b.type === 'numbered').length === 4);
const twoBul = '- a\n- b\n\n- c\n- d';
ok('two bullet lists round-trip exactly', serialize(parse(twoBul)) === twoBul);
const twoTodo = '- [ ] a\n- [ ] b\n\n- [x] c';
ok('two todo lists round-trip exactly', serialize(parse(twoTodo)) === twoTodo);
// tight nested list (bullet then indented todos, no blanks) must stay tight
const nested = '- item\n  - [ ] sub a\n  - [x] sub b';
ok('tight nested list stays tight', serialize(parse(nested)) === nested);

const div = parse('a\n\n---\n\nb');
ok('divider parsed', div.some((b) => b.type === 'divider'));
ok('divider round-trips', serialize(div) === 'a\n\n---\n\nb');
// divider variants all normalize to ---
ok('*** is a divider', parse('***')[0].type === 'divider');
ok('___ is a divider', parse('___')[0].type === 'divider');
ok('divider variants serialize to ---', serialize(parse('***')) === '---' && serialize(parse('___')) === '---');

const h456 = parse('#### deep');
ok('h4 preserved as raw (no loss)', h456.length === 1 && h456[0].type === 'raw' && h456[0].text === '#### deep');

// --- date blocks ---
const dOnly = parse('@date(2026-07-01)');
ok('date block parses', dOnly.length === 1 && dOnly[0].type === 'date' && dOnly[0].meta.date === '2026-07-01');
ok('date block round-trips', serialize(dOnly) === '@date(2026-07-01)');
const dCtx = 'Before\n\n@date(2026-12-25)\n\nAfter';
ok('date block among paragraphs round-trips', serialize(parse(dCtx)) === dCtx);
ok('date block is its own block', parse(dCtx).filter((b) => b.type === 'date').length === 1);
// malformed date-like text stays a paragraph (no false positives / no loss)
ok('@date with bad value stays paragraph', parse('@date(nope)')[0].type === 'paragraph');
ok('inline @date(...) in prose is not a block', parse('see @date(2026-07-01) here')[0].type === 'paragraph');
ok('date fixed point', serialize(parse(dCtx)) === serialize(parse(serialize(parse(dCtx)))));

// --- first-class tables ---
const tbl = parse('| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |');
ok('table parses to a table block', tbl.length === 1 && tbl[0].type === 'table');
ok('table rows captured', JSON.stringify(tbl[0].meta.rows) === JSON.stringify([['A', 'B'], ['1', '2'], ['3', '4']]));
ok('table alignment captured', JSON.stringify(tbl[0].meta.align) === JSON.stringify(['left', 'right']));
ok('table round-trips (fixed point)', serialize(parse(serialize(tbl))) === serialize(tbl));
ok('table block stability', JSON.stringify(strip(tbl)) === JSON.stringify(strip(parse(serialize(tbl)))));
ok('table escapes a pipe inside a cell', (() => {
  const t = parse('| a | b |\n| --- | --- |\n| x\\|y | z |');
  return t[0].meta.rows[1][0] === 'x|y' && serialize(t).includes('x\\|y');
})());
// Regression: escCell escapes backslashes; splitTableRow must decode them symmetrically,
// else a cell with a backslash (Windows paths, regex, LaTeX) doubles it on every save.
ok('table cell with a backslash is a fixed point', (() => {
  const t = parse('| a | b |\n| --- | --- |\n| C:\\\\path | \\\\alpha |');
  const cell = t[0].meta.rows[1][0];
  if (cell !== 'C:\\path') return false; // one backslash, not two
  const t2 = parse(serialize(t)); // serialize -> parse must not grow the backslash run
  return t2[0].meta.rows[1][0] === 'C:\\path' && t2[0].meta.rows[1][1] === '\\alpha' &&
    serialize(t2) === serialize(t); // fixed point
})());
ok('table cell ending in a literal backslash keeps its columns', (() => {
  const t = parse('| a | b |\n| --- | --- |\n| x\\\\ | y |');
  // the trailing border pipe must not be eaten by the escaped backslash
  return t[0].meta.rows[1].length === 2 && t[0].meta.rows[1][0] === 'x\\' && t[0].meta.rows[1][1] === 'y';
})());
ok('table among prose round-trips', serialize(parse('intro\n\n| A |\n| --- |\n| 1 |\n\nafter')).includes('| A |'));

// --- collapsible toggle (<details>) stays one raw block ---
const tog = parse('<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>');
ok('details collapses into a single raw block', tog.length === 1 && tog[0].type === 'raw');
ok('details round-trips verbatim', serialize(tog) === '<details>\n<summary>More</summary>\n\nHidden **body**\n\n</details>');
ok('details open attribute preserved', parse('<details open>\n<summary>S</summary>\n\nb\n\n</details>')[0].text.includes('<details open>'));
ok('details among prose stays one block', parse('before\n\n<details>\n<summary>S</summary>\n\nx\n\n</details>\n\nafter').filter((b) => b.type === 'raw').length === 1);
// Regression: a NESTED toggle must close on its own </details>, not the first one,
// else the outer body leaks out as separate blocks and corrupts the note.
const nestTog = '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nInner body\n\n</details>\n\nOuter body\n\n</details>';
ok('nested details collapses into a single raw block', (() => {
  const b = parse(nestTog);
  return b.length === 1 && b[0].type === 'raw' && b[0].text === nestTog;
})());
ok('nested details round-trips verbatim (fixed point)', serialize(parse(nestTog)) === nestTog);
// Regression: a code fence inside a toggle containing the literal </details> must
// not split the toggle mid-fence.
const fenceTog = '<details>\n<summary>Code</summary>\n\n```html\n</details>\n```\n\n</details>';
ok('details with a </details> inside a code fence stays one block', (() => {
  const b = parse(fenceTog);
  return b.length === 1 && b[0].type === 'raw' && b[0].text === fenceTog;
})());

// --- image blocks ---
const imgOnly = parse('![a cat](https://example.com/cat.jpg)');
ok('image line parses to an image block', imgOnly.length === 1 && imgOnly[0].type === 'image');
ok('image block captures alt + src', imgOnly[0].meta.alt === 'a cat' && imgOnly[0].meta.src === 'https://example.com/cat.jpg');
ok('image block round-trips', serialize(imgOnly) === '![a cat](https://example.com/cat.jpg)');
ok('image data URL round-trips', serialize(parse('![](data:image/png;base64,AAAA)')) === '![](data:image/png;base64,AAAA)');
const imgCtx = 'Before\n\n![x](https://e.com/x.png)\n\nAfter';
ok('image among paragraphs round-trips', serialize(parse(imgCtx)) === imgCtx);
ok('image is its own block', parse(imgCtx).filter((b) => b.type === 'image').length === 1);
ok('image fixed point', serialize(parse(imgCtx)) === serialize(parse(serialize(parse(imgCtx)))));
// inline image inside prose is NOT a block (stays a paragraph, lossless)
ok('inline image in prose stays a paragraph', parse('see ![x](y.png) here')[0].type === 'paragraph');
// a src containing a ")" doesn't cleanly match -> stays paragraph (lossless)
ok('image with paren in url stays paragraph', parse('![a](http://x/(1).png)')[0].type === 'paragraph');

// --- comprehensive: every block type in one document ---
const everything = [
  '# H1',
  '## H2',
  '### H3',
  '',
  'A paragraph with **bold** and a [[Link]].',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] open task',
  '- [x] done task',
  '',
  '> a quote line',
  '> second quote line',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '@date(2026-07-01)',
  '',
  '---',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  'Closing paragraph.',
].join('\n');
const eBlocks = parse(everything);
const eTypes = new Set(eBlocks.map((b) => b.type));
for (const t of ['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'quote', 'code', 'date', 'divider', 'table']) {
  ok(`everything-doc contains ${t}`, eTypes.has(t));
}
ok('everything-doc fixed point', serialize(eBlocks) === serialize(parse(serialize(eBlocks))));
ok('everything-doc block stability', JSON.stringify(strip(eBlocks)) === JSON.stringify(strip(parse(serialize(eBlocks)))));

// --- banner metadata (note cover) ---
const GRAD = 'linear-gradient(120deg, #6366f1 0%, #d946ef 100%)';
const IMG = 'https://example.com/cover.jpg';
ok('normalizeBanner keeps a valid gradient', JSON.stringify(normalizeBanner({ type: 'gradient', value: GRAD, position: 50 })) === JSON.stringify({ type: 'gradient', value: GRAD, position: 50 }));
ok('normalizeBanner defaults position to 50', normalizeBanner({ type: 'image', value: IMG }).position === 50);
ok('normalizeBanner clamps position high', normalizeBanner({ type: 'image', value: IMG, position: 250 }).position === 100);
ok('normalizeBanner clamps position low', normalizeBanner({ type: 'image', value: IMG, position: -5 }).position === 0);
ok('normalizeBanner rejects null', normalizeBanner(null) === null);
ok('normalizeBanner rejects missing value', normalizeBanner({ type: 'gradient' }) === null);
ok('normalizeBanner rejects bad type', normalizeBanner({ type: 'video', value: IMG }) === null);
// value allowlist (security): reject CSS url() beacons and odd schemes
ok('rejects gradient containing url()', normalizeBanner({ type: 'gradient', value: 'url(https://evil.com/track.gif)' }) === null);
ok('rejects gradient that is not a gradient function', normalizeBanner({ type: 'gradient', value: 'red; position:fixed' }) === null);
ok('rejects image with javascript: scheme', normalizeBanner({ type: 'image', value: 'javascript:alert(1)' }) === null);
ok('rejects image with non-image data URL', normalizeBanner({ type: 'image', value: 'data:text/html,<script>1</script>' }) === null);
ok('accepts image data URL', normalizeBanner({ type: 'image', value: 'data:image/jpeg;base64,AAAA' }).type === 'image');
ok('accepts repeating/radial gradients', normalizeBanner({ type: 'gradient', value: 'radial-gradient(circle, #000, #fff)' }).type === 'gradient');

const nb = new Note({ title: 'B', content: 'x', banner: { type: 'gradient', value: GRAD, position: 30 } });
ok('Note stores normalized banner', nb.banner && nb.banner.type === 'gradient' && nb.banner.position === 30);
ok('Note.toJSON includes banner', nb.toJSON().banner.value === GRAD);
const nb2 = Note.fromJSON(nb.toJSON());
ok('Note banner round-trips through JSON', JSON.stringify(nb2.banner) === JSON.stringify(nb.banner));
nb.setBanner(null);
ok('setBanner(null) clears the banner', nb.banner === null && nb.toJSON().banner === null);
const legacy = Note.fromJSON({ id: '1', title: 't', content: 'c', tags: [] }); // no banner field
ok('legacy note (no banner field) loads with banner=null', legacy.banner === null);
// a crafted imported banner is neutralized on load
ok('crafted url() banner is dropped on import', Note.fromJSON({ id: '2', title: 't', content: 'c', banner: { type: 'gradient', value: 'url(https://evil/x.gif)' } }).banner === null);

// --- soft-delete field on the note model ---
const liveNote = new Note({ title: 'L', content: 'c' });
ok('new note is live (deletedAt null, isTrashed false)', liveNote.deletedAt === null && liveNote.isTrashed === false);
const updatedBefore = liveNote.updatedAt;
liveNote.markTrashed('2026-05-05T00:00:00.000Z');
ok('markTrashed sets deletedAt + isTrashed', liveNote.isTrashed === true && liveNote.deletedAt === '2026-05-05T00:00:00.000Z');
ok('markTrashed does not touch updatedAt (restore is lossless)', liveNote.updatedAt === updatedBefore);
liveNote.restore();
ok('restore clears deletedAt', liveNote.deletedAt === null && liveNote.isTrashed === false);
const tn = new Note({ title: 'T', content: 'c', deletedAt: '2026-05-05T00:00:00.000Z' });
ok('toJSON includes deletedAt', tn.toJSON().deletedAt === '2026-05-05T00:00:00.000Z');
ok('deletedAt round-trips through JSON', Note.fromJSON(tn.toJSON()).deletedAt === '2026-05-05T00:00:00.000Z');
ok('legacy note (no deletedAt field) loads as null', Note.fromJSON({ id: 'x', title: 't', content: 'c' }).deletedAt === null);
ok('non-string deletedAt is coerced to null', new Note({ deletedAt: 12345 }).deletedAt === null);

// --- schema versioning + migration runner ---
const legacyPayload = {
  notes: [
    { id: '1', title: 'A', content: 'x' },
    { id: '2', title: 'B', content: 'y', deletedAt: '2026-01-01T00:00:00.000Z' },
  ],
  config: { theme: 'dark' },
};
const mig = runMigrations(legacyPayload, undefined); // undefined => treat as legacy version 0
ok('migration reports the current schema version', mig.version === CURRENT_SCHEMA_VERSION);
ok('migration from legacy is flagged migrated', mig.migrated === true);
ok('migration adds deletedAt:null to notes missing it', mig.data.notes[0].deletedAt === null);
ok('migration preserves an existing deletedAt', mig.data.notes[1].deletedAt === '2026-01-01T00:00:00.000Z');
ok('migration preserves other note fields', mig.data.notes[0].title === 'A' && mig.data.notes[0].content === 'x');
ok('migration preserves config', mig.data.config.theme === 'dark');
ok('migration does not mutate the input payload', legacyPayload.notes[0].deletedAt === undefined);
const already = runMigrations({ notes: [{ id: '1', title: 'A', content: 'x', deletedAt: null }], config: {} }, CURRENT_SCHEMA_VERSION);
ok('running at the current version is a no-op', already.migrated === false && already.version === CURRENT_SCHEMA_VERSION);
const once = runMigrations(legacyPayload, 0).data;
const twice = runMigrations(once, CURRENT_SCHEMA_VERSION).data;
ok('migration is idempotent', JSON.stringify(once) === JSON.stringify(twice));
ok('migration tolerates a payload with no notes array', runMigrations({ config: {} }, 0).version === CURRENT_SCHEMA_VERSION);
ok('detectVersion: undefined -> 0', detectVersion(undefined) === 0);
ok('detectVersion: null -> 0', detectVersion(null) === 0);
ok('detectVersion: passes a valid integer through', detectVersion(1) === 1);

// --- pinning (model + migration v2) ---
const p0 = new Note({ title: 'P', content: 'c' });
ok('new note is unpinned by default', p0.pinned === false);
p0.setPinned(true);
ok('setPinned(true) pins', p0.pinned === true);
const pUpdated = p0.updatedAt;
p0.setPinned(false);
ok('setPinned(false) unpins without touching updatedAt', p0.pinned === false && p0.updatedAt === pUpdated);
ok('pinned round-trips through JSON', Note.fromJSON(new Note({ title: 'x', content: 'y', pinned: true }).toJSON()).pinned === true);
ok('legacy note (no pinned field) loads as false', Note.fromJSON({ id: 'z', title: 't', content: 'c' }).pinned === false);
const migP = runMigrations({ notes: [{ id: '1', title: 'A', content: 'x' }, { id: '2', title: 'B', content: 'y', pinned: true }], config: {} }, 0);
ok('migration reaches the current version', migP.version === CURRENT_SCHEMA_VERSION);
ok('v2 migration adds pinned:false where missing', migP.data.notes[0].pinned === false);
ok('v2 migration preserves an existing pinned:true', migP.data.notes[1].pinned === true);
ok('v1+v2 together add both deletedAt and pinned', migP.data.notes[0].deletedAt === null && migP.data.notes[0].pinned === false);

// --- fuzzy matcher ---
ok('fuzzy: empty query matches with score 0', JSON.stringify(fuzzyMatch('', 'abc')) === JSON.stringify({ score: 0, positions: [] }));
ok('fuzzy: non-subsequence returns null', fuzzyMatch('abz', 'abc') === null);
ok('fuzzy: query longer than text returns null', fuzzyMatch('abcd', 'abc') === null);
ok('fuzzy: subsequence records matched positions', JSON.stringify(fuzzyMatch('ac', 'abc').positions) === JSON.stringify([0, 2]));
ok('fuzzy: consecutive/prefix outranks scattered', fuzzyMatch('note', 'Notebook').score > fuzzyMatch('note', 'No tame edge').score);
ok('fuzzy: word-start outranks mid-word', fuzzyMatch('proj', 'My Project').score > fuzzyMatch('proj', 'improject').score);
ok('fuzzy: shorter target outranks longer for same query', fuzzyMatch('cat', 'cat').score > fuzzyMatch('cat', 'category theory notes').score);
ok('fuzzyHighlight wraps matched chars', fuzzyHighlight('abc', [0, 2]) === '<mark>a</mark>b<mark>c</mark>');
ok('fuzzyHighlight escapes + no positions', fuzzyHighlight('<x>', []) === '&lt;x&gt;');
ok('fuzzyHighlight escapes matched chars too', fuzzyHighlight('<b>', [0]) === '<mark>&lt;</mark>b&gt;');

// --- scoped search parsing ---
ok('parseQuery: plain text', JSON.stringify(parseQuery('hello world')) === JSON.stringify({ text: 'hello world', filters: { tags: [], inTitle: false, hasBanner: null, pinned: null } }));
ok('parseQuery: tag filter extracted', (() => { const p = parseQuery('tag:work notes'); return p.text === 'notes' && p.filters.tags.length === 1 && p.filters.tags[0] === 'work'; })());
ok('parseQuery: multiple tags', (() => { const p = parseQuery('tag:a tag:b'); return p.text === '' && p.filters.tags.join(',') === 'a,b'; })());
ok('parseQuery: in:title', parseQuery('in:title foo').filters.inTitle === true);
ok('parseQuery: has:banner', parseQuery('has:banner').filters.hasBanner === true);
ok('parseQuery: is:pinned', parseQuery('is:pinned x').filters.pinned === true);
ok('parseQuery: unknown filter value kept as text', parseQuery('in:body foo').text.includes('in:body'));
ok('parseQuery: unrelated colon token kept as text', parseQuery('http://example.com').text.includes('http://example.com'));

// --- filter predicate + scoring + ranking ---
const mkNote = (o) => ({ title: '', content: '', tags: [], banner: null, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z', ...o });
ok('noteMatchesFilters: tag match', noteMatchesFilters(mkNote({ tags: ['Work'] }), { tags: ['work'], hasBanner: null, pinned: null }) === true);
ok('noteMatchesFilters: tag miss', noteMatchesFilters(mkNote({ tags: ['home'] }), { tags: ['work'], hasBanner: null, pinned: null }) === false);
ok('noteMatchesFilters: has:banner true needs a banner', noteMatchesFilters(mkNote({ banner: null }), { tags: [], hasBanner: true, pinned: null }) === false);
ok('noteMatchesFilters: is:pinned true needs pinned', noteMatchesFilters(mkNote({ pinned: true }), { tags: [], hasBanner: null, pinned: true }) === true);
ok('scoreNote: title match beats body-only match', scoreNote('alpha', mkNote({ title: 'Alpha', content: 'zzz' })).score > scoreNote('alpha', mkNote({ title: 'zzz', content: 'contains alpha here' })).score);
ok('scoreNote: no match returns null', scoreNote('zzz', mkNote({ title: 'abc', content: 'def' })) === null);
ok('scoreNote: in:title ignores body', scoreNote('alpha', mkNote({ title: 'zzz', content: 'alpha' }), { inTitle: true }) === null);
ok('scoreNote: empty query matches all', scoreNote('', mkNote({ title: 'anything' })).score === 0);
const ranked = rankNotes('al', [mkNote({ title: 'Beta', content: 'no' }), mkNote({ title: 'Alpha', content: 'x' }), mkNote({ title: 'Val', content: 'x' })]);
ok('rankNotes: drops non-matches and ranks title matches', ranked.length === 2 && ranked[0].note.title === 'Alpha');
ok('rankNotes: applies filters', rankNotes('tag:x foo', [mkNote({ title: 'foo', tags: ['x'] }), mkNote({ title: 'foo', tags: ['y'] })]).length === 1);

// --- settings (normalize + theme resolution) ---
ok('normalizeSettings returns defaults for empty config', JSON.stringify(normalizeSettings({})) === JSON.stringify(DEFAULT_SETTINGS));
ok('normalizeSettings keeps all valid values', (() => {
  const s = normalizeSettings({ themeMode: 'dark', fontScale: 'l', editorWidth: 'wide', autosaveMs: 800, defaultTemplate: 'daily' });
  return s.themeMode === 'dark' && s.fontScale === 'l' && s.editorWidth === 'wide' && s.autosaveMs === 800 && s.defaultTemplate === 'daily';
})());
ok('normalizeSettings rejects invalid values back to defaults', (() => {
  const s = normalizeSettings({ themeMode: 'x', fontScale: 'xl', editorWidth: 'huge', autosaveMs: 9999, defaultTemplate: 'nope' });
  return s.themeMode === 'system' && s.fontScale === 'm' && s.editorWidth === 'normal' && s.autosaveMs === 400 && s.defaultTemplate === 'none';
})());
ok('normalizeSettings falls back to legacy theme key', normalizeSettings({ theme: 'dark' }).themeMode === 'dark');
ok('normalizeSettings prefers themeMode over legacy theme', normalizeSettings({ theme: 'dark', themeMode: 'light' }).themeMode === 'light');
ok('normalizeSettings coerces string autosaveMs', normalizeSettings({ autosaveMs: '800' }).autosaveMs === 800);
ok('resolveTheme: system + prefersDark -> dark', resolveTheme('system', true) === 'dark');
ok('resolveTheme: system + light -> light', resolveTheme('system', false) === 'light');
ok('resolveTheme: explicit dark ignores system', resolveTheme('dark', false) === 'dark');
ok('resolveTheme: explicit light ignores system', resolveTheme('light', true) === 'light');
// A fresh install must NOT be hard-coded to light — it should fall through to 'system'.
ok('fresh Database config has no hardcoded theme key', !('theme' in new Database().config));
ok('fresh install normalizes to themeMode: system', normalizeSettings(new Database().config).themeMode === 'system');
ok('a legacy stored theme still wins on upgrade', normalizeSettings({ ...new Database().config, theme: 'dark' }).themeMode === 'dark');

// --- PWA manifest is valid + installable-shaped ---
const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
ok('manifest has a name', manifest.name === 'My Notes');
ok('manifest display is standalone', manifest.display === 'standalone');
// Relative (./) so the manifest resolves correctly under any deploy base — root
// in dev, and the GitHub Pages sub-path (/my-notes-app/) in production.
ok('manifest has relative start_url + scope', manifest.start_url === './' && manifest.scope === './');
ok('manifest has at least one typed icon', Array.isArray(manifest.icons) && manifest.icons.length >= 1 && manifest.icons.every((i) => i.src && i.type));
ok('manifest icons use relative paths', manifest.icons.every((i) => i.src.startsWith('./')));
ok('manifest has a maskable icon', manifest.icons.some((i) => /\bmaskable\b/.test(i.purpose || '')));
ok('manifest has theme + background colors', /^#[0-9a-f]{3,8}$/i.test(manifest.theme_color) && /^#[0-9a-f]{3,8}$/i.test(manifest.background_color));

// --- nested notes (tree helpers) ---
const tN = (id, parentId = null) => ({ id, parentId, title: id, updatedAt: '2026-01-01T00:00:00Z' });
const tnotes = [tN('a'), tN('b', 'a'), tN('c', 'a'), tN('d', 'b'), tN('e')]; // a > {b > {d}, c}, e
const forest = buildForest(tnotes);
ok('buildForest: two roots (a, e)', forest.length === 2 && forest.map((f) => f.note.id).sort().join() === 'a,e');
const aNode = forest.find((f) => f.note.id === 'a');
ok('buildForest: a has children b, c', aNode.children.map((c) => c.note.id).sort().join() === 'b,c');
ok('buildForest: grandchild d under b', aNode.children.find((c) => c.note.id === 'b').children[0].note.id === 'd');
ok('buildForest: missing parent -> promoted to root', buildForest([tN('x', 'ghost')]).length === 1);
ok('buildForest: self-parent -> root', buildForest([tN('s', 's')]).length === 1);
const cyc = [tN('p', 'q'), tN('q', 'p')];
ok('buildForest: pure cycle is safe and loses no note', buildForest(cyc).length === 2);
const flat = flattenForest(forest);
ok('flattenForest: all rows when expanded', flat.length === 5);
ok('flattenForest: depth is correct', flat.find((r) => r.note.id === 'd').depth === 2 && flat.find((r) => r.note.id === 'a').depth === 0);
ok('flattenForest: hasChildren flag', flat.find((r) => r.note.id === 'a').hasChildren === true && flat.find((r) => r.note.id === 'd').hasChildren === false);
const collapsedRows = flattenForest(forest, new Set(['a']));
ok('flattenForest: collapsing a hides its subtree', collapsedRows.map((r) => r.note.id).sort().join() === 'a,e');
ok('flattenForest: collapsed flag set', collapsedRows.find((r) => r.note.id === 'a').collapsed === true);
ok('isDescendant: grandchild d under a', isDescendant(tnotes, 'a', 'd') === true);
ok('isDescendant: sibling is not', isDescendant(tnotes, 'b', 'c') === false);
ok('isDescendant: self is not', isDescendant(tnotes, 'a', 'a') === false);
ok('isDescendant: cycle-safe', typeof isDescendant(cyc, 'p', 'q') === 'boolean');
ok('ancestorChain: d -> [a, b]', ancestorChain(tnotes, 'd').map((n) => n.id).join() === 'a,b');
ok('ancestorChain: root -> empty', ancestorChain(tnotes, 'a').length === 0);
ok('ancestorChain: cycle-safe', Array.isArray(ancestorChain(cyc, 'p')));
// A very deep outline must not overflow the stack or go O(n^2) (iterative build/flatten).
const deep = [];
for (let k = 0; k < 4000; k++) deep.push(tN('n' + k, k === 0 ? null : 'n' + (k - 1)));
const deepForest = buildForest(deep);
ok('buildForest handles a very deep chain', deepForest.length === 1);
const deepFlat = flattenForest(deepForest);
ok('flattenForest handles a very deep chain', deepFlat.length === 4000 && deepFlat[3999].depth === 3999);
ok('cycle-stranded nodes flatten without looping', flattenForest(buildForest([tN('p', 'q'), tN('q', 'p')])).length === 2);

// --- parentId model + migration v3 + db.setParent/childrenOf ---
ok('new note parentId defaults to null', new Note({ title: 'x' }).parentId === null);
ok('parentId round-trips through JSON', Note.fromJSON(new Note({ title: 'x', parentId: 'p1' }).toJSON()).parentId === 'p1');
ok('self parentId coerced to null', new Note({ id: 'z', parentId: 'z' }).parentId === null);
ok('legacy note (no parentId) loads null', Note.fromJSON({ id: 'q', title: 't', content: 'c' }).parentId === null);
const migT = runMigrations({ notes: [{ id: '1', title: 'A', content: 'x' }], config: {} }, 0);
ok('migration reaches v3', migT.version === 3 && CURRENT_SCHEMA_VERSION === 3);
ok('v3 migration adds parentId:null', migT.data.notes[0].parentId === null);
ok('v3 migration preserves an existing parentId', runMigrations({ notes: [{ id: '2', parentId: 'p' }], config: {} }, 2).data.notes[0].parentId === 'p');

const dbt = new Database();
const pa = dbt.createNote({ title: 'Parent', content: '' });
const ch = dbt.createNote({ title: 'Child', content: '' });
ok('setParent nests a note', dbt.setParent(ch.id, pa.id) === true && dbt.getNote(ch.id).parentId === pa.id);
ok('childrenOf returns the child', dbt.childrenOf(pa.id).map((n) => n.id).join() === ch.id);
ok('setParent rejects self-parent', dbt.setParent(pa.id, pa.id) === false);
ok('setParent rejects a cycle (parent under its own child)', dbt.setParent(pa.id, ch.id) === false && dbt.getNote(pa.id).parentId === null);
ok('setParent rejects a missing/absent parent', dbt.setParent(ch.id, 'ghost') === false);
ok('ancestorsOf reflects the nesting', dbt.ancestorsOf(ch.id).map((n) => n.id).join() === pa.id);
ok('setParent(null) detaches to top level', dbt.setParent(ch.id, null) === true && dbt.getNote(ch.id).parentId === null);
dbt.setParent(ch.id, pa.id);
dbt.deleteNote(pa.id); // trashing the parent must not lose the child
ok('child survives when parent is trashed', dbt.getNote(ch.id) !== null);
ok('child is promoted to a tree root when its parent is trashed', buildForest(dbt.getAllNotes()).some((r) => r.note.id === ch.id));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
