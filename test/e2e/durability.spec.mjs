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
