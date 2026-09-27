// Budget policy v2: route closures and entry resolution over a synthetic
// manifest shaped like Vite's (test/bundle-budget.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closure, resolveEntry } from './bundle-budget.mjs';

const manifest = {
  'index.html': { file: 'assets/index-A.js', isEntry: true, css: ['assets/index-A.css'], imports: ['_shared-S.js'] },
  '_shared-S.js': { file: 'assets/shared-S.js' },
  'src/components/graph.js': {
    file: 'assets/graph-G.js',
    isDynamicEntry: true,
    css: ['assets/graph-G.css'],
    imports: ['index.html', '_util-U.js'],
    dynamicImports: ['src/components/lazy.js'],
  },
  '_util-U.js': { file: 'assets/util-U.js', imports: ['_shared-S.js'] },
  'src/components/lazy.js': { file: 'assets/lazy-L.js', isDynamicEntry: true },
  '_phase6-P.js': { file: 'assets/phase6-P.js', name: 'phase6', isDynamicEntry: true, imports: ['index.html'] },
};

test('closure follows static imports and stylesheets recursively, never dynamic imports', () => {
  const files = [...closure(manifest, 'src/components/graph.js')].sort();
  assert.deepEqual(files, [
    'assets/graph-G.css',
    'assets/graph-G.js',
    'assets/index-A.css',
    'assets/index-A.js',
    'assets/shared-S.js',
    'assets/util-U.js',
  ]);
});

test('closure terminates on import cycles', () => {
  const cyclic = { a: { file: 'a.js', imports: ['b'] }, b: { file: 'b.js', imports: ['a'] } };
  assert.deepEqual([...closure(cyclic, 'a')].sort(), ['a.js', 'b.js']);
});

test('resolveEntry prefers the exact key, then a dynamic entry named after the file stem', () => {
  assert.equal(resolveEntry(manifest, 'src/components/graph.js'), 'src/components/graph.js');
  assert.equal(resolveEntry(manifest, 'src/app/phase6.js'), '_phase6-P.js');
});

test('resolveEntry fails loudly for a module the build does not contain', () => {
  assert.throws(() => resolveEntry(manifest, 'src/components/removed.js'), /not in the build manifest/);
});

test('measure counts a route entry folded into another chunk where it lives, and fails on a deleted module', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { measure } = await import('./bundle-budget.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'nf-budget-'));
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'dist', 'assets', 'index-A.js'), 'console.log(1)');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ 'index.html': { file: 'assets/index-A.js', isEntry: true } }),
  );
  const budgets = (entry) => {
    writeFileSync(
      join(dir, 'budgets.json'),
      JSON.stringify({
        routes: { shell: { entries: ['index.html'], gzipBudget: 1e6 }, lazy: { entries: [entry], gzipBudget: 1e6 } },
      }),
    );
    return {
      dist: join(dir, 'dist'),
      manifestPath: join(dir, 'manifest.json'),
      budgetsPath: join(dir, 'budgets.json'),
    };
  };
  // src/utils/helpers.js exists but has no chunk of its own in this manifest.
  const results = measure(budgets('src/utils/helpers.js'));
  assert.deepEqual(results.merged, ['lazy: src/utils/helpers.js']);
  assert.equal(results.find((r) => r.name === 'lazy').files.length, 0);
  assert.throws(() => measure(budgets('src/utils/removed-module.js')), /not in the build manifest/);
});

test('resolveEntry resolves chunk:<name> to a named vendor group and fails when it is missing', () => {
  const grouped = { '_yaml-vendor-Y.js': { file: 'assets/yaml-vendor-Y.js', name: 'yaml-vendor' } };
  assert.equal(resolveEntry(grouped, 'chunk:yaml-vendor'), '_yaml-vendor-Y.js');
  assert.throws(() => resolveEntry(grouped, 'chunk:missing'), /not in the build manifest/);
});
