import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

// Exact deployed storage code is intentionally preserved as a fixture. These
// tests demonstrate why a version bump alone cannot authorize migration.
test('a legacy open connection blocks an IndexedDB version upgrade', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('test/durability.html', devUrl()).href);
    const observed = await page.evaluate(async () => {
      const { storage } = await import('./fixtures/legacy/storage-7114047.js');
      await storage.ready();
      return new Promise((resolve, reject) => {
        const upgrade = indexedDB.open('my-notes-app', 2);
        upgrade.onblocked = () => resolve('blocked');
        upgrade.onupgradeneeded = () => {
          upgrade.transaction.abort();
          resolve('unexpected-upgrade');
        };
        upgrade.onerror = () => reject(upgrade.error);
      });
    });
    expect(observed).toBe('blocked');
  } finally {
    await context.close();
  }
});

test('a freshly loaded legacy client acknowledges fallback writes after a naive version bump', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('test/durability.html', devUrl()).href);
    const observed = await page.evaluate(async () => {
      const native = await new Promise((resolve, reject) => {
        const request = indexedDB.open('my-notes-app', 2);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const { storage } = await import('./fixtures/legacy/storage-7114047.js');
      const indexedDBReady = await storage.ready();
      const acknowledged = await storage.save('notes', [{ id: 'legacy-draft', content: 'Fallback edit' }]);
      const fallback = JSON.parse(localStorage.getItem('my-notes-app:notes'));
      const current = await new Promise((resolve, reject) => {
        const request = native.transaction('kv', 'readonly').objectStore('kv').get('notes');
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      native.close();
      return { indexedDBReady, acknowledged, fallback, current };
    });
    expect(observed).toEqual({
      indexedDBReady: false,
      acknowledged: true,
      fallback: [{ id: 'legacy-draft', content: 'Fallback edit' }],
      current: null,
    });
  } finally {
    await context.close();
  }
});
