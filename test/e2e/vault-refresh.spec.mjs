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
    if (seed)
      await storage.saveMany([
        ['notes', ['a', 'b'].map((id) => new Note({ id, title: id, content: `Original ${id}` }).toJSON())],
        ['config', {}],
        ['schemaVersion', CURRENT_SCHEMA_VERSION],
      ]);
    window.db = new Database({ storageBackend: storage, onNotesPersisted: async () => {} });
    await window.db.init({ allowLegacyMigration: seed });
    window.save = async (id, content) => {
      const note = window.db.getNote(id);
      note.update({ content });
      window.db.saveNote(note);
      return window.db.flushCurrentWrites();
    };
    window.gateRead = () => {
      const read = storage.readCurrentVault.bind(storage);
      storage.readCurrentVault = async () => {
        storage.readCurrentVault = read;
        const snapshot = await read();
        await new Promise((resolve) => {
          window.releaseRead = resolve;
        });
        return snapshot;
      };
    };
  }, seed);
  return page;
}

test('clean refresh adopts notes, settings, deletions and invalidates prior plans', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await b.evaluate(() => {
      window.token = window.db.captureMutationToken();
      window.events = [];
      window.db.subscribe((_, ids, external) => window.events.push({ ids, external }));
    });
    await a.evaluate(async () => {
      await window.save('a', 'New saved content');
      window.db.setConfig({ themeMode: 'dark' });
      window.db.deleteNote('b');
      await window.db.flush();
    });
    const result = await b.evaluate(async () => {
      const refresh = await window.db.refreshCurrentVault();
      return {
        refresh,
        a: window.db.getNote('a').content,
        deleted: window.db.notes.get('b').deletedAt,
        theme: window.db.config.themeMode,
        token: window.token,
        current: window.db.captureMutationToken(),
        events: window.events,
      };
    });
    expect(result.refresh.status).toBe('refreshed');
    expect(result.refresh.noteIds.sort()).toEqual(['a', 'b']);
    expect(result.a).toBe('New saved content');
    expect(result.deleted).toBeTruthy();
    expect(result.theme).toBe('dark');
    expect(result.current.localRevision).toBeGreaterThan(result.token.localRevision);
    expect(result.events).toEqual([{ ids: result.refresh.noteIds, external: true }]);
    expect(await b.evaluate(() => window.db.refreshCurrentVault())).toEqual({ status: 'unchanged' });
    expect(await b.evaluate(() => window.save('a', 'Saved after refresh'))).toBe(true);
  } finally {
    await context.close();
  }
});

test('raw local model edits block refresh across a replacement generation', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    const before = await b.evaluate(() => window.db.captureMutationToken());
    await b.evaluate(() => window.db.getNote('a').update({ content: 'Unqueued draft' }));
    await a.evaluate(async () => {
      const notes = [...window.db.notes.values()].map((note) => note.toJSON());
      notes[0].content = 'Replacement authority';
      return window.db.replaceVault({ notes, config: {} });
    });
    expect(await b.evaluate(() => window.db.refreshCurrentVault())).toEqual({ status: 'deferred' });
    expect(await b.evaluate(() => window.db.captureMutationToken())).toEqual(before);
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Unqueued draft');
    expect(
      await b.evaluate(() => {
        window.db.saveNote(window.db.getNote('a'));
        return window.db.flushCurrentWrites();
      }),
    ).toBe(false);
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Replacement authority');
    expect(await reopened.evaluate(() => [...window.db.conflicts.values()][0].mutation.notes[0].value.content)).toBe(
      'Unqueued draft',
    );
  } finally {
    await context.close();
  }
});

test('queued conflicts and raw settings are never treated as a clean refresh', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => window.save('a', 'Authority'));
    await b.evaluate(() => window.save('a', 'Conflicting draft'));
    expect(await b.evaluate(() => window.db.refreshCurrentVault())).toEqual({ status: 'deferred' });
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Conflicting draft');
    const c = await open(context);
    await c.evaluate(() => {
      window.db.config.localOnly = 'Raw config draft';
    });
    expect(await c.evaluate(() => window.db.refreshCurrentVault())).toEqual({ status: 'deferred' });
  } finally {
    await context.close();
  }
});

for (const draft of ['raw note', 'queued note', 'UI draft']) {
  test(`a ${draft} appearing during the read prevents adoption`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const a = await open(context, true);
      const b = await open(context);
      await a.evaluate(() => window.save('a', 'New authority'));
      await b.evaluate(() => {
        window.allowRefresh = true;
        window.gateRead();
        window.refresh = window.db.refreshCurrentVault(() => window.allowRefresh);
      });
      await b.waitForFunction(() => window.releaseRead);
      await b.evaluate((draft) => {
        if (draft === 'UI draft') window.allowRefresh = false;
        else {
          window.db.getNote('a').update({ content: 'Draft during read' });
          if (draft === 'queued note') window.db.saveNote(window.db.getNote('a'));
        }
        window.releaseRead();
      }, draft);
      expect(await b.evaluate(() => window.refresh)).toEqual({ status: 'deferred' });
      expect(await b.evaluate(() => window.db.getNote('a').content)).toBe(
        draft === 'UI draft' ? 'Original a' : 'Draft during read',
      );
    } finally {
      await context.close();
    }
  });
}

test('a delayed read cannot reverse a newer refresh and a failed read leaves state intact', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => window.save('a', 'First authority'));
    await b.evaluate(() => {
      window.gateRead();
      window.oldRefresh = window.db.refreshCurrentVault();
    });
    await b.waitForFunction(() => window.releaseRead);
    await a.evaluate(() => window.save('a', 'Second authority'));
    expect((await b.evaluate(() => window.db.refreshCurrentVault())).status).toBe('refreshed');
    await b.evaluate(() => window.releaseRead());
    expect(await b.evaluate(() => window.oldRefresh)).toEqual({ status: 'deferred' });
    expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Second authority');
    const result = await b.evaluate(async () => {
      const before = window.db.captureMutationToken();
      window.db.storage.readCurrentVault = async () => {
        throw new Error('Injected refresh read failure');
      };
      const error = await window.db.refreshCurrentVault().catch((error) => error.message);
      return { before, after: window.db.captureMutationToken(), error };
    });
    expect(result.error).toBe('Injected refresh read failure');
    expect(result.after).toEqual(result.before);
  } finally {
    await context.close();
  }
});

test('malformed and future saved snapshots leave the complete current model intact', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const b = await open(context);
    await a.evaluate(() => window.save('a', 'New external source'));
    const result = await b.evaluate(async () => {
      const read = window.db.storage.readCurrentVault.bind(window.db.storage);
      const before = JSON.stringify([...window.db.notes.values()].map((note) => note.toJSON()));
      const token = window.db.captureMutationToken();
      const errors = [];
      for (const invalid of ['future', 'identity', 'source', 'version', 'serialization']) {
        window.db.storage.readCurrentVault = async () => {
          const snapshot = await read();
          if (invalid === 'future') snapshot.meta.schemaVersion++;
          else if (invalid === 'identity') snapshot.records[1][1].value.id = 'wrong-id';
          else if (invalid === 'source') snapshot.records[1][1].value.content = {};
          else if (invalid === 'version') snapshot.records[1][1].version = 0;
          else snapshot.records[1][1].value.unknownMetadata = 1n;
          return snapshot;
        };
        errors.push(
          await window.db.refreshCurrentVault().then(
            () => null,
            (error) => error.message,
          ),
        );
      }
      return {
        before,
        after: JSON.stringify([...window.db.notes.values()].map((note) => note.toJSON())),
        token,
        afterToken: window.db.captureMutationToken(),
        errors,
      };
    });
    expect(result.errors.every(Boolean)).toBe(true);
    expect(result.after).toBe(result.before);
    expect(result.afterToken).toEqual(result.token);
  } finally {
    await context.close();
  }
});

for (const broadcast of [true, false]) {
  test(`watcher reconciles hints and resume, and disposes listeners (broadcast ${broadcast})`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      if (!broadcast)
        await context.addInitScript(() => {
          window.BroadcastChannel = undefined;
        });
      const a = await open(context, true);
      const b = await open(context);
      for (const page of [a, b])
        await page.evaluate(async () => {
          const { watchVault } = await import('../src/app/vault-refresh.js');
          window.stop = watchVault({ db: window.db, editor: { canRefreshFromStorage: () => true } }, () => {});
        });
      await a.evaluate(() => window.save('a', 'Watch update'));
      if (!broadcast) await b.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      await expect.poll(() => b.evaluate(() => window.db.getNote('a').content)).toBe('Watch update');
      await b.evaluate(() => {
        window.stop();
        window.readsAfterStop = 0;
        window.db.storage.readCurrentVault = async () => {
          window.readsAfterStop++;
          throw new Error('Stopped watcher read');
        };
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('focus'));
      });
      await a.evaluate(() => window.save('a', 'After stop'));
      await b.waitForTimeout(250);
      expect(await b.evaluate(() => window.readsAfterStop)).toBe(0);
      expect(await b.evaluate(() => window.db.getNote('a').content)).toBe('Watch update');
    } finally {
      await context.close();
    }
  });
}

test('application resume refreshes a clean editor while an active draft survives external changes', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const app = await context.newPage();
    await app.goto(devUrl());
    await app.evaluate(async () => {
      await window.app.ready;
      await window.app.vaultRefreshReady;
      await window.app.openNote('a');
      await window.app.db.flush();
    });
    await a.evaluate(() => window.save('a', 'Refreshed body'));
    await app.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Refreshed body');
    const editor = app.locator('.editor__blocks [contenteditable="true"]').first();
    await editor.click();
    await app.evaluate(() => window.app.editor.setAutosaveInterval(10_000));
    await editor.fill('Local UI draft');
    await a.evaluate(() => window.save('a', 'Later external version'));
    await app.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await app.waitForTimeout(250);
    expect(await app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Local UI draft');
    await app.evaluate(async () => {
      window.app.editor.flushPending();
      await window.app.db.flush();
    });
    await expect(
      app.locator('.storage-error').getByRole('button', { name: 'Review and export', exact: true }),
    ).toBeVisible();
    const reopened = await open(context);
    expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Later external version');
    expect(
      await reopened.evaluate(() =>
        [...window.db.conflicts.values()].some(
          (conflict) => conflict.mutation.notes?.[0]?.value?.content === 'Local UI draft',
        ),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('external source refresh resets stale undo and external deletion clears application selection', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const a = await open(context, true);
    const app = await context.newPage();
    await app.goto(devUrl());
    await app.evaluate(() => window.app.ready);
    await app.waitForFunction(() => window.app.workspace);
    await app.evaluate(async () => {
      await window.app.phase6.ready;
      await window.app.openNote('a');
      window.app.editor.applyFindReplacement('Local committed edit');
      await window.app.db.flush();
    });
    expect(await app.evaluate(() => window.app.editor.blockEditor.exportHistory().undoStack.length)).toBeGreaterThan(0);
    await a.evaluate(async () => {
      await window.db.refreshCurrentVault();
      await window.save('a', 'External source');
      window.db.setConfig({ themeMode: 'dark' });
      await window.db.flush();
    });
    await app.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('External source');
    expect(await app.evaluate(() => window.app.editor.blockEditor.exportHistory())).toEqual({
      undoStack: [],
      redoStack: [],
    });
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await a.evaluate(async () => {
      await window.db.refreshCurrentVault();
      window.db.deleteNote('a');
      await window.db.flush();
    });
    await app.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => app.evaluate(() => window.app.currentId !== 'a')).toBe(true);
    const selection = await app.evaluate(() => ({ app: window.app.currentId, editor: window.app.editor.currentId }));
    expect(selection.app).toBe(selection.editor);
    if (selection.app) expect(selection.app).toBe('b');
    await a.evaluate(async () => {
      window.db.deleteNote('b');
      await window.db.flush();
    });
    await app.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => app.evaluate(() => window.app.currentId)).toBeNull();
    expect(await app.evaluate(() => window.app.editor.currentId)).toBeNull();
    await expect(app.locator('.editor__empty').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const denied of [false, true]) {
  test(`window navigation is independent of shared settings (session storage denied ${denied})`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const seed = await open(context, true);
      await seed.evaluate(async () => {
        window.db.setParent('b', 'a');
        await window.db.flush();
      });
      expect(await seed.evaluate(() => window.db.getNote('b').parentId)).toBe('a');
      if (denied)
        await context.addInitScript(() =>
          Object.defineProperty(window, 'sessionStorage', {
            get() {
              throw new Error('Injected denied session storage');
            },
          }),
        );
      const ready = async (page) => {
        await page.evaluate(() => window.app.ready);
        await page.waitForFunction(() => window.app.phase6 && window.app.navigationController);
        await page.evaluate(async () => {
          await window.app.phase6.ready;
          await window.app.db.flush();
        });
      };
      const a = await context.newPage();
      await a.goto(devUrl());
      await ready(a);
      const b = await context.newPage();
      await b.goto(devUrl());
      await ready(b);
      const before = await seed.evaluate(() => window.db.storage.readCurrentVault());
      const previewToken = await a.evaluate(() => window.app.db.captureMutationToken());
      await a.locator('.note-item[data-id="a"] [data-twist]').click();
      await b.locator('.note-item[data-id="a"] [data-twist]').click();
      await a.evaluate(async () => {
        await window.app.openNote('a');
        await window.app.workspace.toggleSplit();
        await window.app.db.flush();
      });
      await b.evaluate(async () => {
        await window.app.openNote('b');
        await window.app.db.flush();
      });
      const inspect = (page) =>
        page.evaluate(() => ({
          current: window.app.currentId,
          split: window.app.workspace.state.split.enabled,
          recent: window.app.windowState.get('recentNoteIds')[0],
          collapsed: window.app.windowState.get('collapsed'),
          conflicts: window.app.db.conflicts.size,
        }));
      const aState = { current: 'a', split: true, recent: 'a', collapsed: ['a'], conflicts: 0 };
      const bState = { current: 'b', split: false, recent: 'b', collapsed: [], conflicts: 0 };
      await expect.poll(() => inspect(a)).toEqual(aState);
      await expect.poll(() => inspect(b)).toEqual(bState);
      const after = await seed.evaluate(() => window.db.storage.readCurrentVault());
      expect(after.config).toEqual(before.config);
      expect(after.meta).toEqual(before.meta);
      expect(await a.evaluate(() => window.app.db.captureMutationToken())).toEqual(previewToken);
      if (!denied) {
        await a.reload();
        await ready(a);
        await b.reload();
        await ready(b);
        await expect.poll(() => inspect(a)).toEqual(aState);
        await expect.poll(() => inspect(b)).toEqual(bState);
      }
      await a.evaluate(async () => {
        window.app.editor.applyFindReplacement('Note saving remains durable');
        await window.app.db.flush();
      });
      const reopened = await open(context);
      expect(await reopened.evaluate(() => window.db.getNote('a').content)).toBe('Note saving remains durable');
    } finally {
      await context.close();
    }
  });
}

for (const count of [1000, 5000]) {
  test(`ordinary saves touch one note at ${count} notes; record persistence and refresh cost`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext();
    try {
      const page = await open(context, true);
      const result = await page.evaluate(async (count) => {
        const { Note } = await import('../src/core/note.js');
        const { Database } = await import('../src/core/database.js');
        const notes = Array.from({ length: count }, (_, index) =>
          new Note({
            id: `scale-${index}`,
            title: `Scale ${index}`,
            content: `# Note ${index}\n\nRepresentative Markdown with [[Scale 0]] and #tag.`,
          }).toJSON(),
        );
        await window.db.replaceVault({ notes, config: {} });
        const observer = new Database({ storageBackend: window.db.storage, onNotesPersisted: async () => {} });
        await observer.init();
        const put = IDBObjectStore.prototype.put;
        const cursor = IDBObjectStore.prototype.openCursor;
        const writes = [];
        let cursors = 0;
        IDBObjectStore.prototype.put = function (value, key) {
          writes.push(key);
          return put.call(this, value, key);
        };
        IDBObjectStore.prototype.openCursor = function (...args) {
          cursors++;
          return cursor.apply(this, args);
        };
        const times = [];
        try {
          for (let index = 0; index < 25; index++) {
            const start = performance.now();
            if (!(await window.save('scale-0', `Edit ${index}`))) throw new Error('Scale save was not acknowledged');
            times.push(performance.now() - start);
          }
        } finally {
          IDBObjectStore.prototype.put = put;
          IDBObjectStore.prototype.openCursor = cursor;
        }
        const start = performance.now();
        const refresh = await observer.refreshCurrentVault();
        const refreshMs = performance.now() - start;
        const samples = times.slice(5).sort((a, b) => a - b);
        return {
          count,
          samples,
          medianMs: samples[10],
          p95Ms: samples[18],
          maxMs: samples.at(-1),
          refreshMs,
          refresh: refresh.status,
          observed: observer.getNote('scale-0').content,
          noteWrites: writes.filter((key) => key.startsWith('note:')),
          totalWrites: writes.length,
          cursors,
        };
      }, count);
      expect(result.noteWrites).toEqual(Array(25).fill('note:scale-0'));
      expect(result.totalWrites).toBe(75);
      expect(result.cursors).toBe(0);
      expect(result.refresh).toBe('refreshed');
      expect(result.observed).toBe('Edit 24');
      await testInfo.attach(`persistence-${count}`, {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      console.log(`PERSISTENCE_MEASUREMENT ${testInfo.project.name} ${JSON.stringify(result)}`);
    } finally {
      await context.close();
    }
  });
}
