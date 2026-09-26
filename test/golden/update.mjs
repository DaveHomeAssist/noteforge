// Regenerates the golden corpus. Run deliberately, review the diff, and explain
// the behavior change in the commit:
//
//   node test/golden/update.mjs            # blocks + render
//   node test/golden/update.mjs --blocks   # parse()/serialize() shape (Node)
//   node test/golden/update.mjs --render   # renderMarkdown() HTML (browser via Vite + Playwright)

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize } from '../../src/utils/blocks.js';
import { goldenSources, stripBlocks } from './sources.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(DIR, '..', '..');
const flags = process.argv.slice(2);
const wants = (flag) => flags.includes(flag) || !flags.some((f) => f === '--blocks' || f === '--render');

function replaceDir(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const stale of readdirSync(dir)) rmSync(resolve(dir, stale));
  for (const [name, content] of files) writeFileSync(resolve(dir, name), content);
}

const sources = await goldenSources();

if (wants('--blocks')) {
  const files = sources.map((s) => {
    const blocks = parse(s.source);
    const serialized = serialize(blocks);
    const golden = { slug: s.slug, title: s.title, source: s.source, roundTrip: serialized === s.source, serialized, blocks: stripBlocks(blocks) };
    return [`${s.slug}.json`, `${JSON.stringify(golden, null, 2)}\n`];
  });
  replaceDir(resolve(DIR, 'blocks'), files);
  console.log(`blocks: wrote ${files.length} goldens (${files.filter(([, c]) => c.includes('"roundTrip": true')).length} byte-identical round trips)`);
}

if (wants('--render')) {
  const { createServer } = await import('vite');
  const { chromium } = await import('playwright');
  const server = await createServer({ root: REPO_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}test/golden/capture.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.title === 'golden ready', undefined, { timeout: 30_000 });
    if (errors.length) throw new Error(`capture page errors: ${errors.join('; ')}`);
    const html = await page.evaluate(() => window.__golden);
    const files = sources.map((s) => [`${s.slug}.html`, html[s.slug]]);
    replaceDir(resolve(DIR, 'render'), files);
    console.log(`render: wrote ${files.length} goldens`);
  } finally {
    await browser.close();
    await server.close();
  }
}
