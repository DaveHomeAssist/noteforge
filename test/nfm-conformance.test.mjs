// NFM conformance corpus runner. Lives at test/nfm-conformance.test.mjs and
// reads test/fixtures/nfm/corpus.json. Every "expect" value in the corpus was
// produced by executing the same pure functions below (see the generator note
// in docs/spec/nfm.md); this test asserts the parsers still agree byte-for-byte.
//
// Run: node --test test/nfm-conformance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWikilinks, extractWikilinks } from '../src/utils/wikilinks.js';
import { parse, serialize } from '../src/utils/blocks.js';
import { splitFrontmatterSource } from '../src/utils/frontmatter-boundary.js';
import { parseFrontmatter, setFrontmatterProperty, removeFrontmatterProperty, inferPropertyType } from '../src/utils/frontmatter.js';
import { extractHeadings, resolveHeadingAnchor } from '../src/utils/headings.js';
import { parseTaskDueText, extractTasks } from '../src/utils/tasks.js';
import { resolveBlockId, inspectBlockIds } from '../src/utils/block-links.js';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/nfm/corpus.json', import.meta.url), 'utf8'));

// ---- dispatcher (kept textually identical to the corpus generator) ----
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

test('corpus is well-formed', () => {
  assert.equal(corpus.version, 1);
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length >= 30, 'at least 30 cases');
  const ids = new Set();
  for (const c of corpus.cases) {
    assert.equal(typeof c.id, 'string');
    assert.ok(!ids.has(c.id), `duplicate case id ${c.id}`);
    ids.add(c.id);
    assert.equal(typeof c.source, 'string', `${c.id}: source must be a string`);
    assert.deepEqual(Object.keys(c.checks).sort(), Object.keys(c.expect).sort(), `${c.id}: checks and expect keys must match`);
  }
});

for (const c of corpus.cases) {
  test(`nfm ${c.feature} :: ${c.id}`, async () => {
    for (const [name, arg] of Object.entries(c.checks)) {
      const actual = await runCheck(name, c.source, arg);
      assert.deepEqual(actual, c.expect[name], `${c.id} / ${name}`);
    }
  });
}
