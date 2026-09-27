// axe-core scans of the production build, held to a ratchet: a surface may never
// report more violating nodes for a rule than test/e2e/a11y-baseline.json allows,
// and a rule absent from its entry is allowed zero. Fixing violations is Phase 1
// work (exit criterion: axe clean); when a count drops, lower the baseline with
//   UPDATE_A11Y_BASELINE=1 npm run test:a11y
// and commit it, so the count can only go down.
import { readFileSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { SURFACES, openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

const BASELINE_URL = new URL('./a11y-baseline.json', import.meta.url);
const UPDATE = Boolean(process.env.UPDATE_A11Y_BASELINE);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_URL, 'utf8')).surfaces || {};
  } catch {
    return {};
  }
}

const baseline = readBaseline();
const measured = {};

const SCANS = [
  ...Object.keys(SURFACES).flatMap((surface) =>
    ['light', 'dark'].map((theme) => ({ key: `${surface}@1440/${theme}`, surface, theme, viewport: 1440 })),
  ),
  { key: 'shell@390/light', surface: 'shell', theme: 'light', viewport: 390 },
  { key: 'shell@390/dark', surface: 'shell', theme: 'dark', viewport: 390 },
];

test.describe.configure({ mode: 'serial' });

for (const scan of SCANS) {
  test(`axe — ${scan.key}`, async ({ browser, runtimeErrors }, testInfo) => {
    const { context, page } = await openSurface(browser, { ...scan, runtimeErrors });
    try {
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const counts = {};
      const detail = [];
      for (const violation of results.violations) {
        counts[violation.id] = violation.nodes.length;
        detail.push(`${violation.id} (${violation.impact}) × ${violation.nodes.length}: ${violation.help}`);
        for (const node of violation.nodes.slice(0, 5)) detail.push(`    ${node.target.join(' ')}`);
      }
      measured[scan.key] = counts;
      if (detail.length)
        await testInfo.attach('axe-violations.txt', { body: detail.join('\n'), contentType: 'text/plain' });
      if (UPDATE) return;

      const allowed = baseline[scan.key] || {};
      const regressions = Object.entries(counts)
        .filter(([rule, count]) => count > (allowed[rule] || 0))
        .map(([rule, count]) => `${rule}: ${count} node(s), baseline allows ${allowed[rule] || 0}`);
      const improvements = Object.entries(allowed)
        .filter(([rule, count]) => (counts[rule] || 0) < count)
        .map(([rule, count]) => `${rule}: ${counts[rule] || 0} (baseline ${count})`);
      if (improvements.length) {
        testInfo.annotations.push({
          type: 'a11y-improved',
          description: `${improvements.join('; ')}. Lower the baseline: UPDATE_A11Y_BASELINE=1 npm run test:a11y`,
        });
      }
      expect(regressions, `new accessibility violations on ${scan.key}`).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test.afterAll(() => {
  if (!UPDATE) return;
  const surfaces = Object.fromEntries(
    Object.keys(measured)
      .sort()
      .map((key) => [key, measured[key]]),
  );
  const total = Object.values(surfaces).reduce(
    (sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0),
    0,
  );
  writeFileSync(
    BASELINE_URL,
    `${JSON.stringify({ tool: 'axe-core', tags: TAGS, totalViolatingNodes: total, surfaces }, null, 2)}\n`,
  );
});
