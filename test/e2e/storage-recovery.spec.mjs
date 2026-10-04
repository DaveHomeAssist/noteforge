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
      expect(JSON.parse(await readFile(sourcePath, 'utf8'))).toEqual(original);
      const backupDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download verified backup', exact: true }).click();
      const backupPath = testInfo.outputPath('recovery-backup.json');
      await (await backupDownload).saveAs(backupPath);
      const backup = await verifyBackup(await readFile(backupPath, 'utf8'));
      expect(backup.notes).toEqual(original.notes);
      expect(backup.config).toMatchObject(original.config);
      await expect(page.getByRole('status')).toContainText('Portable backup verified');
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
      if (fixture.legacy) expect(exported).toEqual(fixture.entries);
      else {
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
