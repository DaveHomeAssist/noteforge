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
    await window.db.init();
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
