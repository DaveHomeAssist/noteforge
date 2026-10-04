// Playwright Test configuration (Phase 0 · Sprint 3). Replaces the hand-rolled
// test/run-features.mjs runner.
//
//   npm run test:browser   features + smokes (Vite dev server and production preview)
//   npm run test:a11y      axe scans of the production build, gated by a ratchet
//   npm run test:visual    screenshot baselines; compared only inside the pinned
//                          mcr.microsoft.com/playwright container (CI job `visual`)
//
// Global setup starts one Vite dev server (warmed so its dependency optimizer
// cannot reload mid-test) and one preview of a fresh production build, and hands
// their URLs to the workers through environment variables.
import { defineConfig } from '@playwright/test';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  outputDir: 'test-results/playwright',
  snapshotPathTemplate: 'test/e2e/__screenshots__/{testFileName}/{arg}{ext}',
  globalSetup: './test/e2e/global-setup.mjs',
  // The smokes share one dev server and exercise IndexedDB, service workers, and
  // downloads; they run one at a time, as they always have.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/playwright-junit.xml' }],
    ['html', { open: 'never', outputFolder: 'test-results/playwright-report' }],
  ],
  use: {
    // Bundled Chromium by default; PW_CHANNEL=chrome uses an installed Chrome.
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    ...['chromium', 'firefox', 'webkit'].map((browserName) => ({
      name: `durability-${browserName}`,
      testMatch: ['durability.spec.mjs', 'vault-transactions.spec.mjs', 'legacy-storage.spec.mjs', 'storage-recovery.spec.mjs', 'conflict-recovery.spec.mjs'],
      use: { browserName, channel: undefined },
    })),
    {
      name: 'features',
      testMatch: ['features.spec.mjs', 'smokes.spec.mjs', 'dialogs.spec.mjs', 'shell.spec.mjs', 'banner.spec.mjs'],
    },
    { name: 'a11y', testMatch: 'a11y.spec.mjs' },
    // No retries: rendering is deterministic in the pinned container, and a retry
    // would compare against a baseline the first attempt just wrote.
    { name: 'visual', testMatch: 'visual.spec.mjs', retries: 0, timeout: 60_000 },
  ],
});
