import { expect, test } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

// Regressions for the pre-resume review findings of 2026-10-04 (R1-R10).
// Each case states the finding's failure as an observable storage outcome.

async function withHarness(browser, run) {
  const context = await browser.newContext();
  try {
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

test('R1 activation archives both legacy backends and keeps divergent fallback notes for review', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const indexed = h.note('shared', 'IndexedDB copy ✓');
      const fallbackEdit = h.note('shared', 'Fallback edit — 日本語\n\n---\nstatus: draft', {
        updatedAt: '2026-09-02T00:00:00.000Z',
        tortureMarker: { kept: true },
      });
      const fallbackOnly = h.note('fallback-only', 'Only in fallback 🧪');
      await h.rawPut([
        ['notes', [indexed]],
        ['config', { theme: 'light' }],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      localStorage.setItem('my-notes-app:notes', JSON.stringify([fallbackEdit, fallbackOnly]));
      localStorage.setItem('my-notes-app:config', JSON.stringify({ theme: 'dark' }));
      const beforeLocal = h.legacyLocal();
      const beforeIndexed = await h.rawGet(h.LEGACY_KEYS);
      const db = await h.openVault();
      const snapshot = await db.storage.readCurrentVault();
      const backup = JSON.stringify((await h.rawGet(['vault:legacy-backup']))['vault:legacy-backup'] ?? null);
      return {
        readOnly: db.getPersistenceStatus().readOnly,
        current: db.getNote('shared')?.content ?? null,
        fallbackOnlyCurrent: db.getNote('fallback-only')?.content ?? null,
        drafts: snapshot.conflicts
          .flatMap((conflict) =>
            conflict.mutation.notes.map((write) => [
              write.id,
              write.value?.content ?? null,
              write.value?.tortureMarker ?? null,
            ]),
          )
          .sort(),
        backupKeepsBoth:
          backup.includes('IndexedDB copy ✓') &&
          backup.includes(JSON.stringify(JSON.stringify([fallbackEdit, fallbackOnly])).slice(1, -1)),
        legacyLocalUnchanged: JSON.stringify(h.legacyLocal()) === JSON.stringify(beforeLocal),
        legacyIndexedUnchanged: JSON.stringify(await h.rawGet(h.LEGACY_KEYS)) === JSON.stringify(beforeIndexed),
        theme: db.config.theme,
      };
    });
    expect(result).toEqual({
      readOnly: false,
      current: 'IndexedDB copy ✓',
      fallbackOnlyCurrent: null,
      drafts: [
        ['fallback-only', 'Only in fallback 🧪', null],
        ['shared', 'Fallback edit — 日本語\n\n---\nstatus: draft', { kept: true }],
      ],
      backupKeepsBoth: true,
      legacyLocalUnchanged: true,
      legacyIndexedUnchanged: true,
      theme: 'light',
    });
  });
});

test('R2 a localStorage-only legacy vault activates instead of staying read only', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      localStorage.setItem('my-notes-app:notes', JSON.stringify([h.note('only', 'Fallback-only vault ✓')]));
      localStorage.setItem('my-notes-app:config', JSON.stringify({ theme: 'dark' }));
      localStorage.setItem('my-notes-app:schemaVersion', JSON.stringify(h.CURRENT_SCHEMA_VERSION));
      const beforeLocal = h.legacyLocal();
      let error = null;
      let db = null;
      try {
        db = await h.openVault();
      } catch (caught) {
        error = caught.message;
      }
      return {
        error,
        readOnly: db?.getPersistenceStatus().readOnly ?? null,
        content: db?.getNote('only')?.content ?? null,
        theme: db?.config.theme ?? null,
        marker: Boolean((await h.rawGet(['vault:meta']))['vault:meta']),
        legacyIndexed: await h.rawGet(h.LEGACY_KEYS),
        legacyLocalUnchanged: JSON.stringify(h.legacyLocal()) === JSON.stringify(beforeLocal),
      };
    });
    expect(result).toEqual({
      error: null,
      readOnly: false,
      content: 'Fallback-only vault ✓',
      theme: 'dark',
      marker: true,
      legacyIndexed: {},
      legacyLocalUnchanged: true,
    });
  });
});

test('R3 an activated vault from an older schema migrates forward atomically; a newer one stays closed', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const older = h.CURRENT_SCHEMA_VERSION - 1;
      const meta = { generation: 'older-generation', sequence: 4, schemaVersion: older };
      await h.rawPut([
        ['vault:meta', meta],
        ['vault:config', { values: { theme: 'dark' }, versions: { theme: 2 } }],
        ['note:a', { version: 3, value: h.note('a', 'Older schema ✓', { unknownField: 'kept' }) }],
        ['note:gone', { version: 2, value: null }],
      ]);
      let error = null;
      let db = null;
      try {
        db = await h.openVault({ activate: false });
      } catch (caught) {
        error = caught.message;
      }
      const stored = await h.rawGet(['vault:meta', 'vault:config', 'note:a', 'note:gone']);
      const backups = await h.rawKeys('vault:schema-backup:');
      // A vault from a newer application must never be downgraded or adopted.
      await h.rawPut([['vault:meta', { ...stored['vault:meta'], schemaVersion: h.CURRENT_SCHEMA_VERSION + 1 }]]);
      let newer = null;
      try {
        await h.openVault({ activate: false });
      } catch (caught) {
        newer = caught.message;
      }
      return {
        error,
        readOnly: db?.getPersistenceStatus().readOnly ?? null,
        content: db?.getNote('a')?.content ?? null,
        unknown: db?.getNote('a')?.toJSON().unknownField ?? null,
        migrationConfig: db?.config.frontmatterAliasMigration?.status ?? null,
        meta: stored['vault:meta'],
        tombstone: stored['note:gone'],
        backups: backups.length,
        newer,
      };
    });
    expect(result.error).toBeNull();
    expect(result.readOnly).toBe(false);
    expect(result.content).toBe('Older schema ✓');
    expect(result.unknown).toBe('kept');
    expect(result.migrationConfig).toBe('pending');
    expect(result.meta.schemaVersion).toBe(6);
    expect(result.meta.generation).not.toBe('older-generation');
    expect(result.tombstone).toEqual({ version: 2, value: null });
    expect(result.backups).toBe(1);
    expect(result.newer).toMatch(/unsupported|newer/i);
  });
});

test('R4 stale planned and replacement mutations reject without durable or in-memory conflicts', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const a = await h.seededVault();
      const b = await h.openVault();
      const outcomes = [];
      const plannedToken = a.captureMutationToken();
      await h.save(b, 'b', 'External b');
      try {
        await a.commitPlannedNotes(
          [{ ...a.getNote('a').toJSON(), content: 'Planned a' }],
          [a.getNote('a')],
          'rename',
          plannedToken,
        );
        outcomes.push('applied');
      } catch (error) {
        outcomes.push(error.code ?? error.message);
      }
      const replaceToken = a.captureMutationToken();
      await h.save(b, 'b', 'External b again');
      try {
        await a.replaceVault(
          { notes: [h.note('restored', 'Restored')], config: {}, schemaVersion: h.CURRENT_SCHEMA_VERSION },
          replaceToken,
          { rejectStale: true },
        );
        outcomes.push('applied');
      } catch (error) {
        outcomes.push(error.code ?? error.message);
      }
      const snapshot = await a.storage.readCurrentVault();
      return {
        outcomes,
        stored: snapshot.conflicts.length,
        inMemory: a.conflicts.size,
        a: snapshot.records.find(([id]) => id === 'a')[1].value.content,
      };
    });
    expect(result).toEqual({ outcomes: ['stale_plan', 'stale_plan'], stored: 0, inMemory: 0, a: 'Original a' });
  });
});

test('R5 (disproved) an unseen external commit holds planned work until adoption, then the replan applies', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const a = await h.seededVault();
      const b = await h.openVault();
      await h.save(b, 'b', 'External b');
      await h.save(a, 'a', 'Own a');
      const lagging = a._vaultMeta.sequence;
      const stored = (await a.storage.readCurrentVault()).meta.sequence;
      const plan = () =>
        a.commitPlannedNotes([{ ...a.getNote('a').toJSON(), content: 'Planned a' }], [a.getNote('a')], 'rename');
      let first;
      try {
        await plan();
        first = 'applied';
      } catch (error) {
        first = error.code;
      }
      const seenBefore = a.getNote('b').content;
      const refreshed = (await a.refreshCurrentVault()).status;
      const second = await plan();
      const snapshot = await a.storage.readCurrentVault();
      return {
        lagging,
        stored,
        first,
        seenBefore,
        refreshed,
        second,
        contents: snapshot.records.map(([id, record]) => [id, record.value.content]),
      };
    });
    // The lag is the signal that this window has not seen b's commit. Treating
    // the jump as current would let a plan skip b and make refresh report no change.
    expect(result).toEqual({
      lagging: 0,
      stored: 2,
      first: 'stale_plan',
      seenBefore: 'Original b',
      refreshed: 'refreshed',
      second: true,
      contents: [
        ['a', 'Planned a'],
        ['b', 'External b'],
      ],
    });
  });
});

test('R6 quick capture superseded by a later save that contains it reports the committed successor', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const { CaptureService } = await import('../src/core/capture-service.js');
      await h.rawPut([
        ['notes', [h.note('a', 'Inbox body'), h.note('b', 'Other')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
      ]);
      let release;
      let held = 0;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const backend = new Proxy(h.storage, {
        get(target, key) {
          if (key === 'commitCurrentVault')
            return async (mutation) => {
              if (held++ === 0) await gate;
              return target.commitCurrentVault(mutation);
            };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const db = await h.openVault({ backend });
      const run = async (successor) => {
        const capture = new CaptureService(db);
        const input = { destination: 'existing', noteId: 'a', markdown: `Captured ${successor} ✓` };
        const typing = db.getNote('a');
        typing.update({ content: `${typing.content}\nTyping before ${successor}` });
        db.saveNote(typing); // held in flight on the first run
        const outcome = capture.save(input).then(
          (saved) => ({ ok: true, status: saved.receipt.status, content: saved.note.content }),
          (error) => ({ ok: false, message: error.message }),
        );
        const later = successor === 'kept' ? db.getNote('a') : Object.assign(h.Note.fromJSON(typing.toJSON()), {});
        later.update({ content: `${later.content}\nTyping after ${successor}` });
        db.saveNote(later);
        release();
        const settled = await outcome;
        await db.flushCurrentWrites();
        let retry = null;
        if (!settled.ok)
          retry = await capture.save(input).then(
            () => 'retried',
            (error) => error.message,
          );
        return { ...settled, retry, saved: db.getNote('a').content };
      };
      return { kept: await run('kept'), dropped: await run('dropped') };
    });
    expect(result.kept).toMatchObject({ ok: true });
    expect(result.kept.status).toBe('committed');
    expect(result.kept.content).toContain('Captured kept ✓');
    expect(result.kept.content).toContain('Typing after kept');
    // A successor that does not contain the capture must never acknowledge it.
    expect(result.dropped.ok).toBe(false);
    expect(result.dropped.saved).not.toContain('Captured dropped ✓');
  });
});

test('R7 activated writes never touch legacy current-state keys in either backend', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      await h.rawPut([
        ['notes', [h.note('a', 'Original a'), h.note('b', 'Original b')]],
        ['config', {}],
        ['schemaVersion', h.CURRENT_SCHEMA_VERSION],
        ['persistenceStatus', { lastPersistedAt: '2026-09-01T00:00:00.000Z' }],
      ]);
      const log = h.instrumentWrites();
      const a = await h.openVault();
      const b = await h.openVault();
      await h.save(a, 'a', 'Saved a');
      a.setConfig({ themeMode: 'dark' });
      a.createNote({ title: 'Created', content: 'New' });
      await a.flushCurrentWrites();
      await h.save(b, 'b', 'B wins');
      const conflict = await h.save(a, 'b', 'A loses');
      const preview = await a.previewConflict(conflict.conflictId);
      await a.resolveConflict(preview, 'save-copy');
      await a.refreshCurrentVault();
      await a.commitPlannedNotes([{ ...a.getNote('a').toJSON(), content: 'Planned a' }], [a.getNote('a')], 'rename');
      await a.replaceVault({ notes: [h.note('r', 'Restored')], config: {}, schemaVersion: h.CURRENT_SCHEMA_VERSION });
      await a.flush();
      return { conflict: conflict.status, legacy: h.legacyWrites(log), total: log.length };
    });
    expect(result.conflict).toBe('conflict');
    expect(result.total).toBeGreaterThan(10);
    expect(result.legacy).toEqual([]);
  });
});

test('R8 a drain without a new submission never rewrites a conflict under review', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const a = await h.seededVault();
      const b = await h.openVault();
      await h.save(b, 'a', 'B wins');
      const conflict = await h.save(a, 'a', 'A draft');
      const preview = await a.previewConflict(conflict.conflictId);
      const log = h.instrumentWrites();
      const rewrites = (id) => log.filter((entry) => entry.key === `vault:conflict:${id}`).length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The application flushes on visibility changes and before other actions.
      await a.flush();
      const afterFlush = rewrites(conflict.conflictId);
      let resolved;
      try {
        await a.resolveConflict(preview, 'keep-current');
        resolved = 'resolved';
      } catch (error) {
        resolved = error.message;
      }
      await h.save(b, 'a', 'B wins again');
      const second = await h.save(a, 'a', 'A second draft');
      const created = rewrites(second.conflictId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const unrelated = await h.save(a, 'b', 'Unrelated b');
      const afterUnrelated = rewrites(second.conflictId) - created;
      // A new edit of the conflicted note is an explicit resubmission of its draft.
      const third = await h.save(a, 'a', 'A third draft');
      const stored = (await a.storage.readCurrentVault()).conflicts.map((item) => item.mutation.notes[0].value.content);
      return {
        statuses: [conflict.status, second.status, unrelated.status, third.status],
        afterFlush,
        resolved,
        afterUnrelated,
        resubmitted: rewrites(second.conflictId) - created,
        sameRecord: third.conflictId === second.conflictId,
        stored,
      };
    });
    expect(result).toEqual({
      statuses: ['conflict', 'conflict', 'committed', 'conflict'],
      afterFlush: 0,
      resolved: 'resolved',
      afterUnrelated: 0,
      resubmitted: 1,
      sameRecord: true,
      stored: ['A third draft'],
    });
  });
});

test('R9 an unchanged window refresh reads only vault metadata, yet sees new commits and conflicts', async ({
  browser,
}) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const { h } = window;
      const a = await h.seededVault();
      const b = await h.openVault();
      let fullReads = 0;
      const read = h.storage.readCurrentVault;
      h.storage.readCurrentVault = async (...args) => {
        fullReads++;
        return read.apply(h.storage, args);
      };
      const unchanged = [];
      for (let index = 0; index < 3; index++) unchanged.push((await a.refreshCurrentVault()).status);
      const quietReads = fullReads;
      await h.save(b, 'b', 'External b');
      const commit = (await a.refreshCurrentVault()).status;
      await h.save(a, 'a', 'A first');
      const stale = await h.save(b, 'a', 'B stale');
      const conflict = (await a.refreshCurrentVault()).status;
      h.storage.readCurrentVault = read;
      return {
        unchanged,
        quietReads,
        commit,
        b: a.getNote('b').content,
        stale: stale.status,
        conflict,
        size: a.conflicts.size,
      };
    });
    expect(result).toEqual({
      unchanged: ['unchanged', 'unchanged', 'unchanged'],
      quietReads: 0,
      commit: 'refreshed',
      b: 'External b',
      stale: 'conflict',
      conflict: 'refreshed',
      size: 1,
    });
  });
});

test('R10 a replacement without a sequence is rejected synchronously and stores nothing', async ({ browser }) => {
  await withHarness(browser, async (page) => {
    const result = await page.evaluate(async () => {
      const vault = await import('../src/core/vault-transactions.js');
      const connection = await new Promise((resolve, reject) => {
        const request = indexedDB.open('replacement-contract', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await vault.initializeVault(
        connection,
        'kv',
        {
          timestamp: '2026-10-04T00:00:00.000Z',
          indexedDB: {},
          localStorage: null,
          backup: {},
          migrated: { notes: [{ id: 'a', content: 'A' }], config: {}, schemaVersion: 6 },
        },
        'initial',
      );
      const outcomes = [];
      for (const generation of ['initial', 'other']) {
        let promise = null;
        try {
          promise = vault.commitVault(connection, 'kv', {
            generation,
            timestamp: '2026-10-04T00:00:00.000Z',
            conflictId: `replacement-${generation}`,
            replacement: { notes: [], config: {}, schemaVersion: 6 },
          });
          outcomes.push('accepted');
        } catch (error) {
          outcomes.push(error.name);
        }
        if (promise) await promise.catch((error) => outcomes.push(`async ${error.name}`));
      }
      const snapshot = await vault.readVault(connection, 'kv');
      return { outcomes, conflicts: snapshot.conflicts.length, records: snapshot.records.length };
    });
    expect(result).toEqual({ outcomes: ['TypeError', 'TypeError'], conflicts: 0, records: 1 });
  });
});
