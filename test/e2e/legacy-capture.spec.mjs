import { expect, test } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

// Option C (NF-DUR-MIG-01, Dave 2026-10-04): saves the exact 7114047 storage code
// acknowledges after activation are captured as review items. Nothing from a
// legacy source is applied, and the legacy current-state values are never written.

async function withHarness(browser, run, { webLocks = true } = {}) {
  const context = await browser.newContext();
  try {
    if (!webLocks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    const page = await context.newPage();
    await page.goto(new URL('test/durability.html', devUrl()).href);
    await page.evaluate(async () => {
      window.h = await import('./fixtures/vault-harness.js');
    });
    return await run(page);
  } finally {
    await context.close();
  }
}

const unicode = 'Ünïcode ✓ 日本語 🧪\n\n---\ntitle: kept\nlist: [a, b]\n---\n\n- [ ] task';

for (const webLocks of [true, false]) {
  test(`a legacy IndexedDB tab open across activation is captured exactly (Web Locks ${webLocks})`, async ({
    browser,
  }) => {
    await withHarness(
      browser,
      async (page) => {
        const result = await page.evaluate(async (unicode) => {
          const { h } = window;
          const seed = [h.note('edit', 'Before'), h.note('gone', 'Will be deleted'), h.note('same', 'Unchanged')];
          await h.rawPut([
            ['notes', seed],
            ['config', { theme: 'light' }],
            ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
          ]);
          const legacy = await h.legacyClient();
          const loaded = await legacy.loadNotes();
          const db = await h.openVault();
          const log = h.instrumentWrites();
          const edited = {
            ...loaded[0],
            content: unicode,
            updatedAt: '2026-10-04T12:00:00.000Z',
            future: { kept: [1] },
          };
          const added = h.note('new', 'Created in the old tab');
          const legacyStart = log.length;
          const acknowledged = await legacy.saveNotes([edited, loaded[2], added]);
          await legacy.storage.save('config', { theme: 'dark', legacyOnly: true });
          // Only the old tab's own saves may touch its keys.
          log.splice(legacyStart);
          const first = await db.captureLegacyChanges();
          const again = await db.captureLegacyChanges();
          const conflicts = await h.activeConflicts(db);
          const archives = await h.rawKeys('vault:legacy-archive:');
          const archived = Object.values(await h.rawGet(archives));
          return {
            acknowledged,
            first,
            again,
            kinds: conflicts.map((conflict) => [conflict.mutation.notes[0].id, conflict.legacy.kind]).sort(),
            editRaw: conflicts.find((conflict) => conflict.legacy.kind === 'edit').legacy.raw,
            editDraft: conflicts.find((conflict) => conflict.legacy.kind === 'edit').mutation.notes[0].value,
            current: ['edit', 'gone', 'same', 'new'].map((id) => db.getNote(id)?.content ?? null),
            theme: db.config.theme,
            archived: archived.map((entry) => entry.indexedDB?.config ?? null),
            writes: h.legacyWrites(log),
            edited,
          };
        }, unicode);
        expect(result.acknowledged).toBe(true);
        expect(result.first).toEqual({ status: 'captured', captured: 3 });
        expect(result.again).toEqual({ status: 'unchanged', captured: 0 });
        expect(result.kinds).toEqual([
          ['edit', 'edit'],
          ['gone', 'deletion'],
          ['new', 'new'],
        ]);
        expect(result.editRaw).toEqual(result.edited);
        expect(result.editDraft).toEqual(result.edited);
        expect(result.current).toEqual(['Before', 'Will be deleted', 'Unchanged', null]);
        expect(result.theme).toBe('light');
        expect(result.archived).toEqual([{ theme: 'dark', legacyOnly: true }]);
        expect(result.writes).toEqual([]);
      },
      { webLocks },
    );
  });
}

test('a legacy fallback client is captured after its IndexedDB open fails', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      await h.rawPut([
        ['notes', [h.note('a', 'IndexedDB a')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const db = await h.openVault();
      const fallback = await h.legacyClient({ indexedDB: false });
      // A 7114047 tab without IndexedDB loads the (empty) fallback and saves there.
      const visible = await fallback.loadNotes();
      const acknowledged = await fallback.saveNotes([h.note('fallback', 'Saved in fallback ✓')]);
      const captured = await db.captureLegacyChanges();
      const conflicts = await h.activeConflicts(db);
      return {
        visible,
        acknowledged,
        captured,
        drafts: conflicts.map((conflict) => [conflict.legacy.backend, conflict.mutation.notes[0].value.content]),
        current: db.getNote('a').content,
        local: localStorage.getItem('my-notes-app:notes'),
      };
    });
    expect(result.visible).toEqual([]);
    expect(result.acknowledged).toBe(true);
    expect(result.captured).toEqual({ status: 'captured', captured: 1 });
    expect(result.drafts).toEqual([['localstorage', 'Saved in fallback ✓']]);
    expect(result.current).toBe('IndexedDB a');
    expect(JSON.parse(result.local)[0].content).toBe('Saved in fallback ✓');
  });
});

test('a legacy save that only re-serializes notes in another key order creates no review item', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const reorder = (note) => Object.fromEntries(Object.entries(note).reverse());
      await h.rawPut([
        ['notes', [h.note('a', 'Same a'), h.note('b', 'Same b')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const legacy = await h.legacyClient();
      const db = await h.openVault();
      const loaded = await legacy.loadNotes();
      await legacy.saveNotes([reorder(loaded[0]), reorder({ ...loaded[1], content: 'Edited b' })]);
      const captured = await db.captureLegacyChanges();
      const conflicts = await h.activeConflicts(db);
      return { captured, drafts: conflicts.map((conflict) => conflict.mutation.notes[0].value.content) };
    });
    expect(result).toEqual({ captured: { status: 'captured', captured: 1 }, drafts: ['Edited b'] });
  });
});

test('repeated saves from one older window update one review item and keep every captured version', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      await h.rawPut([
        ['notes', [h.note('a', 'Original')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const legacy = await h.legacyClient();
      const db = await h.openVault();
      const outcomes = [];
      for (const content of ['First legacy', 'Second legacy', 'Third legacy']) {
        await legacy.saveNotes([h.note('a', content)]);
        outcomes.push((await db.captureLegacyChanges()).captured);
      }
      const conflicts = await h.activeConflicts(db);
      return {
        outcomes,
        count: conflicts.length,
        draft: conflicts[0].mutation.notes[0].value.content,
        history: conflicts[0].legacy.history.map((entry) => entry.raw.content),
        inMemory: db.conflicts.size,
      };
    });
    expect(result).toEqual({
      outcomes: [1, 1, 1],
      count: 1,
      draft: 'Third legacy',
      history: ['First legacy', 'Second legacy'],
      inMemory: 1,
    });
  });
});

test('a fresh legacy client copying the fallback into IndexedDB creates no review item; its later edit does', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      localStorage.setItem('my-notes-app:notes', JSON.stringify([h.note('a', 'Fallback era'), h.note('b', 'Other')]));
      localStorage.setItem('my-notes-app:schemaVersion', JSON.stringify(h.CURRENT_SCHEMA_VERSION));
      const db = await h.openVault();
      const legacy = await h.legacyClient();
      const copied = await legacy.loadNotes(); // 7114047 lazily copies the fallback value into IndexedDB
      const afterCopy = await db.captureLegacyChanges();
      const indexedCopy = (await h.rawGet(['notes'])).notes;
      await legacy.saveNotes([{ ...copied[0], content: 'Edited after the copy' }, copied[1]]);
      const afterEdit = await db.captureLegacyChanges();
      const conflicts = await h.activeConflicts(db);
      return {
        afterCopy,
        indexedCopy: indexedCopy.map((note) => note.content),
        afterEdit,
        drafts: conflicts.map((conflict) => [conflict.mutation.notes[0].id, conflict.mutation.notes[0].value.content]),
        current: db.getNote('a').content,
      };
    });
    expect(result).toEqual({
      afterCopy: { status: 'captured', captured: 0 },
      indexedCopy: ['Fallback era', 'Other'],
      afterEdit: { status: 'captured', captured: 1 },
      drafts: [['a', 'Edited after the copy']],
      current: 'Fallback era',
    });
  });
});

test('captured edits resolve through keep, copy and explicit replace; a deletion can only be kept', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const seed = ['keep', 'copy', 'replace', 'deleted'].map((id) => h.note(id, `Current ${id}`));
      await h.rawPut([
        ['notes', seed],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const legacy = await h.legacyClient();
      const db = await h.openVault();
      await legacy.saveNotes(['keep', 'copy', 'replace'].map((id) => h.note(id, `Legacy ${id}`)));
      await db.captureLegacyChanges();
      const byNote = new Map(
        (await h.activeConflicts(db)).map((conflict) => [conflict.mutation.notes[0].id, conflict]),
      );
      const outcomes = {};
      for (const [id, action] of [
        ['keep', 'keep-current'],
        ['copy', 'save-copy'],
        ['replace', 'use-draft'],
      ]) {
        const preview = await db.previewConflict(byNote.get(id).id);
        await db.resolveConflict(preview, action);
        outcomes[id] = action;
      }
      const deletion = await db.previewConflict(byNote.get('deleted').id);
      let replaced = null;
      try {
        await db.resolveConflict(deletion, 'use-draft');
      } catch (error) {
        replaced = error.message;
      }
      const kept = await db.resolveConflict(await db.previewConflict(byNote.get('deleted').id), 'keep-current');
      return {
        outcomes,
        deletion: { canUseDraft: deletion.canUseDraft, canCopy: deletion.canCopy, legacy: deletion.legacy },
        replaced,
        kept: kept.action,
        notes: db
          .getNotesSorted()
          .map((note) => [note.title, note.content])
          .sort((left, right) => left[0].localeCompare(right[0])),
        remaining: (await h.activeConflicts(db)).length,
        archived: (await db.storage.readResolvedConflicts()).length,
      };
    });
    expect(result.deletion).toEqual({
      canUseDraft: false,
      canCopy: false,
      legacy: { backend: 'indexeddb', kind: 'deletion' },
    });
    expect(result.replaced).toMatch(/new plan|Export/);
    expect(result.kept).toBe('keep-current');
    expect(result.notes).toEqual([
      ['copy', 'Current copy'],
      ['copy (Recovered copy)', 'Legacy copy'],
      ['deleted', 'Current deleted'],
      ['keep', 'Current keep'],
      ['replace', 'Legacy replace'],
    ]);
    expect(result.remaining).toBe(0);
    expect(result.archived).toBe(4);
  });
});

test('an interrupted capture writes nothing and the next capture records the same save', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      await h.rawPut([
        ['notes', [h.note('a', 'Original')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const legacy = await h.legacyClient();
      const db = await h.openVault();
      await legacy.saveNotes([h.note('a', 'Legacy save')]);
      const baseline = (await h.rawGet(['vault:legacy-capture']))['vault:legacy-capture'];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (key === 'vault:legacy-capture') this.transaction.abort();
        return request;
      };
      let interrupted = null;
      try {
        await db.captureLegacyChanges();
      } catch (error) {
        interrupted = error.name || 'error';
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const unchanged =
        JSON.stringify((await h.rawGet(['vault:legacy-capture']))['vault:legacy-capture']) === JSON.stringify(baseline);
      const conflictsAfterAbort = (await h.activeConflicts(db)).length;
      const retried = await db.captureLegacyChanges();
      return { interrupted: Boolean(interrupted), unchanged, conflictsAfterAbort, retried };
    });
    expect(result).toEqual({
      interrupted: true,
      unchanged: true,
      conflictsAfterAbort: 0,
      retried: { status: 'captured', captured: 1 },
    });
  });
});

test('startup captures legacy saves made while the vault was closed, before the window is ready', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      await h.rawPut([
        ['notes', [h.note('a', 'Original')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      const legacy = await h.legacyClient();
      const first = await h.openVault();
      const activated = first.upgradedLegacyVault;
      await legacy.saveNotes([h.note('a', 'Saved while closed')]);
      const reopened = await h.openVault({ activate: false });
      return {
        activated,
        reopenedFlag: reopened.upgradedLegacyVault,
        conflicts: [...reopened.conflicts.values()].map((conflict) => conflict.mutation.notes[0].value.content),
        current: reopened.getNote('a').content,
      };
    });
    expect(result).toEqual({
      activated: true,
      reopenedFlag: false,
      conflicts: ['Saved while closed'],
      current: 'Original',
    });
  });
});
