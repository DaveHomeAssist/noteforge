import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { devUrl } from './support/runtime.mjs';

async function openHistory(context) {
  const writer = await context.newPage();
  await writer.goto(new URL('test/durability.html', devUrl()).href);
  await writer.evaluate(async () => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { RevisionStore } = await import('../src/core/revision-store.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    const note = new Note({ id: 'a', title: 'History destination', content: 'Current content' });
    await storage.saveMany([
      ['notes', [note.toJSON()]],
      ['config', {}],
      ['schemaVersion', CURRENT_SCHEMA_VERSION],
    ]);
    window.db = new Database({ storageBackend: storage, onNotesPersisted: async () => {} });
    // Synthetic activation only; actual cached-client migration remains gated.
    await window.db.init({ allowLegacyMigration: true });
    const revisions = new RevisionStore(storage);
    await revisions.capture({ ...note.toJSON(), content: 'Selected revision' }, { reason: 'manual', force: true });
    window.save = async (content) => {
      const current = window.db.getNote('a');
      current.update({ content });
      window.db.saveNote(current);
      return window.db.flushCurrentWrites();
    };
    window.savedContent = async () =>
      (await storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content;
  });
  const app = await context.newPage();
  await app.goto(devUrl());
  await app.evaluate(async () => {
    await window.app.ready;
    await window.app.vaultRefreshReady;
    await window.app.openNote('a');
    await window.app.db.flush();
  });
  await app.locator('#menu-btn').click();
  await app.locator('#history-btn').click();
  await expect(app.locator('#history-restore')).toBeEnabled();
  await expect(app.locator('#history-diff')).toContainText('Current content');
  await app.evaluate(() => {
    window.confirmations = 0;
    window.app.history.confirmRestore = async () => {
      window.confirmations++;
      return true;
    };
  });
  return { app, writer };
}

test('history rejects a stale comparison and refreshes before a separately confirmed restore', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    expect(await writer.evaluate(() => window.save('Acknowledged elsewhere'))).toBe(true);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-status')).toContainText('Refresh the comparison');
    await expect(app.locator('#history-restore')).toBeDisabled();
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
    await app.locator('#history-refresh').click();
    await expect(app.locator('#history-diff')).toContainText('Acknowledged elsewhere');
    await expect(app.locator('#history-restore')).toBeEnabled();
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
    expect(await app.evaluate(() => window.confirmations)).toBe(1);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-status')).toContainText('Revision restored.');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Selected revision');
    expect(await app.evaluate(() => window.confirmations)).toBe(2);
    expect(
      await app.evaluate(async () => {
        const revisions = await window.app.recovery.listRevisions('a');
        const safety = revisions.find((revision) => revision.reason === 'pre_restore');
        return (await window.app.recovery.revisions.materialize(safety.id)).content;
      }),
    ).toBe('Acknowledged elsewhere');
  } finally {
    await context.close();
  }
});

test('history retains an edit made while confirmation is pending', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    await app.evaluate(() => {
      window.app.history.confirmRestore = () =>
        new Promise((resolve) => {
          window.confirmRestore = resolve;
        });
    });
    await app.locator('#history-restore').click();
    await app.waitForFunction(() => window.confirmRestore);
    expect(
      await app.evaluate(async () => {
        const note = window.app.db.getNote('a');
        note.update({ content: 'Acknowledged during confirmation' });
        window.app.db.saveNote(note);
        return window.app.db.flushCurrentWrites();
      }),
    ).toBe(true);
    await app.evaluate(() => window.confirmRestore(true));
    await expect(app.locator('#history-status')).toContainText('Refresh the comparison');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged during confirmation');
  } finally {
    await context.close();
  }
});

test('dismissed history confirmation cannot restore or replace a reopened preview', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    await app.evaluate(() => {
      window.app.history.confirmRestore = () =>
        new Promise((resolve) => {
          window.confirmRestore = resolve;
        });
    });
    await app.locator('#history-restore').click();
    await app.waitForFunction(() => window.confirmRestore);
    await app.locator('#history-overlay [data-close]').last().click();
    await expect(app.locator('#history-overlay')).toBeHidden();
    await app.evaluate(() => window.app.history.show('a'));
    await expect(app.locator('#history-restore')).toBeEnabled();
    await app.evaluate(() => window.confirmRestore(true));
    expect(await writer.evaluate(() => window.savedContent())).toBe('Current content');
    await expect(app.locator('#history-status')).toContainText('Showing revision');
    await expect(app.locator('#history-restore')).toBeEnabled();
  } finally {
    await context.close();
  }
});

test('history refresh preserves an unqueued draft and keeps restore disabled', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    expect(await writer.evaluate(() => window.save('Acknowledged elsewhere'))).toBe(true);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-refresh')).toBeVisible();
    await app.evaluate(() => window.app.db.getNote('a').update({ content: 'Unqueued draft' }));
    await app.locator('#history-refresh').click();
    await expect(app.locator('#history-status')).toContainText('An active draft was preserved');
    await expect(app.locator('#history-restore')).toBeDisabled();
    expect(await app.evaluate(() => window.app.db.getNote('a').content)).toBe('Unqueued draft');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
  } finally {
    await context.close();
  }
});

test('stale history controls support keyboard refresh and accessible light and dark layouts', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const { app, writer } = await openHistory(context);
    for (const width of [1440, 375]) {
      await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      for (const theme of ['light', 'dark']) {
        await app.evaluate((mode) => window.app.theme.setMode(mode, { persist: false }), theme);
        const content = `Saved for ${width} ${theme}`;
        expect(await writer.evaluate((value) => window.save(value), content)).toBe(true);
        await app.locator('#history-restore').click();
        await expect(app.getByRole('button', { name: 'Refresh comparison' })).toBeVisible();
        // Match the existing accessibility lane: measure settled theme colors.
        await app.waitForTimeout(250);
        const scan = await new AxeBuilder({ page: app })
          .include('#history-overlay')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(scan.violations, `${width}/${theme}`).toEqual([]);
        await app.getByRole('button', { name: 'Refresh comparison' }).focus();
        await app.keyboard.press('Enter');
        await expect(app.locator('#history-restore')).toBeEnabled();
        await expect(app.locator('#history-diff')).toContainText(content);
        expect(await writer.evaluate(() => window.savedContent())).toBe(content);
      }
    }
  } finally {
    await context.close();
  }
});
