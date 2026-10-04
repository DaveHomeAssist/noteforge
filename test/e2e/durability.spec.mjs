import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function openDatabase(context, { seed = false } = {}) {
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(async (seed) => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    if (seed) {
      await storage.saveMany([
        ['notes', ['a', 'b'].map((id) => new Note({ id, title: id, content: `Original ${id}` }).toJSON())],
        ['config', {}],
        ['schemaVersion', CURRENT_SCHEMA_VERSION],
      ]);
    }
    window.db = new Database({ storageBackend: storage, onNotesPersisted: async () => {} });
    // Explicit synthetic-fixture activation; this is not the production upgrade gate.
    await window.db.init({ allowLegacyMigration: seed });
    await window.db.flush();
  }, seed);
  return page;
}

async function save(page, id, content) {
  return page.evaluate(
    async ({ id, content }) => {
      const note = window.db.getNote(id);
      note.update({ content });
      window.db.saveNote(note);
      return window.db.flushCurrentWrites();
    },
    { id, content },
  );
}

for (const webLocks of [true, false]) {
  test(`independent window edits survive acknowledgement and reopen (Web Locks ${webLocks})`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      if (!webLocks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
      const a = await openDatabase(context, { seed: true });
      const b = await openDatabase(context);
      expect(await save(a, 'a', 'Acknowledged A')).toBe(true);
      const afterA = await openDatabase(context);
      expect(await afterA.evaluate(() => window.db.getNote('a').content)).toBe('Acknowledged A');
      await afterA.close();
      expect(await save(b, 'b', 'Acknowledged B')).toBe(true);
      const reopened = await openDatabase(context);
      expect(await reopened.evaluate(() => ['a', 'b'].map((id) => window.db.getNote(id).content))).toEqual([
        'Acknowledged A',
        'Acknowledged B',
      ]);
    } finally {
      await context.close();
    }
  });
}

test('rename rejects an edit acknowledged during its safety capture', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    await page.evaluate(async () => {
      const { LinkOperations } = await import('../src/core/link-operations.js');
      const links = new LinkOperations(window.db);
      const original = window.db.captureRevisionBoundary.bind(window.db);
      const gate = new Promise((resolve) => {
        window.releaseSafety = resolve;
      });
      window.db.captureRevisionBoundary = async (...args) => {
        const result = await original(...args);
        window.safetyReached = true;
        await gate;
        return result;
      };
      window.renameOutcome = links.applyRenamePlan(links.planRename('a', 'Renamed')).then(
        () => ({ applied: true }),
        (error) => ({ applied: false, message: error.message }),
      );
    });
    await page.waitForFunction(() => window.safetyReached);
    expect(await save(page, 'a', 'Acknowledged during safety')).toBe(true);
    const before = await openDatabase(context);
    expect(await before.evaluate(() => window.db.getNote('a').content)).toBe('Acknowledged during safety');
    await before.close();
    await page.evaluate(() => window.releaseSafety());
    const outcome = await page.evaluate(() => window.renameOutcome);
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Acknowledged during safety');
    expect(outcome.applied).toBe(false);
  } finally {
    await context.close();
  }
});

test('a conflicting note retains both versions without blocking an unrelated save', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await openDatabase(context, { seed: true });
    const b = await openDatabase(context);
    expect(await save(a, 'a', 'Current A')).toBe(true);
    expect(await save(b, 'a', 'Conflicting A')).toBe(false);
    // The global acknowledgement remains false for the unresolved draft, but
    // independent work must still commit and survive closing the stale window.
    expect(await save(b, 'b', 'Independent B')).toBe(false);
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Conflicting A');
    await b.close();
    const reopened = await openDatabase(context);
    expect(
      await reopened.evaluate(() => ({
        current: window.db.getNote('a').content,
        other: window.db.getNote('b').content,
        drafts: [...window.db.conflicts.values()].flatMap((c) => c.mutation.notes.map((n) => n.value?.content)),
      })),
    ).toEqual({ current: 'Current A', other: 'Independent B', drafts: ['Conflicting A'] });
  } finally {
    await context.close();
  }
});

test('a newer draft queued during acknowledgement uses the committed base version', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    await page.evaluate(() => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      let first = true;
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (first) {
          first = false;
          await new Promise((resolve) => {
            window.releaseCommit = resolve;
            window.commitReached = true;
          });
        }
        return result;
      };
      const note = window.db.getNote('a');
      note.update({ content: 'First draft' });
      window.db.saveNote(note);
    });
    await page.waitForFunction(() => window.commitReached);
    await page.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Newest draft' });
      window.db.saveNote(note);
      window.releaseCommit();
    });
    expect(await page.evaluate(() => window.db.flushCurrentWrites())).toBe(true);
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Newest draft');
    expect(await reopened.evaluate(() => window.db.conflicts.size)).toBe(0);
  } finally {
    await context.close();
  }
});

test('a new cross-window backlink makes the reviewed rename stale', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await openDatabase(context, { seed: true });
    const b = await openDatabase(context);
    await a.evaluate(async () => {
      const { LinkOperations } = await import('../src/core/link-operations.js');
      window.links = new LinkOperations(window.db);
      window.plan = window.links.planRename('a', 'Renamed');
    });
    expect(await save(b, 'b', 'New backlink [[a]]')).toBe(true);
    const result = await a.evaluate(() =>
      window.links.applyRenamePlan(window.plan).then(
        () => true,
        () => false,
      ),
    );
    expect(result).toBe(false);
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => [window.db.getNote('a').title, window.db.getNote('b').content])).toEqual([
      'a',
      'New backlink [[a]]',
    ]);
  } finally {
    await context.close();
  }
});

for (const action of ['setPinned', 'deleteNote', 'archiveNote', 'purgeNote']) {
  test(`${action} does not resave an unrelated stale note`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const a = await openDatabase(context, { seed: true });
      const b = await openDatabase(context);
      expect(await save(a, 'a', 'Current A')).toBe(true);
      expect(
        await b.evaluate(async (action) => {
          window.db[action]('b', true);
          return window.db.flushCurrentWrites();
        }, action),
      ).toBe(true);
      const reopened = await openDatabase(context);
      expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Current A');
    } finally {
      await context.close();
    }
  });
}

test('an edit during a planned commit is retained as a conflict instead of undoing the plan', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    await page.evaluate(async () => {
      const { LinkOperations } = await import('../src/core/link-operations.js');
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (mutation.sequence !== undefined) {
          await new Promise((resolve) => {
            window.releaseCommit = resolve;
            window.commitReached = true;
          });
        }
        return result;
      };
      const links = new LinkOperations(window.db);
      window.outcome = links.applyRenamePlan(links.planRename('a', 'Renamed'));
    });
    await page.waitForFunction(() => window.commitReached);
    await page.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Draft during commit' });
      window.db.saveNote(note);
      window.releaseCommit();
    });
    await page.evaluate(() => window.outcome);
    expect(await page.evaluate(() => window.db.flushCurrentWrites())).toBe(false);
    expect(await page.evaluate(() => window.db.getNote('a').content)).toBe('Draft during commit');
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => [window.db.getNote('a').title, window.db.getNote('a').content])).toEqual([
      'Renamed',
      'Original a',
    ]);
    expect(await reopened.evaluate(() => [...window.db.conflicts.values()][0].mutation.notes[0].value.content)).toBe(
      'Draft during commit',
    );
  } finally {
    await context.close();
  }
});

test('full replacement fences drafts from the previous vault generation', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await openDatabase(context, { seed: true });
    const b = await openDatabase(context);
    expect(
      await a.evaluate(async () =>
        window.db.replaceVault({
          notes: [...window.db.notes.values()].map((note) => ({ ...note.toJSON(), content: `Replacement ${note.id}` })),
          config: { themeMode: 'dark' },
        }),
      ),
    ).toBe(true);
    expect(await save(b, 'a', 'Old generation draft')).toBe(false);
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Replacement a');
    expect(await reopened.evaluate(() => [...window.db.conflicts.values()][0].mutation.notes[0].value.content)).toBe(
      'Old generation draft',
    );
  } finally {
    await context.close();
  }
});

test('queued note metadata and its history capture are detached from later edits', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    const result = await page.evaluate(async () => {
      let captures;
      window.db.onNotesPersisted = async (entries) => {
        captures = entries;
      };
      const note = window.db.getNote('a');
      note._extra.details = { label: 'Saved metadata' };
      window.db.saveNote(note);
      note._extra.details.label = 'Unqueued mutation';
      await window.db.flush();
      return { history: captures[0].note.details.label, timestamp: window.db.lastPersistedAt };
    });
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').toJSON().details.label)).toBe('Saved metadata');
    expect(result.history).toBe('Saved metadata');
    expect(await reopened.evaluate(() => window.db.lastPersistedAt)).toBe(result.timestamp);
  } finally {
    await context.close();
  }
});

test('independent configuration fields and a consistent backup include other windows', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await openDatabase(context, { seed: true });
    const b = await openDatabase(context);
    expect(
      await a.evaluate(async () => {
        window.db.setConfig({ themeMode: 'dark' });
        return window.db.flushCurrentWrites();
      }),
    ).toBe(true);
    expect(
      await b.evaluate(async () => {
        window.db.setConfig({ customSetting: { value: 7 } });
        return window.db.flushCurrentWrites();
      }),
    ).toBe(true);
    expect(await save(a, 'a', 'Other window content')).toBe(true);
    const backup = await b.evaluate(() => window.db.readCommittedVault());
    expect(backup.notes.find((note) => note.id === 'a').content).toBe('Other window content');
    expect(backup.config).toEqual({ themeMode: 'dark', customSetting: { value: 7 } });
    expect(
      await b.evaluate(async () => {
        window.db.setConfig({ themeMode: 'light' });
        return window.db.flushCurrentWrites();
      }),
    ).toBe(false);
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.config.themeMode)).toBe('dark');
  } finally {
    await context.close();
  }
});

for (const legacyNotes of [false, true]) {
  test(`migration remains gated for ${legacyNotes ? 'populated' : 'empty'} legacy storage`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(new URL('test/durability.html', devUrl()).href);
      const result = await page.evaluate(async (seed) => {
        const { Database } = await import('../src/core/database.js');
        const { storage } = await import('../src/core/storage.js');
        const { Note } = await import('../src/core/note.js');
        if (seed)
          await storage.save('notes', [new Note({ id: 'legacy', title: 'Legacy', content: 'Preserved' }).toJSON()]);
        const db = new Database();
        await db.init();
        const original = db.getNote('legacy')?.content ?? null;
        db.createNote({ id: 'unsaved', title: 'Unacknowledged', content: 'Draft' });
        return {
          original,
          acknowledged: await db.flushCurrentWrites(),
          status: db.getPersistenceStatus(),
          marker: await storage.load('vault:meta'),
          legacy: await storage.load('notes', []),
        };
      }, legacyNotes);
      expect(result.original).toBe(legacyNotes ? 'Preserved' : null);
      expect(result.acknowledged).toBe(false);
      expect(result.status).toMatchObject({ readOnly: true, upgradeRequired: true });
      expect(result.marker).toBeNull();
      expect(result.legacy.map((note) => note.id)).toEqual(legacyNotes ? ['legacy'] : []);
    } finally {
      await context.close();
    }
  });
}

test('note receipts distinguish a coalesced snapshot from its committed successor', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    const result = await page.evaluate(async () => {
      const note = window.db.getNote('a');
      note.update({ content: 'Coalesced draft' });
      const first = window.db.saveNoteWithReceipt(note);
      note.update({ content: 'Committed successor' });
      const second = window.db.saveNoteWithReceipt(note);
      const pending = window.db.getNoteSaveState('a');
      const receipts = await Promise.all([first.completion, second.completion]);
      await window.db.flushCurrentWrites();
      const saved = (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1];
      return { pending, receipts, saved, state: window.db.getNoteSaveState('a') };
    });
    expect(result.pending.status).toBe('pending');
    expect(result.receipts[0]).toMatchObject({
      status: 'superseded',
      noteId: 'a',
      version: null,
      note: { content: 'Coalesced draft' },
    });
    expect(result.receipts[1]).toMatchObject({
      status: 'committed',
      noteId: 'a',
      version: result.saved.version,
      note: result.saved.value,
    });
    expect(result.receipts[1].generation).toBe(result.state.generation);
    expect(result.state).toMatchObject({ status: 'committed', version: result.saved.version });
  } finally {
    await context.close();
  }
});

test('note receipts wait for acknowledgement and never acknowledge later queued content', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openDatabase(context, { seed: true });
  try {
    await page.evaluate(() => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      let first = true;
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (first) {
          first = false;
          await new Promise((resolve) => {
            window.releaseReceipt = resolve;
          });
        }
        return result;
      };
      const note = window.db.getNote('a');
      note.update({ content: 'First exact snapshot' });
      window.firstReceipt = window.db.saveNoteWithReceipt(note).completion;
      window.firstSettled = false;
      window.firstReceipt.then(() => {
        window.firstSettled = true;
      });
    });
    await page.waitForFunction(() => window.releaseReceipt);
    expect(await page.evaluate(() => window.firstSettled)).toBe(false);
    expect(await page.evaluate(() => window.db.getNoteSaveState('a').status)).toBe('in-flight');
    await page.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Later exact snapshot' });
      window.laterReceipt = window.db.saveNoteWithReceipt(note).completion;
    });
    expect(await page.evaluate(() => window.db.getNoteSaveState('a').status)).toBe('pending');
    await page.evaluate(() => window.releaseReceipt());
    const receipts = await page.evaluate(() => Promise.all([window.firstReceipt, window.laterReceipt]));
    expect(receipts[0]).toMatchObject({ status: 'committed', version: 2, note: { content: 'First exact snapshot' } });
    expect(receipts[1]).toMatchObject({ status: 'committed', version: 3, note: { content: 'Later exact snapshot' } });
    expect(await page.evaluate(() => window.db.getNoteSaveState('a'))).toMatchObject({
      status: 'committed',
      version: 3,
    });
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Later exact snapshot');
  } finally {
    await page.evaluate(() => window.releaseReceipt?.()).catch(() => {});
    await context.close();
  }
});

test('note receipts report an independent commit despite another note conflict', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const current = await openDatabase(context, { seed: true });
    const stale = await openDatabase(context);
    expect(await save(current, 'a', 'Other window version')).toBe(true);
    const result = await stale.evaluate(async () => {
      const a = window.db.getNote('a');
      a.update({ content: 'Retained conflict draft' });
      const first = window.db.saveNoteWithReceipt(a);
      const b = window.db.getNote('b');
      b.update({ content: 'Independent acknowledged note' });
      const second = window.db.saveNoteWithReceipt(b);
      const receipts = await Promise.all([first.completion, second.completion]);
      const drained = await window.db.flushCurrentWrites();
      return { receipts, drained, a: window.db.getNoteSaveState('a'), b: window.db.getNoteSaveState('b') };
    });
    expect(result.drained).toBe(false);
    expect(result.receipts[0]).toMatchObject({
      status: 'conflict',
      version: null,
      note: { content: 'Retained conflict draft' },
    });
    expect(result.receipts[0].conflictId).toBeTruthy();
    expect(result.receipts[1]).toMatchObject({
      status: 'committed',
      version: 2,
      note: { content: 'Independent acknowledged note' },
    });
    expect(result.a.status).toBe('conflict');
    expect(result.b.status).toBe('committed');
  } finally {
    await context.close();
  }
});

test('a failed note receipt stays failed while an explicit retry has its own committed receipt', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    const result = await page.evaluate(async () => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected note receipt failure');
      };
      const note = window.db.getNote('a');
      note.update({ content: 'Retry exact source' });
      const failed = window.db.saveNoteWithReceipt(note);
      const first = await failed.completion;
      const failedState = window.db.getNoteSaveState('a');
      window.db.storage.commitCurrentVault = commit;
      const retried = window.db.saveNoteWithReceipt(note);
      const second = await retried.completion;
      await window.db.flushCurrentWrites();
      second.note.content = 'Mutated public receipt';
      return {
        first,
        failedState,
        original: await failed.completion,
        second,
        saved: (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content,
        state: window.db.getNoteSaveState('a'),
      };
    });
    expect(result.first).toMatchObject({ status: 'failed', version: null, note: { content: 'Retry exact source' } });
    expect(result.failedState.status).toBe('failed');
    expect(result.original).toEqual(result.first);
    expect(result.second).toMatchObject({ status: 'committed', version: 2 });
    expect(result.saved).toBe('Retry exact source');
    expect(result.state.status).toBe('committed');
  } finally {
    await context.close();
  }
});

test('note save state does not call an unqueued model edit committed', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    expect(await page.evaluate(() => window.db.getNoteSaveState('a'))).toMatchObject({
      status: 'committed',
      version: 1,
    });
    await page.evaluate(() => window.db.getNote('a').update({ content: 'Unqueued source' }));
    expect(await page.evaluate(() => window.db.flushCurrentWrites())).toBe(true);
    expect(await page.evaluate(() => window.db.getNoteSaveState('a'))).toMatchObject({
      status: 'dirty',
      version: null,
    });
  } finally {
    await context.close();
  }
});

test('note receipts report unavailable storage without acknowledging a read-only draft', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    const result = await page.evaluate(async () => {
      window.db._readOnly = true;
      const note = window.db.getNote('a');
      note.update({ content: 'Read-only draft' });
      const receipt = await window.db.saveNoteWithReceipt(note).completion;
      return {
        receipt,
        state: window.db.getNoteSaveState('a'),
        saved: (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content,
      };
    });
    expect(result.receipt).toMatchObject({
      status: 'unavailable',
      version: null,
      note: { content: 'Read-only draft' },
    });
    expect(result.state.status).toBe('unavailable');
    expect(result.saved).toBe('Original a');
  } finally {
    await context.close();
  }
});

test('note receipts retain their original generation when a replacement commits first', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openDatabase(context, { seed: true });
  try {
    const originalGeneration = await page.evaluate(() => window.db.captureMutationToken().generation);
    await page.evaluate(() => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async (mutation) => {
        const result = await commit(mutation);
        if (mutation.replacement)
          await new Promise((resolve) => {
            window.releaseReplacement = resolve;
          });
        return result;
      };
      const notes = [...window.db.notes.values()].map((note) => ({ ...note.toJSON(), content: 'Replacement source' }));
      window.replacing = window.db.replaceVault({ notes, config: window.db.config });
    });
    await page.waitForFunction(() => window.releaseReplacement);
    await page.evaluate(() => {
      const note = window.db.getNote('a');
      note.update({ content: 'Old generation draft' });
      window.receipt = window.db.saveNoteWithReceipt(note).completion;
    });
    expect(await page.evaluate(() => window.db.getNoteSaveState('a'))).toMatchObject({
      status: 'pending',
      generation: originalGeneration,
      version: null,
    });
    await page.evaluate(() => window.releaseReplacement());
    expect(await page.evaluate(() => window.replacing)).toBe(true);
    expect(await page.evaluate(() => window.receipt)).toMatchObject({
      status: 'conflict',
      generation: originalGeneration,
      version: null,
    });
    const reopened = await openDatabase(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Replacement source');
    expect(await reopened.evaluate(() => window.db.getNoteSaveState('a').generation)).not.toBe(originalGeneration);
  } finally {
    await page.evaluate(() => window.releaseReplacement?.()).catch(() => {});
    await context.close();
  }
});

test('note save observers cannot change outcomes and unsubscribe without rebuilding notes', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openDatabase(context, { seed: true });
    const result = await page.evaluate(async () => {
      const states = [];
      const unsubscribe = window.db.subscribePersistence((db, ids) => {
        if (ids?.includes('a')) states.push(db.getNoteSaveState('a').status);
        throw new Error('Injected observer failure');
      });
      const note = window.db.getNote('a');
      note.update({ content: 'Observed exact source' });
      const receipt = await window.db.saveNoteWithReceipt(note).completion;
      await window.db.flushCurrentWrites();
      unsubscribe();
      const count = states.length;
      note.update({ content: 'After unsubscribe' });
      const second = await window.db.saveNoteWithReceipt(note).completion;
      return { receipt, second, states, count };
    });
    expect(result.receipt.status).toBe('committed');
    expect(result.second.status).toBe('committed');
    expect(result.states).toEqual(expect.arrayContaining(['pending', 'in-flight', 'committed']));
    expect(result.states).toHaveLength(result.count);
  } finally {
    await context.close();
  }
});
