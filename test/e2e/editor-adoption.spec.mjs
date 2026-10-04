import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function openEditor(context) {
  const seed = await context.newPage();
  await seed.goto(new URL('test/durability.html', devUrl()).href);
  await seed.evaluate(async () => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    await storage.saveMany([
      ['notes', [new Note({ id: 'a', title: 'Adoption', content: 'Original source' }).toJSON()]],
      ['config', {}],
      ['schemaVersion', CURRENT_SCHEMA_VERSION],
    ]);
    const db = new Database({ storageBackend: storage });
    await db.init({ allowLegacyMigration: true });
  });
  await seed.close();
  const page = await context.newPage();
  await page.goto(devUrl());
  await page.waitForFunction(() => window.app?.workspace && window.app?.phase5);
  await page.evaluate(async () => {
    await window.app.ready;
    await window.app.vaultRefreshReady;
    await window.app.phase5.ready;
    await window.app.phase6.ready;
    await window.app.openNote('a');
    await window.app.db.flush();
    window.app.editor.setAutosaveInterval(60_000);
    window.savedSource = async () =>
      (await window.app.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content;
    window.startPlan = (stage, reopen = false) => {
      const db = window.app.db;
      const before = db.getNote('a').toJSON();
      const replacement = { ...before, content: 'Committed replacement' };
      const capture = async () => {
        if (stage === 'safety') await new Promise((resolve) => (window.releaseOperation = resolve));
        return true;
      };
      if (stage === 'acknowledgement') {
        const commit = db.storage.commitCurrentVault.bind(db.storage);
        db.storage.commitCurrentVault = async (mutation) => {
          db.storage.commitCurrentVault = commit;
          const result = await commit(mutation);
          await new Promise((resolve) => (window.releaseOperation = resolve));
          return result;
        };
      }
      window.operation = db
        .commitPlannedNotes([replacement], [before], 'pre_restore', db.captureMutationToken(), capture)
        .then(
          () => {
            if (reopen) window.app.editor.syncAuthoritative(['a']);
            return { applied: true };
          },
          (error) => ({ applied: false, code: error.code }),
        );
    };
  });
  return page;
}

async function finish(context, page) {
  // Do not close a page with a test-controlled transaction still paused.
  await page.evaluate(async () => {
    window.releaseOperation?.();
    await window.operation;
    window.app.editor.flushPending();
    await window.app.db.flush();
  });
  await context.close();
}

test('a clean editor adopts a committed source replacement', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openEditor(context);
    await page.evaluate(() => window.startPlan('none'));
    expect(await page.evaluate(() => window.operation)).toEqual({ applied: true });
    expect(await page.evaluate(() => window.savedSource())).toBe('Committed replacement');
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Committed replacement');
    await expect(page.locator('.editor__blocks')).toContainText('Committed replacement');
  } finally {
    await context.close();
  }
});

test('focused clean content adopts a replacement before further typing', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    const block = page.locator('.editor__blocks .blk[contenteditable="true"]').first();
    await block.click();
    await page.evaluate(() => window.startPlan('none'));
    expect(await page.evaluate(() => window.operation)).toEqual({ applied: true });
    await expect(block).toBeFocused();
    await expect(block).toHaveText('Committed replacement');
    await block.evaluate((element) => {
      const selection = window.getSelection();
      selection.selectAllChildren(element);
      selection.collapseToEnd();
    });
    await block.pressSequentially(' plus typing');
    await page.evaluate(async () => {
      window.app.editor.flushPending();
      await window.app.db.flush();
    });
    expect(await page.evaluate(() => window.savedSource())).toBe('Committed replacement plus typing');
  } finally {
    await finish(context, page);
  }
});

test('a buffered draft keeps undo history across an authoritative sync', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    const block = page.locator('.editor__blocks .blk[contenteditable="true"]').first();
    await block.fill('Buffered draft');
    await page.evaluate(async () => {
      window.app.editor.syncAuthoritative(['a']);
      await window.app.db.flush();
    });
    expect(await page.evaluate(() => window.savedSource())).toBe('Buffered draft');
    await block.press('Control+z');
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Original source');
  } finally {
    await finish(context, page);
  }
});

test('composition during acknowledgement survives an authoritative reopen', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    await page.evaluate(() => window.startPlan('acknowledgement', true));
    await page.waitForFunction(() => window.releaseOperation);
    const block = page.locator('.editor__blocks .blk[contenteditable="true"]').first();
    await block.focus();
    await block.evaluate((element) => {
      window.composingElement = element;
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.textContent = 'Draft composition';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'composition' }));
    });
    await page.evaluate(() => window.releaseOperation());
    expect(await page.evaluate(() => window.operation)).toEqual({ applied: true });
    expect(await page.evaluate(() => window.composingElement.isConnected)).toBe(true);
    await expect(block).toHaveText('Draft composition');
    await block.dispatchEvent('compositionend', { data: 'composition' });
    await page.evaluate(async () => {
      window.app.editor.flushPending();
      await window.app.db.flush();
    });
    expect(await page.evaluate(() => window.savedSource())).toBe('Committed replacement');
    expect(
      await page.evaluate(() =>
        [...window.app.db.conflicts.values()].flatMap((c) => c.mutation.notes.map((n) => n.value?.content)),
      ),
    ).toContain('Draft composition');
  } finally {
    await finish(context, page);
  }
});

test('source adoption retains a pending title and its selection', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    const title = page.locator('.editor__title').first();
    await title.fill('Pending title');
    await title.evaluate((input) => input.setSelectionRange(2, 7));
    await page.evaluate(() => window.startPlan('none'));
    expect(await page.evaluate(() => window.operation)).toEqual({ applied: true });
    await expect(title).toHaveValue('Pending title');
    await expect(title).toBeFocused();
    expect(await title.evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7]);
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Committed replacement');
  } finally {
    await finish(context, page);
  }
});

test('full vault replacement retains a buffered draft on the old generation', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    await page.evaluate(() => {
      const db = window.app.db;
      const commit = db.storage.commitCurrentVault.bind(db.storage);
      db.storage.commitCurrentVault = async (mutation) => {
        db.storage.commitCurrentVault = commit;
        const result = await commit(mutation);
        await new Promise((resolve) => (window.releaseOperation = resolve));
        return result;
      };
      window.operation = db.replaceVault({
        notes: [{ ...db.getNote('a').toJSON(), content: 'Replacement generation' }],
        config: structuredClone(db.config),
      });
    });
    await page.waitForFunction(() => window.releaseOperation);
    await page.locator('.editor__blocks .blk[contenteditable="true"]').first().fill('Old generation draft');
    await page.evaluate(() => window.releaseOperation());
    expect(await page.evaluate(() => window.operation)).toBe(true);
    await page.evaluate(async () => {
      window.app.editor.syncAuthoritative(['a']);
      window.app.editor.flushPending();
      await window.app.db.flush();
    });
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Old generation draft');
    expect(await page.evaluate(() => window.savedSource())).toBe('Replacement generation');
    expect(
      await page.evaluate(() =>
        [...window.app.db.conflicts.values()].flatMap((c) => c.mutation.notes.map((n) => n.value?.content)),
      ),
    ).toContain('Old generation draft');
  } finally {
    await finish(context, page);
  }
});

test('both panes adopt a rename and its rewritten backlink', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    await page.evaluate(async () => {
      const { LinkOperations } = await import('./src/core/link-operations.js');
      const db = window.app.db;
      db.createNote({ id: 'b', title: 'Backlink', content: 'Link [[Adoption]]' });
      await db.flush();
      await window.app.workspace.moveToOtherPane('a');
      await window.app.openNote('b');
      // Put b in the other pane, leaving both editors mounted.
      await window.app.workspace.moveToOtherPane('b');
      const links = new LinkOperations(db);
      await links.applyRenamePlan(links.planRename('a', 'Renamed'));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(window.app.workspace.editors)
            .map((editor) => ({
              id: editor.currentId,
              source: editor.getSourceMarkdown(),
              title: editor.container.querySelector('.editor__title')?.value,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      )
      .toEqual([
        { id: 'a', source: '---\naliases:\n  - Adoption\n---\nOriginal source', title: 'Renamed' },
        { id: 'b', source: 'Link [[Renamed]]', title: 'Backlink' },
      ]);
    expect(await page.evaluate(() => window.savedSource())).toBe('---\naliases:\n  - Adoption\n---\nOriginal source');
  } finally {
    await finish(context, page);
  }
});

test('Properties completion keeps a draft typed after its transaction commits', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    await page.evaluate(() => {
      const db = window.app.db;
      const commit = db.storage.commitCurrentVault.bind(db.storage);
      db.storage.commitCurrentVault = async (mutation) => {
        db.storage.commitCurrentVault = commit;
        const result = await commit(mutation);
        await new Promise((resolve) => (window.releaseOperation = resolve));
        return result;
      };
      window.operation = window.app.phase5.set('a', 'stage', 'reviewed', 'text');
    });
    await page.waitForFunction(() => window.releaseOperation);
    await page.locator('.editor__blocks .blk[contenteditable="true"]').first().fill('Draft during Properties save');
    await page.evaluate(() => window.releaseOperation());
    await page.evaluate(() => window.operation);
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Draft during Properties save');
    await page.evaluate(() => window.app.db.flush());
    expect(await page.evaluate(() => window.savedSource())).toContain('stage: reviewed');
    expect(await page.evaluate(() => window.savedSource())).toContain('Original source');
    expect(
      await page.evaluate(() =>
        [...window.app.db.conflicts.values()].flatMap((c) => c.mutation.notes.map((n) => n.value?.content)),
      ),
    ).toContain('Draft during Properties save');
  } finally {
    await finish(context, page);
  }
});

test('conflict resolution preserves newer buffered typing during acknowledgement', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await openEditor(context);
  try {
    const block = page.locator('.editor__blocks .blk[contenteditable="true"]').first();
    // Own the editor before the independent write so clean-window refresh
    // cannot advance this fixture's base before its conflicting edit begins.
    await block.focus();
    await page.evaluate(async () => {
      const db = window.app.db;
      const snapshot = await db.storage.readCurrentVault();
      const record = snapshot.records.find(([id]) => id === 'a')[1];
      // Independent writer commits without changing this window's model.
      await db.storage.commitCurrentVault({
        generation: snapshot.meta.generation,
        notes: [{ id: 'a', expected: record.version, value: { ...record.value, content: 'Remote authority' } }],
        config: [],
      });
    });
    await block.fill('Initial conflict');
    await page.evaluate(async () => {
      window.app.editor.flushPending();
      await window.app.db.flush();
      const db = window.app.db;
      if (db.conflicts.size !== 1) throw new Error('Expected one retained conflict before testing resolution.');
      const shown = await db.previewConflict([...db.conflicts.keys()][0]);
      const commit = db.storage.commitCurrentVault.bind(db.storage);
      db.storage.commitCurrentVault = async (mutation) => {
        db.storage.commitCurrentVault = commit;
        const result = await commit(mutation);
        await new Promise((resolve) => (window.releaseOperation = resolve));
        return result;
      };
      window.operation = db.resolveConflict(shown, 'keep-current');
    });
    await page.waitForFunction(() => window.releaseOperation);
    await page.locator('.editor__blocks .blk[contenteditable="true"]').first().fill('Newer recovery draft');
    await page.evaluate(() => window.releaseOperation());
    await page.evaluate(() => window.operation);
    await page.evaluate(async () => {
      window.app.editor.syncAuthoritative(['a']);
      await window.app.db.flush();
    });
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Newer recovery draft');
    expect(await page.evaluate(() => window.savedSource())).toBe('Remote authority');
    expect(
      await page.evaluate(() =>
        [...window.app.db.conflicts.values()].flatMap((c) => c.mutation.notes.map((n) => n.value?.content)),
      ),
    ).toContain('Newer recovery draft');
  } finally {
    await finish(context, page);
  }
});

for (const stage of ['safety', 'acknowledgement']) {
  test(`buffered editor typing during ${stage} retains its original source base`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openEditor(context);
      await page.evaluate((stage) => window.startPlan(stage, true), stage);
      await page.waitForFunction(() => window.releaseOperation);
      const block = page.locator('.editor__blocks .blk[contenteditable="true"]').first();
      await block.fill('Draft typed during operation');
      expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Draft typed during operation');
      await page.evaluate(() => window.releaseOperation());
      const outcome = await page.evaluate(() => window.operation);
      expect(outcome.applied).toBe(stage === 'acknowledgement');
      expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Draft typed during operation');
      const saved = await page.evaluate(async () => {
        window.app.editor.flushPending();
        await window.app.db.flushCurrentWrites();
        return {
          content: await window.savedSource(),
          conflicts: [...window.app.db.conflicts.values()].flatMap((c) =>
            c.mutation.notes.map((n) => n.value?.content),
          ),
        };
      });
      if (stage === 'safety') {
        expect(outcome.code).toBe('stale_plan');
        expect(saved).toEqual({ content: 'Draft typed during operation', conflicts: [] });
      } else {
        expect(saved.content).toBe('Committed replacement');
        expect(saved.conflicts).toContain('Draft typed during operation');
      }
    } finally {
      await context.close();
    }
  });
}
