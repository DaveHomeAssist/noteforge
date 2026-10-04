import assert from 'node:assert/strict';
import { captureRuntimeErrors, newAppContext, TIMEOUT } from './runtime.mjs';

/**
 * Explicit disposable fixture for application behavior after activation.
 * Fresh-profile startup must remain read only until the old-client gate passes.
 * This helper neither changes that product gate nor proves safe migration.
 */
export async function activatedAppContext(browser, url, options = {}, runtimeErrors = []) {
  const context = await newAppContext(browser, options);
  try {
    const seed = await context.newPage();
    captureRuntimeErrors(seed, runtimeErrors);
    await seed.goto(url, { waitUntil: 'load', timeout: TIMEOUT });
    await seed.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    const before = await seed.evaluate(async () => {
      await window.app.ready;
      const db = window.app.db;
      return { readOnly: db.getPersistenceStatus().readOnly, notes: db.notes.size, editor: Boolean(window.app.editor) };
    });
    assert.deepEqual(
      before,
      { readOnly: true, notes: 0, editor: false },
      'fixture must start in an empty recovery reader',
    );
    const activated = await seed.evaluate(async () => {
      const db = window.app.db;
      await db.init({ allowLegacyMigration: true });
      const snapshot = await db.storage.readCurrentVault();
      return {
        generation: snapshot.meta?.generation,
        notes: snapshot.records.length,
        conflicts: snapshot.conflicts.length,
      };
    });
    assert.equal(typeof activated.generation, 'string', 'synthetic activation must commit');
    assert.equal(activated.notes, 0, 'fixture activation must not import user data');
    assert.equal(activated.conflicts, 0);
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
