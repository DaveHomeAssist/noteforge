// Enforce the Phase 0 build budget from docs/implementation/performance_budgets.md
// against a finished `dist/` instead of relying on hand-recorded byte counts.
//
// The initial shell is the uncompressed dist/index.html plus every CSS and
// JavaScript file it references directly. Lazy chunks, hashes, and source maps
// do not count. Run after `npm run build`; exits non-zero above the ceiling.

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const INITIAL_SHELL_CEILING_BYTES = 257_180;

const DIST = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');

/** Directly referenced same-origin CSS/JS asset paths, relative to dist/. */
export function directAssetPaths(html) {
  const paths = new Set();
  const attribute = /(?:src|href)=["']?([^"'\s>]+)/g;
  for (const match of html.matchAll(attribute)) {
    const value = match[1];
    if (/^(?:https?:)?\/\//i.test(value) || value.startsWith('data:')) continue;
    if (!/\.(?:css|js)$/i.test(value)) continue;
    const index = value.indexOf('assets/');
    if (index < 0) continue;
    paths.add(value.slice(index));
  }
  return [...paths].sort();
}

export async function measureInitialShell(dist = DIST) {
  const htmlPath = resolve(dist, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const files = [{ path: 'index.html', bytes: (await stat(htmlPath)).size }];
  for (const asset of directAssetPaths(html)) {
    files.push({ path: asset, bytes: (await stat(resolve(dist, asset))).size });
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return { files, total, ceiling: INITIAL_SHELL_CEILING_BYTES, withinBudget: total <= INITIAL_SHELL_CEILING_BYTES };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = await measureInitialShell();
  } catch (error) {
    console.error(`Bundle budget: could not measure dist/ (run \`npm run build\` first): ${error.message}`);
    process.exit(2);
  }
  for (const file of result.files) console.log(`${String(file.bytes).padStart(9)}  ${file.path}`);
  const margin = result.ceiling - result.total;
  console.log(`${String(result.total).padStart(9)}  initial shell total (ceiling ${result.ceiling}, ${margin >= 0 ? `${margin} bytes below` : `${-margin} bytes ABOVE`})`);
  if (!result.withinBudget) {
    console.error('Bundle budget: initial shell exceeds the authoritative ceiling in docs/implementation/performance_budgets.md');
    process.exit(1);
  }
}
