// End-to-end smokes against the real app: seven drive the Vite dev server, the
// last drives the production build offline through its service worker. Each
// smoke is fail-fast and returns its PASS lines, attached to the report.
import { devUrl, previewRoot } from './support/runtime.mjs';
import {
  runLinkIntegritySmoke,
  runPhase3Smoke,
  runPhase4Smoke,
  runPhase5Smoke,
  runPhase6Smoke,
  runPhase7Smoke,
  runProductionOfflineSmoke,
  runRecoverySmoke,
} from './support/smokes.mjs';
import { expect, test } from './support/test.mjs';

const DEV_SMOKES = [
  ['recovery: history, backup center, restore', runRecoverySmoke],
  ['link integrity: backlinks, rename, mentions, aliases', runLinkIntegritySmoke],
  ['phase 3: find/replace, saved views, archive, bulk actions', runPhase3Smoke],
  ['phase 4: daily notes, capture, tasks, calendar', runPhase4Smoke],
  ['phase 5: properties, YAML, block links, transclusion', runPhase5Smoke],
  ['phase 6: workspace, clipper, folder reconciliation', runPhase6Smoke],
  ['phase 7: integrated release candidate', runPhase7Smoke],
];

async function report(testInfo, output) {
  const passes = output.split('\n').filter((line) => line.startsWith('PASS'));
  testInfo.annotations.push({ type: 'checks', description: `${passes.length} passed` });
  await testInfo.attach('checks.txt', { body: output, contentType: 'text/plain' });
  expect(passes.length, 'smoke reported no checks').toBeGreaterThan(0);
}

for (const [title, run] of DEV_SMOKES) {
  test(`smoke — ${title}`, async ({ browser, runtimeErrors }, testInfo) => {
    await report(testInfo, await run(browser, devUrl(), runtimeErrors));
  });
}

test('smoke — production build offline through the service worker', async ({ browser, runtimeErrors }, testInfo) => {
  await report(testInfo, await runProductionOfflineSmoke(browser, previewRoot(), runtimeErrors));
});
