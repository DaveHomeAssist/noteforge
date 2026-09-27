// Budget policy v2 (Phase 0 · Sprint 3): per-route gzip budgets measured from a
// finished `dist/` and Vite's build manifest (moved to build-meta/ by the build).
//
// A route's size is the gzip size of the files a user downloads for it. `shell`
// is index.html plus every CSS and JavaScript file the entry loads before the app
// is usable; every other route counts only what it adds on top of the shell (its
// lazy chunks, their static imports, and their stylesheets). `precache` is every
// file the service worker stores for offline use. Budgets and route definitions
// live in test/bundle-budgets.json; the policy and the raise procedure live in
// docs/implementation/performance_budgets.md.
//
// Run after `npm run build`; exits 1 when a route is over budget, 2 when the build
// or manifest is missing or a route names a module the build does not contain.
//   node test/bundle-budget.mjs            # check
//   node test/bundle-budget.mjs --json     # machine-readable measurements

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DIST = resolve(ROOT, 'dist');
export const MANIFEST = resolve(ROOT, 'build-meta', 'manifest.json');
export const BUDGETS = resolve(ROOT, 'test', 'bundle-budgets.json');

export function gzipBytes(buffer) {
  return gzipSync(buffer, { level: 9 }).length;
}

/** Resolve a route entry to its manifest key: exact key, else a dynamic entry whose chunk name is the file stem. */
export function resolveEntry(manifest, entry) {
  if (manifest[entry]) return entry;
  const stem = entry
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');
  const matches = Object.keys(manifest).filter((key) => manifest[key].name === stem && manifest[key].isDynamicEntry);
  if (matches.length === 1) return matches[0];
  throw new Error(
    `Route entry ${entry} is not in the build manifest${matches.length ? ` (ambiguous: ${matches.join(', ')})` : ''}`,
  );
}

/** Every file a manifest key loads eagerly: its own file, its CSS, and its static imports, recursively. */
export function closure(manifest, key, files = new Set(), seen = new Set()) {
  if (seen.has(key)) return files;
  seen.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Manifest has no entry ${key}`);
  if (chunk.file && !chunk.file.endsWith('.html')) files.add(chunk.file);
  for (const css of chunk.css || []) files.add(css);
  for (const imported of chunk.imports || []) closure(manifest, imported, files, seen);
  return files;
}

function allSiteFiles(dist, dir = dist, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = resolve(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) out.push(...allSiteFiles(dist, absolute, relative));
    else out.push(relative);
  }
  return out;
}

export function measure({ dist = DIST, manifestPath = MANIFEST, budgetsPath = BUDGETS } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { routes } = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const sizes = new Map();
  const size = (file) => {
    if (!sizes.has(file)) {
      const buffer = readFileSync(resolve(dist, file));
      sizes.set(file, { raw: buffer.length, gzip: gzipBytes(buffer) });
    }
    return sizes.get(file);
  };
  const shellFiles = new Set(['index.html', ...closure(manifest, 'index.html')]);
  const results = [];
  for (const [name, route] of Object.entries(routes)) {
    let files;
    if (route.all) {
      files = allSiteFiles(dist).filter((file) => file !== 'sw.js');
    } else if (name === 'shell') {
      files = [...shellFiles];
    } else {
      const set = new Set();
      for (const entry of route.entries) closure(manifest, resolveEntry(manifest, entry), set);
      files = [...set].filter((file) => !shellFiles.has(file));
    }
    files.sort();
    const measured = files.map((file) => ({ file, ...size(file) }));
    const raw = measured.reduce((sum, f) => sum + f.raw, 0);
    const gzip = measured.reduce((sum, f) => sum + f.gzip, 0);
    results.push({
      name,
      description: route.description,
      files: measured,
      raw,
      gzip,
      budget: route.gzipBudget,
      within: gzip <= route.gzipBudget,
    });
  }
  return results;
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let results;
  try {
    results = measure();
  } catch (error) {
    console.error(`Bundle budget: cannot measure (run \`npm run build\` first): ${error.message}`);
    process.exit(2);
  }
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        results.map(({ name, raw, gzip, budget, files }) => ({ name, raw, gzip, budget, files: files.length })),
        null,
        2,
      ),
    );
  } else {
    console.log('route        files       raw      gzip    budget   headroom');
    for (const r of results) {
      const headroom = r.budget - r.gzip;
      console.log(
        `${r.name.padEnd(12)} ${String(r.files.length).padStart(5)} ${kib(r.raw).padStart(11)} ${kib(r.gzip).padStart(10)} ${kib(r.budget).padStart(10)} ${`${headroom >= 0 ? '' : '-'}${kib(Math.abs(headroom))}`.padStart(10)}${r.within ? '' : '  OVER'}`,
      );
    }
  }
  const over = results.filter((r) => !r.within);
  if (over.length) {
    console.error(
      `Bundle budget: ${over.map((r) => r.name).join(', ')} over budget (test/bundle-budgets.json; raise procedure in docs/implementation/performance_budgets.md)`,
    );
    process.exit(1);
  }
}
