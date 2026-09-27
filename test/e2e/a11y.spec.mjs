// axe-core scans of the production build, held to a ratchet: a surface may never
// report more violating nodes for a rule than test/e2e/a11y-baseline.json allows,
// and a rule absent from its entry is allowed zero. Since Phase 1 sprint 1 the
// baseline is empty, so any violation on any scanned surface fails. The
// mechanism stays for new surfaces: scan them, fix them, and never raise it.
// Regenerate (only ever downward) with
//   UPDATE_A11Y_BASELINE=1 npm run test:a11y
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
        for (const node of violation.nodes.slice(0, 5)) {
          detail.push(`    ${node.target.join(' ')}`);
          const summary = (node.failureSummary || '').split('\n').slice(1).join(' ').trim();
          if (summary) detail.push(`      ${summary}`);
        }
      }
      measured[scan.key] = counts;

      // Phase 1 exit criterion: no emoji or Unicode pictographs as UI chrome.
      // User content (note titles, previews, body, tags, saved-view icons) may
      // hold emoji; keyboard hints may show the Command key symbol.
      const pictographs = await page.evaluate(() => {
        const GLYPH = /[\u2190-\u21FF\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\u{1F300}-\u{1FAFF}]/u;
        const USER =
          '.editor__blocks, .editor__title, .note-item, .palette__label, .palette__sub, .workspace-tab, .backlinks, ' +
          '.outline, .breadcrumbs, .chip, .tag-chip, .saved-search-row, .trash-item, .archive-item, .task-card, ' +
          '.calendar-agenda, .calendar-day, .properties-row, .menu__hint, kbd, .graph svg';
        const chrome = document.querySelectorAll(
          'button, [role="button"], [role="tab"], [role="menuitem"], h1, h2, h3, .menu__item, .palette__icon, .modal__title',
        );
        const hits = [];
        for (const element of chrome) {
          if (element.closest(USER) || !element.getClientRects().length) continue;
          const own = [...element.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join('');
          if (GLYPH.test(own))
            hits.push(
              `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${element.className}: ${own.trim()}`,
            );
        }
        return hits;
      });
      expect(pictographs, `emoji or pictographs used as chrome on ${scan.key}`).toEqual([]);
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
