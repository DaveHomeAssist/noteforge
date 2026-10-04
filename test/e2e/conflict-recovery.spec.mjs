import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { devUrl } from './support/runtime.mjs';

async function open(context, seed = false) {
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(async (seed) => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    if (seed)
      await storage.saveMany([
        ['notes', ['a', 'b'].map((id) => new Note({ id, title: id, content: `Original ${id}` }).toJSON())],
        ['config', {}],
        ['schemaVersion', CURRENT_SCHEMA_VERSION],
      ]);
    window.captures = [];
    window.db = new Database({
      storageBackend: storage,
      onNotesPersisted: async (captures) => {
        window.captures.push(...structuredClone(captures));
      },
    });
    await window.db.init({ allowLegacyMigration: seed });
    window.save = async (id, content) => {
      const note = window.db.getNote(id);
      note.update({ content });
      window.db.saveNote(note);
      return window.db.flushCurrentWrites();
    };
  }, seed);
  return page;
}

async function conflict(browser) {
  const context = await browser.newContext({ acceptDownloads: true });
  const a = await open(context, true);
  const b = await open(context);
  await a.evaluate(() => window.save('a', 'Saved in A'));
  await b.evaluate(() => window.save('a', 'Draft in B'));
  return { context, a, b };
}

async function waitForRecoveryStartup(app) {
  await app.evaluate(() => window.app.ready);
  // app.ready covers the shell; deferred alias reconciliation can still
  // commit configuration and invalidate a recovery preview afterwards.
  await app.waitForFunction(() => window.app.phase5 && window.app.phase6);
  await app.evaluate(async () => {
    await Promise.all([window.app.phase5.ready, window.app.phase6.ready, window.app.vaultRefreshReady]);
    await window.app.db.flush();
  });
}

for (const action of ['keep-current', 'save-copy', 'use-draft']) {
  test(`conflict ${action} is durable and archives both recoverable versions`, async ({ browser }) => {
    const { context, b } = await conflict(browser);
    try {
      await b.evaluate(async (action) => {
        const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
        // Rendered data is mutable, but it is not the commit contract.
        preview.notes[0].draft.content = 'Tampered preview';
        await window.db.resolveConflict(preview, action);
        await window.db.flush();
      }, action);
      const reopened = await open(context);
      const state = await reopened.evaluate(async () => ({
        notes: [...window.db.notes.values()].map((n) => n.toJSON()),
        conflicts: window.db.conflicts.size,
        archive: await window.db.storage.readResolvedConflicts(),
      }));
      expect(state.conflicts).toBe(0);
      expect(state.notes.find((n) => n.id === 'a').content).toBe(action === 'use-draft' ? 'Draft in B' : 'Saved in A');
      expect(state.notes.some((n) => n.content === 'Tampered preview')).toBe(false);
      expect(state.archive).toHaveLength(1);
      expect(state.archive[0].conflict.mutation.notes[0].value.content).toBe('Draft in B');
      if (action === 'save-copy') expect(state.notes.filter((n) => n.content === 'Draft in B')).toHaveLength(1);
      if (action === 'use-draft') {
        expect(state.archive[0].before.notes[0][1].value.content).toBe('Saved in A');
        const captures = await b.evaluate(() => window.captures.filter((c) => c.reason === 'pre_restore'));
        expect(captures[0].note.content).toBe('Saved in A');
      }
    } finally {
      await context.close();
    }
  });
}

test('a saved change after conflict preview requires a new explicit choice', async ({ browser }) => {
  const { context, a, b } = await conflict(browser);
  try {
    await b.evaluate(async () => {
      window.preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
    });
    await a.evaluate(() => window.save('a', 'Newer saved A'));
    const outcome = await b.evaluate(() =>
      window.db.resolveConflict(window.preview, 'use-draft').then(
        () => true,
        () => false,
      ),
    );
    expect(outcome).toBe(false);
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Newer saved A');
    expect(await reopened.evaluate(() => window.db.conflicts.size)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('resolving one conflict retains another window draft discovered by the preview', async ({ browser }) => {
  const { context, a, b } = await conflict(browser);
  try {
    const c = await open(context);
    await a.evaluate(() => window.save('b', 'Saved B elsewhere'));
    await c.evaluate(() => window.save('b', 'Another window draft'));
    // B has never loaded C's conflict, but its consistent preview will see it.
    expect(await b.evaluate(() => window.db.conflicts.size)).toBe(1);
    await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      await window.db.resolveConflict(preview, 'keep-current');
    });
    const remaining = await b.evaluate(() => [...window.db.conflicts.values()]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].mutation.notes[0].value.content).toBe('Another window draft');
    const reopened = await open(context);
    expect(await reopened.evaluate(() => [...window.db.conflicts.values()])).toEqual(remaining);
  } finally {
    await context.close();
  }
});

test('a local edit during safety capture invalidates the conflict choice', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      window.db.onNotesPersisted = async () => {
        await new Promise((resolve) => {
          window.releaseSafety = resolve;
        });
      };
      window.outcome = window.db.resolveConflict(preview, 'use-draft').then(
        () => true,
        () => false,
      );
    });
    await b.waitForFunction(() => window.releaseSafety);
    await b.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Draft during safety' });
      window.db.saveNote(note);
      window.releaseSafety();
    });
    expect(await b.evaluate(() => window.outcome)).toBe(false);
    await b.evaluate(() => window.db.flushCurrentWrites());
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
    expect(
      await reopened.evaluate(() =>
        [...window.db.conflicts.values()].some((c) => c.mutation.notes[0]?.value?.content === 'Draft during safety'),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('a draft queued during resolution acknowledgement is retained on its original base', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (mutation.resolution)
          await new Promise((resolve) => {
            window.releaseCommit = resolve;
          });
        return result;
      };
      window.outcome = window.db.resolveConflict(preview, 'use-draft');
    });
    await b.waitForFunction(() => window.releaseCommit);
    await b.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Newer draft during commit' });
      window.db.saveNote(note);
      window.releaseCommit();
    });
    await b.evaluate(() => window.outcome);
    expect(await b.evaluate(() => window.db.flushCurrentWrites())).toBe(false);
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Newer draft during commit');
    expect(await b.evaluate(() => JSON.parse(window.db._savedNotes.get('a')).content)).toBe('Draft in B');
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Draft in B');
    expect(
      await reopened.evaluate(() =>
        [...window.db.conflicts.values()].some(
          (c) => c.mutation.notes[0]?.value?.content === 'Newer draft during commit',
        ),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('reopened conflicts are compared, exported and resolved through the application UI', async ({
  browser,
}, testInfo) => {
  const { context, b } = await conflict(browser);
  try {
    await b.close();
    const app = await context.newPage();
    await app.goto(devUrl());
    await waitForRecoveryStartup(app);
    await app.getByRole('button', { name: 'Review and export', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'Recover unsaved changes' });
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Draft in B/);
    await expect(dialog.getByLabel('Saved version', { exact: true })).toHaveValue(/Saved in A/);
    const download = app.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export recovery file' }).click();
    const path = testInfo.outputPath('conflict-export.json');
    await (await download).saveAs(path);
    const payload = JSON.parse(await readFile(path, 'utf8'));
    expect(payload.conflicts[0].mutation.notes[0].value.content).toBe('Draft in B');
    expect(payload.notes.find((note) => note.id === 'a').content).toBe('Saved in A');
    await dialog.getByRole('button', { name: 'Save draft as a copy', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Recovery choice saved');
    const archiveDownload = app.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export recovery file' }).click();
    const archivePath = testInfo.outputPath('resolved-export.json');
    await (await archiveDownload).saveAs(archivePath);
    const resolved = JSON.parse(await readFile(archivePath, 'utf8'));
    expect(resolved.archived).toHaveLength(1);
    expect(resolved.archived[0].conflict.mutation.notes[0].value.content).toBe('Draft in B');
    expect((await new AxeBuilder({ page: app }).include('#conflict-dialog').analyze()).violations).toEqual([]);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 375, height: 812 },
    ]) {
      await app.setViewportSize(viewport);
      expect(
        await app.evaluate(
          () =>
            document.documentElement.scrollHeight <= document.documentElement.clientHeight &&
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
    await app.screenshot({ path: testInfo.outputPath('conflict-mobile.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const reopened = await open(context);
    expect(
      await reopened.evaluate(
        () => [...window.db.notes.values()].filter((note) => note.content === 'Draft in B').length,
      ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});

test('deferred startup invalidates an open recovery review and requires another explicit choice', async ({
  browser,
}) => {
  const { context, b } = await conflict(browser);
  let releaseStartup;
  const startupGate = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  try {
    await b.close();
    const app = await context.newPage();
    await app.route('**/src/app/phase5.js*', async (route) => {
      await startupGate;
      await route.continue();
    });
    await app.goto(devUrl());
    await app.evaluate(() => window.app.ready);
    await app.waitForFunction(() => window.app.phase6);
    await app.evaluate(() => window.app.phase6.ready);
    await app.getByRole('button', { name: 'Review and export', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'Recover unsaved changes' });
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Draft in B/);
    await expect(dialog.getByLabel('Saved version', { exact: true })).toHaveValue(/Saved in A/);
    const before = await app.evaluate(() => ({
      revision: window.app.db._mutationRevision,
      marker: window.app.db.config.frontmatterAliasMigration,
    }));
    expect(before.marker).toBeUndefined();
    releaseStartup();
    await app.waitForFunction(() => window.app.phase5);
    await app.evaluate(async () => {
      await window.app.phase5.ready;
      await window.app.db.flush();
    });
    expect(await app.evaluate(() => window.app.db._mutationRevision)).toBeGreaterThan(before.revision);
    await dialog.getByRole('button', { name: 'Save draft as a copy', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Review again before retrying');
    const afterRejection = await app.evaluate(async () => ({
      archive: await window.app.db.storage.readResolvedConflicts(),
      notes: [...window.app.db.notes.values()].map((note) => note.toJSON()),
      conflicts: [...window.app.db.conflicts.values()],
    }));
    expect(afterRejection.archive).toEqual([]);
    expect(afterRejection.notes.find((note) => note.id === 'a').content).toBe('Saved in A');
    expect(afterRejection.notes.some((note) => note.content === 'Draft in B')).toBe(false);
    expect(afterRejection.conflicts).toHaveLength(1);
    expect(afterRejection.conflicts[0].mutation.notes[0].value.content).toBe('Draft in B');
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Draft in B/);
    await expect(dialog.getByLabel('Saved version', { exact: true })).toHaveValue(/Saved in A/);
    await dialog.getByRole('button', { name: 'Save draft as a copy', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Recovery choice saved');
    const reopened = await open(context);
    expect(
      await reopened.evaluate(
        () => [...window.db.notes.values()].filter((note) => note.content === 'Draft in B').length,
      ),
    ).toBe(1);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
    expect(await reopened.evaluate(() => window.db.storage.readResolvedConflicts())).toHaveLength(1);
  } finally {
    releaseStartup();
    await context.close();
  }
});

test('an invalidated initial comparison can be refreshed without applying a recovery choice', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    await b.close();
    const app = await context.newPage();
    await app.goto(devUrl());
    await waitForRecoveryStartup(app);
    await app.evaluate(() => {
      window.app.stopVaultRefresh?.();
      const db = window.app.db;
      const preview = db.previewConflict.bind(db);
      db.previewConflict = (...args) => {
        db.previewConflict = preview;
        const read = db.storage.readCurrentVault.bind(db.storage);
        db.storage.readCurrentVault = async () => {
          db.storage.readCurrentVault = read;
          const snapshot = await read();
          await new Promise((resolve) => {
            window.releaseReviewRead = resolve;
          });
          return snapshot;
        };
        return preview(...args);
      };
    });
    await app.getByRole('button', { name: 'Review and export', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'Recover unsaved changes' });
    await app.waitForFunction(() => window.releaseReviewRead);
    await app.evaluate(async () => {
      window.app.db.setConfig({ showGraph: !window.app.db.config.showGraph });
      await window.app.db.flushCurrentWrites();
      window.releaseReviewRead();
    });
    await expect(dialog.getByRole('status')).toContainText('draft or saved vault changed');
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue('');
    for (const action of ['Keep saved version', 'Save draft as a copy', 'Replace saved version with draft'])
      await expect(dialog.getByRole('button', { name: action, exact: true })).toBeDisabled();
    const refresh = dialog.getByRole('button', { name: 'Refresh comparison', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Draft in B/);
    await expect(dialog.getByLabel('Saved version', { exact: true })).toHaveValue(/Saved in A/);
    const state = await app.evaluate(async () => ({
      archive: await window.app.db.storage.readResolvedConflicts(),
      snapshot: await window.app.db.storage.readCurrentVault(),
    }));
    expect(state.archive).toEqual([]);
    expect(state.snapshot.conflicts).toHaveLength(1);
    expect(state.snapshot.records.some(([, record]) => record.value?.content === 'Draft in B')).toBe(false);
    expect(state.snapshot.records.find(([id]) => id === 'a')[1].value.content).toBe('Saved in A');
  } finally {
    await context.close();
  }
});

test('refresh retains the selected conflict and ignores an older read failure', async ({ browser }) => {
  const { context, a, b } = await conflict(browser);
  try {
    await a.evaluate(() => window.save('b', 'Saved B elsewhere'));
    await b.evaluate(() => window.save('b', 'Second draft in B'));
    await b.close();
    const app = await context.newPage();
    await app.goto(devUrl());
    await waitForRecoveryStartup(app);
    await app.evaluate(() => window.app.stopVaultRefresh?.());
    await app.getByRole('button', { name: 'Review and export', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'Recover unsaved changes' });
    const choice = dialog.getByLabel('Conflict', { exact: true });
    await expect(choice.locator('option')).toHaveCount(2);
    await choice.selectOption({ label: 'b' });
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Second draft in B/);
    const selected = await choice.inputValue();
    await app.evaluate(() => {
      const storage = window.app.db.storage;
      const read = storage.readCurrentVault.bind(storage);
      storage.readCurrentVault = () => {
        storage.readCurrentVault = read;
        return new Promise((_, reject) => {
          window.failOlderReviewRead = () => reject(new Error('Older read failure'));
        });
      };
    });
    const refresh = dialog.getByRole('button', { name: 'Refresh comparison', exact: true });
    await refresh.click();
    await app.waitForFunction(() => window.failOlderReviewRead);
    await expect(dialog.getByRole('button', { name: 'Save draft as a copy', exact: true })).toBeDisabled();
    await refresh.click();
    await expect(choice).toHaveValue(selected);
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Second draft in B/);
    await expect(dialog.getByLabel('Saved version', { exact: true })).toHaveValue(/Saved B elsewhere/);
    await app.evaluate(() => window.failOlderReviewRead());
    await expect(dialog.getByRole('status')).toHaveText('Review both versions, then choose an action.');
    await expect(dialog.getByRole('button', { name: 'Save draft as a copy', exact: true })).toBeEnabled();
    expect(await app.evaluate(() => window.app.db.storage.readResolvedConflicts())).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a changed draft record invalidates another window preview without a vault sequence change', async ({
  browser,
}) => {
  const { context, b } = await conflict(browser);
  try {
    const reviewer = await open(context);
    const before = await reviewer.evaluate(async () => {
      window.preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      return window.db.captureMutationToken().sequence;
    });
    await b.evaluate(() => window.save('a', 'Updated conflicting draft'));
    expect(await reviewer.evaluate(async () => (await window.db.storage.readCurrentVault()).meta.sequence)).toBe(
      before,
    );
    expect(
      await reviewer.evaluate(() =>
        window.db.resolveConflict(window.preview, 'keep-current').then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    const reopened = await open(context);
    expect(await reopened.evaluate(() => [...window.db.conflicts.values()][0].mutation.notes[0].value.content)).toBe(
      'Updated conflicting draft',
    );
  } finally {
    await context.close();
  }
});

test('recovery export includes newly stored conflicts and still exports local drafts after read failures', async ({
  browser,
}, testInfo) => {
  const { context, a } = await conflict(browser);
  try {
    const app = await context.newPage();
    await app.goto(devUrl());
    await waitForRecoveryStartup(app);
    await app.getByRole('button', { name: 'Review and export', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'Recover unsaved changes' });
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Draft in B/);
    const c = await open(context);
    await a.evaluate(() => window.save('b', 'Saved B after app opened'));
    await c.evaluate(() => window.save('b', 'Late conflict draft'));
    expect(await app.evaluate(() => window.app.db.conflicts.size)).toBe(1);
    const download = app.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export recovery file' }).click();
    const path = testInfo.outputPath('late-conflict-export.json');
    await (await download).saveAs(path);
    const payload = JSON.parse(await readFile(path, 'utf8'));
    expect(payload.conflicts.some((item) => item.mutation.notes[0]?.value?.content === 'Late conflict draft')).toBe(
      true,
    );
    expect(payload.conflictError).toBeNull();
    await app.evaluate(() => {
      window.app.db.getNote('a').update({ content: 'Local recovery draft' });
      window.app.db.storage.readCurrentVault = async () => {
        throw new Error('Injected conflict read failure');
      };
      window.app.db.storage.readResolvedConflicts = async () => {
        throw new Error('Injected archive read failure');
      };
    });
    const failedReadDownload = app.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export recovery file' }).click();
    const partialPath = testInfo.outputPath('partial-recovery-export.json');
    await (await failedReadDownload).saveAs(partialPath);
    const partial = JSON.parse(await readFile(partialPath, 'utf8'));
    expect(partial.notes.find((note) => note.id === 'a').content).toBe('Local recovery draft');
    expect(partial.conflictError).toContain('Injected conflict read failure');
    expect(partial.archiveError).toContain('Injected archive read failure');
    await expect(dialog.getByRole('status')).toContainText('some stored recovery data was unavailable');
  } finally {
    await context.close();
  }
});

test('an aborted resolution retains the original conflict and saved note', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    expect(
      await b.evaluate(async () => {
        const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (args[1] !== 'readwrite') return tx;
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (...names) => {
            const store = objectStore(...names);
            const put = store.put.bind(store);
            store.put = (...values) => {
              const request = put(...values);
              if (String(values[1]).startsWith('vault:resolved-conflict:')) request.onsuccess = () => tx.abort();
              return request;
            };
            return store;
          };
          return tx;
        };
        try {
          return await window.db.resolveConflict(preview, 'use-draft').then(
            () => true,
            () => false,
          );
        } finally {
          IDBDatabase.prototype.transaction = transaction;
        }
      }),
    ).toBe(false);
    await b.evaluate(() => window.db.flushCurrentWrites());
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
    expect(await reopened.evaluate(() => window.db.conflicts.size)).toBe(1);
    expect(await reopened.evaluate(() => window.db.storage.readResolvedConflicts())).toEqual([]);
  } finally {
    await context.close();
  }
});

test('settings resolution archives the exact replaced field and preserves unrelated settings', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(async () => {
      window.db.setConfig({ font: 'large', theme: 'dark' });
      await window.db.flushCurrentWrites();
    });
    await b.evaluate(async () => {
      window.db.setConfig({ theme: 'light' });
      await window.db.flushCurrentWrites();
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      await window.db.resolveConflict(preview, 'use-draft');
    });
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.config)).toMatchObject({ font: 'large', theme: 'light' });
    const archives = await reopened.evaluate(() => window.db.storage.readResolvedConflicts());
    expect(archives[0].before.config).toEqual([['theme', { value: 'dark', present: true, version: 1 }]]);
  } finally {
    await context.close();
  }
});

test('a previous vault generation can be recovered as a copy but cannot replace current notes', async ({ browser }) => {
  const { context, a, b } = await conflict(browser);
  try {
    await a.evaluate(async () => {
      const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
      await window.db.replaceVault({
        notes: [...window.db.notes.values()].map((note) => note.toJSON()),
        config: {},
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
    });
    expect(
      await b.evaluate(async () => {
        window.preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
        return window.preview.canUseDraft;
      }),
    ).toBe(false);
    expect(
      await b.evaluate(() =>
        window.db.resolveConflict(window.preview, 'use-draft').then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    await b.evaluate(() => window.db.resolveConflict(window.preview, 'save-copy'));
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
    expect(
      await reopened.evaluate(() => [...window.db.notes.values()].some((note) => note.content === 'Draft in B')),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('a new note queued during resolution acknowledgement survives the pending overlay', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (mutation.resolution)
          await new Promise((resolve) => {
            window.releaseCommit = resolve;
          });
        return result;
      };
      window.resolution = window.db.resolveConflict(preview, 'keep-current');
    });
    await b.waitForFunction(() => window.releaseCommit);
    await b.evaluate(async () => {
      const { Note } = await import('../src/core/note.js');
      window.db.saveNote(new Note({ id: 'new-during-resolution', title: 'New draft', content: 'New note content' }));
      window.releaseCommit();
      await window.resolution;
      await window.db.flush();
    });
    expect(await b.evaluate(() => window.db.getNote('new-during-resolution').content)).toBe('New note content');
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('new-during-resolution').content)).toBe('New note content');
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
  } finally {
    await context.close();
  }
});

test('deferred revision leases serialize windows without Web Locks', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => {
      window.lockResult = window.db.storage.withLock('conflict-regression', async () => {
        await window.db.storage.save('lease-order', 'first');
        await new Promise((resolve) => {
          window.releaseLease = resolve;
        });
      });
    });
    await a.waitForFunction(() => window.releaseLease);
    await b.evaluate(() => {
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        if (String(key).startsWith('__internal_lock__:')) window.attemptedLease = true;
        return get.call(this, key);
      };
      window.lockResult = window.db.storage.withLock('conflict-regression', async () => {
        window.enteredLease = true;
        await window.db.storage.save('lease-order', 'second');
      });
    });
    await b.waitForFunction(() => window.attemptedLease);
    expect(await b.evaluate(() => Boolean(window.enteredLease))).toBe(false);
    await a.evaluate(() => window.releaseLease());
    await Promise.all([a.evaluate(() => window.lockResult), b.evaluate(() => window.lockResult)]);
    expect(await b.evaluate(() => window.db.storage.load('lease-order'))).toBe('second');
  } finally {
    await context.close();
  }
});

test('conflict copies preserve source and unknown metadata without colliding with an existing alias', async ({
  browser,
}) => {
  const { context, a, b } = await conflict(browser);
  try {
    await a.evaluate(async () => {
      const note = window.db.getNote('b');
      note.aliases = ['a (Recovered copy)'];
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
    });
    const original = await b.evaluate(async () => {
      const { Note } = await import('../src/core/note.js');
      const raw = {
        ...window.db.getNote('a').toJSON(),
        content: '---\nfuture: keep\n---\n# Verbatim\n',
        futureField: { nested: [1, 'keep'] },
      };
      window.db.saveNote(Note.fromJSON(raw));
      await window.db.flushCurrentWrites();
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      await window.db.resolveConflict(preview, 'save-copy');
      return raw;
    });
    const reopened = await open(context);
    const copy = await reopened.evaluate(() =>
      [...window.db.notes.values()].find((note) => note.id !== 'a' && note.content.includes('# Verbatim')).toJSON(),
    );
    expect(copy.title).toBe('a (Recovered copy) 2');
    expect(copy.content).toBe(original.content);
    expect(copy.futureField).toEqual(original.futureField);
  } finally {
    await context.close();
  }
});

test('an unqueued model edit after review cannot be discarded by conflict resolution', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    const outcome = await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      window.db.getNote('a').update({ content: 'Unqueued newer draft' });
      return window.db.resolveConflict(preview, 'keep-current').then(
        () => true,
        () => false,
      );
    });
    expect(outcome).toBe(false);
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Unqueued newer draft');
  } finally {
    await context.close();
  }
});

test('an unqueued model edit during resolution is retained as a separate recoverable draft', async ({ browser }) => {
  const { context, b } = await conflict(browser);
  try {
    await b.evaluate(async () => {
      const preview = await window.db.previewConflict([...window.db.conflicts.keys()][0]);
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (mutation.resolution)
          await new Promise((resolve) => {
            window.releaseCommit = resolve;
          });
        return result;
      };
      window.outcome = window.db.resolveConflict(preview, 'keep-current');
    });
    await b.waitForFunction(() => window.releaseCommit);
    await b.evaluate(() => {
      window.db.getNote('a').update({ content: 'Unqueued during commit' });
      window.releaseCommit();
    });
    await b.evaluate(() => window.outcome);
    await b.evaluate(() => window.db.flushCurrentWrites());
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Unqueued during commit');
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Saved in A');
    expect(
      await reopened.evaluate(() =>
        [...window.db.conflicts.values()].some((c) => c.mutation.notes[0]?.value?.content === 'Unqueued during commit'),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
