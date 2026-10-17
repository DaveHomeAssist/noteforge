import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function open(context, seed = false) {
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(async (seed) => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    const { CaptureService } = await import('../src/core/capture-service.js');
    if (seed)
      await storage.saveMany([
        [
          'notes',
          [
            new Note({ id: 'a', title: 'A', content: 'Original A' }),
            new Note({ id: 'b', title: 'B', content: 'Original B' }),
            new Note({ id: 'archived', title: 'Archive name', archivedAt: '2026-01-01T00:00:00Z' }),
          ].map((n) => n.toJSON()),
        ],
        ['config', {}],
        ['schemaVersion', CURRENT_SCHEMA_VERSION],
      ]);
    window.db = new Database({ storageBackend: storage, onNotesPersisted: async () => {} });
    await window.db.init({ allowLegacyMigration: seed });
    window.capture = new CaptureService(window.db);
    window.create = async (fields, options) =>
      (await window.db.createNoteWithReceipt(fields, options).completion).status;
    window.saved = async () =>
      (await storage.readCurrentVault()).records.filter(([, record]) => record.value).map(([, record]) => record.value);
  }, seed);
  return page;
}

for (const other of [{ title: 'shared name' }, { title: 'Other', aliases: [' ＳＨＡＲＥＤ　ＮＡＭＥ '] }]) {
  test(`stale creation cannot claim an existing ${other.aliases ? 'alias' : 'title'}`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const a = await open(context, true);
      const b = await open(context);
      expect(await a.evaluate((other) => window.create(other), other)).toBe('committed');
      expect(await b.evaluate(() => window.create({ title: 'Shared name', content: 'Retained creation' }))).toBe(
        'conflict',
      );
      const reopened = await open(context);
      const records = await reopened.evaluate(() => window.saved());
      expect(records.filter((note) => note.content === 'Retained creation')).toHaveLength(0);
      expect(
        await reopened.evaluate(() =>
          [...window.db.conflicts.values()].some((c) =>
            c.mutation.notes.some((n) => n.value?.content === 'Retained creation'),
          ),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
}

test('competing Inbox captures retain the rejected capture instead of acknowledging a second Inbox', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => window.capture.save({ markdown: 'First capture' }));
    const second = await b.evaluate(() =>
      window.capture.save({ markdown: 'Second capture' }).then(
        () => 'committed',
        () => 'rejected',
      ),
    );
    expect(second).toBe('rejected');
    expect(
      (await b.evaluate(() => window.saved())).filter((note) => note.title === 'Inbox').map((note) => note.content),
    ).toEqual(['First capture']);
    expect(
      await b.evaluate(() =>
        [...window.db.conflicts.values()].some((c) =>
          c.mutation.notes.some((n) => n.value?.content === 'Second capture'),
        ),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('unarchive validates identity against the saved vault rather than only local notes', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    expect(await a.evaluate(() => window.create({ title: 'Archive name', content: 'Current owner' }))).toBe(
      'committed',
    );
    await b.evaluate(async () => {
      window.db.unarchiveNote('archived');
      await window.db.flushCurrentWrites();
    });
    expect(await b.evaluate(() => window.db.getNoteSaveState('archived').status)).toBe('conflict');
    expect((await b.evaluate(() => window.saved())).find((note) => note.id === 'archived').archivedAt).not.toBeNull();
  } finally {
    await context.close();
  }
});

test('concurrent creation has one atomic winner without Web Locks', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    const a = await open(context, true);
    const b = await open(context);
    const outcomes = await Promise.all(
      [a, b].map((page, i) => page.evaluate((i) => window.create({ title: 'Concurrent', content: `Window ${i}` }), i)),
    );
    expect(outcomes.sort()).toEqual(['committed', 'conflict']);
    expect((await a.evaluate(() => window.saved())).filter((note) => note.title === 'Concurrent')).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('alias edits and trash restoration cannot introduce a competing identity', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    await a.evaluate(async () => {
      window.db.deleteNote('a');
      await window.db.flushCurrentWrites();
    });
    const b = await open(context);
    await a.evaluate(() => window.create({ title: 'A', aliases: ['Reserved alias'] }));
    const results = await b.evaluate(async () => {
      const note = window.db.getNote('b');
      note.setAliases(['reserved alias']);
      const alias = await window.db.saveNoteWithReceipt(note).completion;
      window.db.restoreNote('a');
      await window.db.flushCurrentWrites();
      return [alias.status, window.db.getNoteSaveState('a').status];
    });
    expect(results).toEqual(['conflict', 'conflict']);
    const saved = await b.evaluate(() => window.saved());
    expect(saved.find((note) => note.id === 'a').deletedAt).not.toBeNull();
    expect(saved.find((note) => note.id === 'b').aliases).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a transaction can transfer names but cannot introduce two owners of one name', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await open(context, true);
    const result = await page.evaluate(async () => {
      const snapshot = await window.db.storage.readCurrentVault();
      const a = snapshot.records.find(([id]) => id === 'a')[1];
      const b = snapshot.records.find(([id]) => id === 'b')[1];
      const base = { generation: snapshot.meta.generation, timestamp: new Date().toISOString() };
      const swapped = await window.db.storage.commitCurrentVault({
        ...base,
        notes: [
          { id: 'a', expected: a.version, value: { ...a.value, title: 'B' } },
          { id: 'b', expected: b.version, value: { ...b.value, title: 'A' } },
        ],
      });
      const duplicated = await window.db.storage.commitCurrentVault({
        ...base,
        conflictId: 'batch-conflict',
        notes: [
          { id: 'c', expected: 0, value: { ...a.value, id: 'c', title: 'New collision' } },
          { id: 'd', expected: 0, value: { ...b.value, id: 'd', title: 'New collision' } },
        ],
      });
      return { swapped: swapped.status, duplicated: duplicated.status, saved: await window.saved() };
    });
    expect(result.swapped).toBe('committed');
    expect(result.duplicated).toBe('conflict');
    expect(result.saved.filter((note) => ['c', 'd'].includes(note.id))).toEqual([]);
    expect(result.saved.find((note) => note.id === 'a').title).toBe('B');
  } finally {
    await context.close();
  }
});

test('explicit duplicate imports survive coalescing while ordinary content writes do not scan identities', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await open(context, true);
    const result = await page.evaluate(async () => {
      // Coalesce before the queued transaction starts, as import sets parent links.
      const submission = window.db.createNoteWithReceipt(
        { id: 'imported', title: 'A', content: 'Imported source', extraUnknown: { retained: true } },
        { allowIdentityConflicts: true },
      );
      submission.note.update({ content: 'Imported source with parent update' });
      const receipt = await window.db.saveNoteWithReceipt(submission.note).completion;
      let scans = 0;
      const cursor = IDBObjectStore.prototype.openCursor;
      IDBObjectStore.prototype.openCursor = function (...args) {
        scans++;
        return cursor.apply(this, args);
      };
      let edited;
      try {
        submission.note.update({ content: 'Ordinary content edit' });
        edited = await window.db.saveNoteWithReceipt(submission.note).completion;
      } finally {
        IDBObjectStore.prototype.openCursor = cursor;
      }
      return { created: receipt.status, edited: edited.status, scans, saved: await window.saved() };
    });
    expect(result).toMatchObject({ created: 'committed', edited: 'committed', scans: 0 });
    expect(result.saved.filter((note) => note.title === 'A')).toHaveLength(2);
    expect(result.saved.find((note) => note.id === 'imported').extraUnknown).toEqual({ retained: true });
  } finally {
    await context.close();
  }
});

test('an import permission does not leak to a different queued identity', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await open(context, true);
    const result = await page.evaluate(async () => {
      const submission = window.db.createNoteWithReceipt(
        { id: 'imported', title: 'A' },
        { allowIdentityConflicts: true },
      );
      submission.note.update({ title: 'B' });
      return (await window.db.saveNoteWithReceipt(submission.note).completion).status;
    });
    expect(result).toBe('conflict');
    expect((await page.evaluate(() => window.saved())).some((note) => note.id === 'imported')).toBe(false);
  } finally {
    await context.close();
  }
});

test('identity recovery explains the collision and saves a unique copy without overwriting its owner', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => window.capture.save({ markdown: 'First capture' }));
    await b.evaluate(() => window.capture.save({ markdown: 'Second capture' }).catch(() => {}));
    const reopened = await open(context);
    await reopened.evaluate(async () => {
      await import('../src/styles.css');
      const { ConflictView } = await import('../src/components/conflict-view.js');
      window.view = new ConflictView({ db: window.db, flush() {}, ensureSafety: async () => {}, onResolved() {} });
      await window.view.open();
    });
    const dialog = reopened.getByRole('dialog', { name: 'Recover unsaved changes' });
    await expect(dialog.locator('[data-explanation]')).toContainText('A title or alias is already in use');
    await expect(dialog.locator('[data-action="use-draft"]')).toBeDisabled();
    await expect(dialog.getByLabel('Your draft', { exact: true })).toHaveValue(/Second capture/);
    await reopened.screenshot({ path: testInfo.outputPath('identity-recovery.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Save draft as a copy' }).click();
    await expect(dialog.locator('[data-status]')).toContainText('Recovery choice saved');
    const notes = await reopened.evaluate(() => window.saved());
    expect(notes.find((note) => note.title === 'Inbox').content).toBe('First capture');
    expect(notes.find((note) => note.title === 'Inbox (Recovered copy)').content).toBe('Second capture');
  } finally {
    await context.close();
  }
});

test('recovery rechecks identity ownership after a version conflict and after an owner is removed', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(async () => {
      const note = window.db.getNote('b');
      note.update({ content: 'New saved B' });
      await window.db.saveNoteWithReceipt(note).completion;
      await window.create({ title: 'Claimed' });
    });
    await b.evaluate(async () => {
      const note = window.db.getNote('b');
      note.update({ title: 'Claimed', content: 'Retained local B' });
      await window.db.saveNoteWithReceipt(note).completion;
    });
    const initial = await b.evaluate(async () => {
      const id = [...window.db.conflicts.keys()][0];
      window.identityPreview = await window.db.previewConflict(id);
      return {
        canUse: window.identityPreview.canUseDraft,
        collisions: window.identityPreview.identityCollisions.length,
      };
    });
    expect(initial).toEqual({ canUse: false, collisions: 1 });
    await a.evaluate(async () => {
      window.db.deleteNote(window.db.resolveTitle('Claimed').id);
      await window.db.flushCurrentWrites();
    });
    expect(
      await b.evaluate(async () => {
        const id = [...window.db.conflicts.keys()][0];
        window.identityPreview = await window.db.previewConflict(id);
        return window.identityPreview.canUseDraft;
      }),
    ).toBe(true);
    await b.evaluate(() => window.db.resolveConflict(window.identityPreview, 'use-draft'));
    expect((await b.evaluate(() => window.saved())).find((note) => note.id === 'b').content).toBe('Retained local B');
  } finally {
    await context.close();
  }
});

test('aborting the identity scan leaves notes, settings and acknowledgement unchanged', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await open(context, true);
    const result = await page.evaluate(async () => {
      const before = await window.db.storage.readCurrentVault();
      const original = IDBObjectStore.prototype.openCursor;
      let aborted = false;
      IDBObjectStore.prototype.openCursor = function (...args) {
        const request = original.apply(this, args);
        if (!aborted && this.transaction.mode === 'readwrite' && args[0]?.lower === 'note:') {
          aborted = true;
          this.transaction.abort();
        }
        return request;
      };
      let rejected = false;
      try {
        const record = before.records.find(([id]) => id === 'a')[1];
        await window.db.storage.commitCurrentVault({
          generation: before.meta.generation,
          timestamp: new Date().toISOString(),
          notes: [{ id: 'a', expected: record.version, value: { ...record.value, title: 'New identity' } }],
          config: [{ key: 'theme', expected: before.config.versions.theme ?? 0, value: 'dark' }],
        });
      } catch {
        rejected = true;
      } finally {
        IDBObjectStore.prototype.openCursor = original;
      }
      return { aborted, rejected, before, after: await window.db.storage.readCurrentVault() };
    });
    expect(result.aborted).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.after).toEqual(result.before);
  } finally {
    await context.close();
  }
});

for (const changeIdentity of [false, true]) {
  test(`in-flight duplicate import ${changeIdentity ? 'does not authorize a later competing name' : 'retains a later content edit'}`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const page = await open(context, true);
      await page.evaluate(() => {
        const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
        window.db.storage.commitCurrentVault = async (mutation) => {
          window.db.storage.commitCurrentVault = commit;
          await new Promise((resolve) => {
            window.releaseIdentityCommit = resolve;
          });
          return commit(mutation);
        };
        window.importSubmission = window.db.createNoteWithReceipt(
          { id: 'imported', title: 'A', content: 'Original import' },
          { allowIdentityConflicts: true },
        );
      });
      await page.waitForFunction(() => window.releaseIdentityCommit);
      const result = await page.evaluate(async (changeIdentity) => {
        const note = window.importSubmission.note;
        note.update({ title: changeIdentity ? 'B' : 'A', content: 'Later local draft' });
        const later = window.db.saveNoteWithReceipt(note);
        window.releaseIdentityCommit();
        const first = await window.importSubmission.completion;
        const next = await later.completion;
        return {
          first: first.status,
          next: next.status,
          saved: await window.saved(),
          state: window.db.getNoteSaveState(note.id).status,
        };
      }, changeIdentity);
      expect(result.first).toBe('committed');
      expect(result.next).toBe(changeIdentity ? 'conflict' : 'committed');
      expect(result.saved.find((note) => note.id === 'imported')).toMatchObject({
        title: 'A',
        content: changeIdentity ? 'Original import' : 'Later local draft',
      });
      expect(result.state).toBe(changeIdentity ? 'conflict' : 'committed');
    } finally {
      await context.close();
    }
  });
}
