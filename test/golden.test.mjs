// Golden corpus (Phase 0): parse()/serialize() output for every seed note and
// schema-v3 fixture note must stay byte-identical. A deliberate change is made
// with `node test/golden/update.mjs --blocks` and explained in the commit.
// The renderMarkdown() half lives in test/golden/render/ and is compared in the
// browser suite (test/features.html); here we only require the files to exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse, serialize } from '../src/utils/blocks.js';
import { goldenSources, stripBlocks } from './golden/sources.mjs';

const sources = await goldenSources();
const HINT = 'run `node test/golden/update.mjs --blocks` only if the change is intended';

test('golden corpus covers every seed and fixture note', () => {
  assert.ok(sources.length >= 11, `expected at least 11 sources, got ${sources.length}`);
  assert.equal(new Set(sources.map((s) => s.slug)).size, sources.length, 'slugs must be unique');
});

for (const s of sources) {
  test(`golden blocks: ${s.slug}`, () => {
    const file = new URL(`./golden/blocks/${s.slug}.json`, import.meta.url);
    assert.ok(existsSync(file), `missing golden ${s.slug}.json — ${HINT}`);
    const golden = JSON.parse(readFileSync(file, 'utf8'));
    const blocks = parse(s.source);
    const serialized = serialize(blocks);
    assert.equal(s.source, golden.source, `source text changed for ${s.slug} — ${HINT}`);
    assert.deepEqual(stripBlocks(blocks), golden.blocks, `parse() shape changed for ${s.slug} — ${HINT}`);
    assert.equal(serialized, golden.serialized, `serialize() output changed for ${s.slug} — ${HINT}`);
    assert.equal(serialized === s.source, golden.roundTrip, `round-trip fidelity changed for ${s.slug} — ${HINT}`);
  });
  test(`golden render file present: ${s.slug}`, () => {
    const file = new URL(`./golden/render/${s.slug}.html`, import.meta.url);
    // A blank note renders to an empty file; existence is the contract, the bytes are compared in features.html.
    assert.ok(existsSync(file), `missing render golden ${s.slug}.html — run node test/golden/update.mjs --render`);
  });
}
