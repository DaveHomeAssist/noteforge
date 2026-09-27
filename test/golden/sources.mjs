// The golden-corpus source list: every seed note plus every note in the
// schema-v3 comprehensive fixture. Shared by the Node golden test, the browser
// capture page (capture.html), the features.html comparison, and update.mjs, so
// all of them agree on slugs, titles, and sources. Runs in Node and the browser.

import { sampleNotes } from '../../src/app/seed.js';

const FIXTURE_URL = new URL('../fixtures/schema-v3-comprehensive.json', import.meta.url);

async function loadFixture() {
  if (typeof window === 'undefined') {
    // Computed specifier keeps Vite from trying to bundle a Node builtin.
    const fs = await import(/* @vite-ignore */ `node:${'fs'}`);
    return JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
  }
  return (await fetch(FIXTURE_URL)).json();
}

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

/** @returns {Promise<Array<{ slug: string, title: string, source: string }>>} */
export async function goldenSources() {
  const fixture = await loadFixture();
  const pad = (n) => String(n).padStart(2, '0');
  const seed = sampleNotes.map((note, i) => ({
    slug: `seed-${pad(i + 1)}-${slugify(note.title)}`,
    title: note.title,
    source: note.content,
  }));
  const v3 = (fixture.notes || []).map((note, i) => ({
    slug: `v3-${pad(i + 1)}-${slugify(note.title)}`,
    title: note.title,
    source: note.content,
  }));
  return [...seed, ...v3];
}

/** Drop per-instance block ids so the golden only carries type, text, and meta. */
export const stripBlocks = (blocks) => blocks.map((b) => ({ type: b.type, text: b.text, meta: b.meta || {} }));
