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
