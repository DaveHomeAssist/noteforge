import assert from 'node:assert/strict';
import { captureRuntimeErrors, newAppContext, TIMEOUT } from './runtime.mjs';

/**
 * Disposable fixture for application behavior after activation. A fresh profile
 * activates a per-note vault on its first open (NF-DUR-MIG-01 = C) and receives the
 * ordinary first-run notes; with no legacy data there is nothing to capture and no
 * upgrade notice.
 */
export async function activatedAppContext(browser, url, options = {}, runtimeErrors = []) {
  const context = await newAppContext(browser, options);
  try {
    const seed = await context.newPage();
    captureRuntimeErrors(seed, runtimeErrors);
    await seed.goto(url, { waitUntil: 'load', timeout: TIMEOUT });
    await seed.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    const activated = await seed.evaluate(async () => {
      await window.app.ready;
      const db = window.app.db;
      const snapshot = await db.storage.readCurrentVault();
      return {
        readOnly: db.getPersistenceStatus().readOnly,
        upgraded: db.upgradedLegacyVault,
        notice: Boolean(document.querySelector('.storage-error--upgrade')),
        generation: typeof snapshot.meta?.generation,
        conflicts: snapshot.conflicts.length,
      };
    });
    assert.deepEqual(
      activated,
      { readOnly: false, upgraded: false, notice: false, generation: 'string', conflicts: 0 },
      'a fresh profile must activate without legacy data, a notice or review items',
    );
    if (options.serviceWorkers === 'allow') {
      // Keep the installing worker's first client alive until it claims that
      // client. Otherwise closing the seed can race the caller's navigation.
      await seed.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 20_000 });
    }
    await seed.close();
    // The caller opens a new app instance against the activated synthetic vault.
    // No production instance receives a test-only flag or a bypass URL.
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
