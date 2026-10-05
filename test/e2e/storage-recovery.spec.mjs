import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Note } from '../../src/core/note.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/core/migrations.js';
import { verifyBackup } from '../../src/core/backup.js';
import { previewRoot } from './support/runtime.mjs';

for (const backend of ['indexeddb', 'localstorage', 'unavailable']) {
  test(`production recovery exports without initializing writers (${backend})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    const original = {
      notes: [
        {
          ...new Note({
            id: 'recovery-note',
            title: 'Saved note',
            content: '---\nunknown: preserved\n---\n# Exact source\n',
          }).toJSON(),
          future: { preserved: true },
        },
      ],
      config: { themeMode: 'light', futureSetting: 'preserved' },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      persistenceStatus: {},
    };
    try {
      if (backend === 'unavailable') {
        await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(previewRoot());
      await expect(page.getByRole('heading', { name: 'This vault is read only' })).toBeVisible();
      expect(await page.evaluate(() => window.app.db.notes.size)).toBe(0);
      await page.evaluate(
        async ({ backend, original }) => {
          if (backend !== 'indexeddb') {
            for (const [key, value] of Object.entries(original))
              localStorage.setItem(`my-notes-app:${key}`, JSON.stringify(value));
            return;
          }
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('my-notes-app', 1);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('kv', 'readwrite');
              for (const [key, value] of Object.entries(original)) tx.objectStore('kv').put(value, key);
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          });
        },
        { backend, original },
      );
      await page.reload();
      await expect(page.getByLabel('Markdown source')).toHaveValue(original.notes[0].content);
      await expect(page.getByLabel('Markdown source')).toHaveAttribute('readonly', '');
      await page.evaluate(() => window.app.ready);
      expect(
        await page.evaluate(() => ({
          ...window.app.db.getPersistenceStatus(),
          editorCreated: Boolean(window.app.editor),
        })),
      ).toMatchObject({
        readOnly: true,
        pendingWrites: 0,
        pendingHistory: 0,
        editorCreated: false,
      });
      const sourceDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download recovery source', exact: true }).click();
      const sourcePath = testInfo.outputPath('recovery-source.json');
      await (await sourceDownload).saveAs(sourcePath);
      // The legacy view plus each backend's own bytes: a fallback copy that the
      // IndexedDB view hides is still exported.
      const { sources, ...exported } = JSON.parse(await readFile(sourcePath, 'utf8'));
      expect(exported).toEqual(original);
      expect(sources).toEqual(
        backend === 'indexeddb'
          ? {
              indexedDB: original,
              localStorage: Object.fromEntries(Object.keys(original).map((key) => [`my-notes-app:${key}`, null])),
            }
          : {
              indexedDB: {},
              localStorage: Object.fromEntries(
                Object.entries(original).map(([key, value]) => [`my-notes-app:${key}`, JSON.stringify(value)]),
              ),
            },
      );
      const backupDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download verified backup', exact: true }).click();
      const backupPath = testInfo.outputPath('recovery-backup.json');
      await (await backupDownload).saveAs(backupPath);
      const backup = await verifyBackup(await readFile(backupPath, 'utf8'));
      expect(backup.notes).toEqual(original.notes);
      expect(backup.config).toMatchObject(original.config);
      await expect(page.getByRole('status')).toContainText('Portable backup verified');
      const archiveDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download storage archive', exact: true }).click();
      const archivePath = testInfo.outputPath('complete-storage.json');
      await (await archiveDownload).saveAs(archivePath);
      const archive = JSON.parse(await readFile(archivePath, 'utf8'));
      expect(archive.indexedDBStatus).toBe(backend === 'unavailable' ? 'unavailable' : 'read');
      const { decodeRecoveryValue } = await import('../../src/core/recovery-archive-codec.js');
      const allSource = decodeRecoveryValue(archive.source);
      if (backend === 'indexeddb')
        expect(allSource.indexedDB.stores.find((store) => store.name === 'kv').entries).toContainEqual([
          'notes',
          original.notes,
        ]);
      else expect(allSource.localStorage['my-notes-app:notes']).toBe(JSON.stringify(original.notes));
      if (backend === 'unavailable') await expect(page.getByRole('status')).toContainText('IndexedDB was unavailable');

      await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('button', { name: 'Theme: dark', exact: true }).click();
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 375, height: 812 },
        { width: 3840, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        expect(
          await page.evaluate(() => {
            const root = document.documentElement;
            return root.scrollHeight <= root.clientHeight && root.scrollWidth <= root.clientWidth;
          }),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 375, height: 812 });
      const statusBounds = await page.getByRole('status').boundingBox();
      const summaryBounds = await page.locator('.storage-recovery__summary').boundingBox();
      expect(statusBounds.y + statusBounds.height).toBeLessThanOrEqual(summaryBounds.y + summaryBounds.height);
      await page.screenshot({ path: testInfo.outputPath('recovery-mobile.png') });
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
      const stored = await page.evaluate(async (backend) => {
        if (backend === 'unavailable')
          return { indexed: null, local: JSON.parse(localStorage.getItem('my-notes-app:notes')) };
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('my-notes-app', 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('kv', 'readonly');
            const values = {};
            const cursor = tx.objectStore('kv').openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (entry) {
                values[entry.key] = entry.value;
                entry.continue();
              }
            };
            tx.oncomplete = () => {
              db.close();
              resolve({ indexed: values, local: JSON.parse(localStorage.getItem('my-notes-app:notes')) });
            };
            tx.onabort = () => reject(tx.error);
          };
          request.onerror = () => reject(request.error);
        });
      }, backend);
      expect(stored.indexed).toEqual(backend === 'indexeddb' ? original : backend === 'unavailable' ? null : {});
      if (backend !== 'indexeddb') expect(stored.local).toEqual(original.notes);
      expect(await page.evaluate(() => window.app.db.getPersistenceStatus().pendingWrites)).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

const startupNote = new Note({ id: 'startup-note', title: 'Original', content: 'Exact original source' }).toJSON();
const startupLegacy = {
  notes: [startupNote],
  config: { unknown: 'preserve' },
  schemaVersion: CURRENT_SCHEMA_VERSION,
  persistenceStatus: {},
};
const startupCurrent = {
  'vault:meta': { generation: 'startup', sequence: 0, schemaVersion: CURRENT_SCHEMA_VERSION },
  'vault:config': { values: { unknown: 'preserve' }, versions: { unknown: 1 } },
  'note:startup-note': { version: 1, value: startupNote },
};

for (const fixture of [
  { name: 'future legacy schema', entries: { ...startupLegacy, schemaVersion: 99 }, legacy: true },
  {
    name: 'malformed legacy notes',
    entries: { ...startupLegacy, notes: { unknown: 'preserve malformed source' } },
    legacy: true,
  },
  {
    name: 'duplicate legacy identities',
    entries: { ...startupLegacy, notes: [startupNote, { ...startupNote, content: 'Second same ID' }] },
    legacy: true,
  },
  {
    name: 'future current schema',
    entries: { ...startupCurrent, 'vault:meta': { generation: 'future', sequence: 0, schemaVersion: 99 } },
  },
  {
    name: 'malformed current source',
    entries: {
      ...startupCurrent,
      'note:startup-note': { version: 1, value: { ...startupNote, content: { unknown: 'retain malformed content' } } },
    },
  },
  { name: 'current records without a marker', entries: { 'note:startup-note': { version: 1, value: startupNote } } },
]) {
  test(`startup preserves original source without offering a converted backup: ${fixture.name}`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(previewRoot());
      await page.waitForFunction(() => Boolean(window.app?.ready));
      await page.evaluate(() => window.app.ready);
      await page.evaluate(async (entries) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open('my-notes-app', 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          for (const [k, v] of Object.entries(entries)) tx.objectStore('kv').put(v, k);
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, fixture.entries);
      await page.reload();
      await page.waitForFunction(() => Boolean(window.app?.ready));
      const outcome = await page.evaluate(() =>
        window.app.ready.then(
          () => 'ready',
          (error) => error.message,
        ),
      );
      expect(outcome).toBe('ready');
      expect(await page.getByRole('button', { name: 'Download verified backup', exact: true }).isDisabled()).toBe(true);
      await expect(page.getByRole('heading', { name: 'This vault is read only' })).toBeVisible();
      await expect(page.locator('[data-reason]')).toContainText(
        /could not|unsupported|invalid|newer|duplicate|without a valid/i,
      );
      expect(
        await page.evaluate(() => ({
          status: window.app.db.getPersistenceStatus(),
          editor: Boolean(window.app.editor),
        })),
      ).toMatchObject({ status: { readOnly: true, pendingWrites: 0, pendingHistory: 0 }, editor: false });
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download recovery source', exact: true }).click();
      const path = testInfo.outputPath('original-source.json');
      await (await download).saveAs(path);
      const exported = JSON.parse(await readFile(path, 'utf8'));
      if (fixture.legacy) {
        const { sources, ...legacy } = exported;
        expect(legacy).toEqual(fixture.entries);
        expect(sources.indexedDB).toEqual(fixture.entries);
      } else {
        expect(exported.vault.meta).toEqual(fixture.entries['vault:meta'] ?? null);
        expect(exported.vault.config).toEqual(fixture.entries['vault:config'] ?? null);
        expect(exported.vault.records).toEqual(
          Object.entries(fixture.entries)
            .filter(([key]) => key.startsWith('note:'))
            .map(([key, value]) => [key.slice(5), value]),
        );
      }
      const stored = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open('my-notes-app', 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const result = await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readonly'),
            values = {},
            r = tx.objectStore('kv').openCursor();
          r.onsuccess = () => {
            const c = r.result;
            if (c) {
              values[c.key] = c.value;
              c.continue();
            }
          };
          tx.oncomplete = () => resolve(values);
          tx.onabort = () => reject(tx.error);
        });
        db.close();
        return result;
      });
      expect(stored).toEqual(fixture.entries);
      expect(errors).toEqual([]);
      if (fixture.name === 'future current schema') {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 375, height: 812 },
        ]) {
          await page.setViewportSize(viewport);
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollHeight <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath('failed-startup-recovery.png') });
      }
    } finally {
      await context.close();
    }
  });
}

test('malformed localStorage JSON remains exportable as exact source bytes', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
    const page = await context.newPage();
    const raw = '{"notes": [ invalid JSON — café';
    await page.goto(previewRoot());
    await page.waitForFunction(() => Boolean(window.app?.ready));
    await page.evaluate(() => window.app.ready);
    await page.evaluate((raw) => localStorage.setItem('my-notes-app:notes', raw), raw);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.app?.ready));
    expect(
      await page.evaluate(() =>
        window.app.ready.then(
          () => 'ready',
          (e) => e.message,
        ),
      ),
    ).toBe('ready');
    expect(await page.getByRole('button', { name: 'Download verified backup', exact: true }).isDisabled()).toBe(true);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recovery source', exact: true }).click();
    const path = testInfo.outputPath('malformed-json-source.json');
    await (await download).saveAs(path);
    expect(JSON.parse(await readFile(path, 'utf8')).localStorage['my-notes-app:notes']).toBe(raw);
    expect(await page.evaluate(() => localStorage.getItem('my-notes-app:notes'))).toBe(raw);
  } finally {
    await context.close();
  }
});

test('unreadable legacy storage disables exports until reload can read the source', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      if (sessionStorage.getItem('deny-source') === 'yes') {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (this === localStorage && key.startsWith('my-notes-app:'))
            throw new DOMException('Saved source access denied', 'SecurityError');
          return getItem.call(this, key);
        };
      }
    });
    const page = await context.newPage();
    await page.goto(previewRoot());
    await page.waitForFunction(() => Boolean(window.app?.ready));
    await page.evaluate(() => window.app.ready);
    await page.evaluate((source) => {
      for (const [key, value] of Object.entries(source))
        localStorage.setItem(`my-notes-app:${key}`, JSON.stringify(value));
      sessionStorage.setItem('deny-source', 'yes');
    }, startupLegacy);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This vault is read only' })).toBeVisible();
    await page.evaluate(() => window.app.ready);
    await expect(page.getByRole('button', { name: 'Download recovery source', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download verified backup', exact: true })).toBeDisabled();
    await expect(page.locator('[data-guidance]')).toContainText('No empty vault has been created');
    expect(await page.evaluate(() => window.app.db.getPersistenceStatus())).toMatchObject({
      readOnly: true,
      pendingWrites: 0,
    });
    await page.evaluate(() => sessionStorage.removeItem('deny-source'));
    await page.getByRole('button', { name: 'Reload vault', exact: true }).click();
    await expect(page.getByLabel('Markdown source')).toHaveValue(startupNote.content);
    await expect(page.getByRole('button', { name: 'Download verified backup', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('my-notes-app:notes')))).toEqual(
      startupLegacy.notes,
    );
  } finally {
    await context.close();
  }
});

for (const extension of ['js', 'css']) {
  test(`basic recovery is available without a lazy recovery ${extension} asset`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await context.route(new RegExp(`/assets/storage-recovery-[^/]+\\.${extension}$`), (route) => route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(previewRoot());
      await expect(page.getByRole('heading', { name: 'This vault is read only' })).toBeVisible();
      expect(errors).toEqual([]);
      await expect(page.getByRole('button', { name: 'Download recovery source', exact: true })).toBeEnabled();
    } finally {
      await context.close();
    }
  });
}

test('storage archive preserves future stores, history and fallback source without converting the vault', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.route('**/seed-recovery.html', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Seed recovery</title>' }),
    );
    await page.goto(new URL('seed-recovery.html', previewRoot()).href);
    await page.evaluate(async () => {
      localStorage.setItem('my-notes-app:notes', '{ malformed legacy bytes');
      localStorage.setItem('my-notes-app:future-setting', 'exact raw value');
      localStorage.setItem('unrelated-application', 'must not export');
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('my-notes-app', 2);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('kv');
          const future = r.result.createObjectStore('future-attachments', { keyPath: 'id', autoIncrement: true });
          future.createIndex('by-kind', 'kind');
        };
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['kv', 'future-attachments'], 'readwrite');
          tx.objectStore('kv').put({ schemaVersion: 99, generation: 'future', sequence: 0 }, 'vault:meta');
          tx.objectStore('kv').put({ unknown: 'history source' }, 'revision:future');
          tx.objectStore('future-attachments').put({ id: 1, kind: 'binary', bytes: new Uint8Array([0, 255, 42]) });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      });
    });
    await page.goto(previewRoot());
    await expect(page.getByRole('heading', { name: 'This vault is read only' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download verified backup', exact: true })).toBeDisabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download storage archive', exact: true }).click();
    const path = testInfo.outputPath('storage-archive.json');
    await (await download).saveAs(path);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.format).toBe('noteforge-storage-archive');
    expect(raw.version).toBe(1);
    // The archive decoder is deliberately separate from portable vault restore.
    const { decodeRecoveryValue } = await import('../../src/core/recovery-archive-codec.js');
    const source = decodeRecoveryValue(raw.source);
    expect(source.indexedDB.version).toBe(2);
    expect(source.indexedDB.stores.find((s) => s.name === 'kv').entries).toContainEqual([
      'revision:future',
      { unknown: 'history source' },
    ]);
    const future = source.indexedDB.stores.find((s) => s.name === 'future-attachments');
    expect(future).toMatchObject({
      keyPath: 'id',
      autoIncrement: true,
      indexes: [{ name: 'by-kind', keyPath: 'kind', unique: false, multiEntry: false }],
    });
    expect(future.entries[0]).toEqual([1, { id: 1, kind: 'binary', bytes: new Uint8Array([0, 255, 42]) }]);
    expect(source.localStorage).toEqual({
      'my-notes-app:notes': '{ malformed legacy bytes',
      'my-notes-app:future-setting': 'exact raw value',
    });
    expect(await page.evaluate(() => window.app.db.getPersistenceStatus())).toMatchObject({
      readOnly: true,
      pendingWrites: 0,
    });
    expect(await page.evaluate(() => localStorage.getItem('unrelated-application'))).toBe('must not export');
  } finally {
    await context.close();
  }
});

for (const failure of ['asset', 'transaction', 'local-read']) {
  test(`archive ${failure} failure leaves recovery usable and never downloads partial source`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      acceptDownloads: true,
      serviceWorkers: failure === 'asset' ? 'block' : 'allow',
    });
    try {
      const page = await context.newPage();
      const downloads = [],
        errors = [];
      page.on('download', (event) => downloads.push(event));
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(previewRoot());
      await page.waitForFunction(() => Boolean(window.app?.ready));
      await page.evaluate(() => window.app.ready);
      let intercepted = 0;
      if (failure === 'asset')
        await page.route('**/assets/storage-archive-*.js', (route) => {
          intercepted++;
          return route.abort();
        });
      else
        await page.evaluate((failure) => {
          localStorage.setItem('my-notes-app:future-value', 'preserve');
          if (failure === 'transaction') {
            const original = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (...args) {
              const tx = original.apply(this, args);
              if (args[1] === 'readonly') queueMicrotask(() => tx.abort());
              return tx;
            };
            window.__restoreArchiveAccess = () => {
              IDBDatabase.prototype.transaction = original;
            };
          } else {
            const original = Storage.prototype.getItem;
            Storage.prototype.getItem = function (key) {
              if (this === localStorage && key.startsWith('my-notes-app:'))
                throw new DOMException('Archive read denied', 'SecurityError');
              return original.call(this, key);
            };
            window.__restoreArchiveAccess = () => {
              Storage.prototype.getItem = original;
            };
          }
        }, failure);
      await page.getByRole('button', { name: 'Download storage archive', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Storage archive could not be exported');
      if (failure === 'asset') expect(intercepted).toBeGreaterThan(0);
      expect(downloads).toHaveLength(0);
      expect(errors).toEqual([]);
      await expect(page.getByRole('button', { name: 'Download storage archive', exact: true })).toBeEnabled();
      if (failure !== 'asset') {
        await page.evaluate(() => window.__restoreArchiveAccess());
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download storage archive', exact: true }).click();
        await (await download).saveAs(testInfo.outputPath('retried-archive.json'));
        await expect(page.getByRole('status')).toContainText('Storage archive exported');
        expect(await page.evaluate(() => localStorage.getItem('my-notes-app:future-value'))).toBe('preserve');
      } else {
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download recovery source', exact: true }).click();
        await (await download).saveAs(testInfo.outputPath('source-after-asset-failure.json'));
      }
    } finally {
      await context.close();
    }
  });
}

test('queued archive open times out and closes a late connection without blocking the next upgrade', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      const connections = new Set();
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const request = open.apply(this, args);
        if (args.length === 1) window.__archiveOpenSeen = true;
        request.addEventListener('success', () => connections.add(request.result));
        return request;
      };
      window.__closeRecoveryConnections = () => {
        for (const db of connections) db.close();
        connections.clear();
      };
    });
    const page = await context.newPage();
    await page.goto(previewRoot());
    await page.waitForFunction(() => Boolean(window.app?.ready));
    await page.evaluate(() => window.app.ready);
    await page.clock.install();
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('my-notes-app', 2);
          request.onblocked = () => resolve('blocked');
          request.onsuccess = () => {
            request.result.close();
            window.__upgradeFinished = true;
          };
          request.onerror = () => reject(request.error);
        }),
    );
    const downloads = [];
    page.on('download', (event) => downloads.push(event));
    await page.getByRole('button', { name: 'Download storage archive', exact: true }).click();
    await page.waitForFunction(() => window.__archiveOpenSeen);
    await page.clock.fastForward(11000);
    await expect(page.getByRole('status')).toContainText('Storage archive open timed out');
    expect(downloads).toHaveLength(0);
    await page.evaluate(() => window.__closeRecoveryConnections());
    await page.waitForFunction(() => window.__upgradeFinished);
    expect(
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('my-notes-app', 3);
            request.onblocked = () => resolve('blocked');
            request.onsuccess = () => {
              request.result.close();
              resolve('upgraded');
            };
            request.onerror = () => reject(request.error);
          }),
      ),
    ).toBe('upgraded');
  } finally {
    await context.close();
  }
});
