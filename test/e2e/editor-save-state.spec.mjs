import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function open(context, seed = true) {
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(async (seed) => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    const { Editor } = await import('../src/components/editor.js');
    await import('../src/styles.css');
    if (seed)
      await storage.saveMany([
        ['notes', ['a', 'b'].map((id) => new Note({ id, title: id, content: `Original ${id}` }).toJSON())],
        ['config', {}],
        ['schemaVersion', CURRENT_SCHEMA_VERSION],
      ]);
    window.db = new Database({ storageBackend: storage });
    await window.db.init({ allowLegacyMigration: seed });
    document.querySelector('main').innerHTML =
      '<div id="first" class="editor"></div><div id="second" class="editor"></div>';
    window.reviews = 0;
    window.editors = ['first', 'second'].map((id, i) => {
      const editor = new Editor(document.getElementById(id), window.db, {
        openNote() {},
        openOrCreateByTitle() {},
        reviewStorage: () => window.reviews++,
      });
      editor.open(['a', 'b'][i]);
      editor.setAutosaveInterval(60_000);
      return editor;
    });
    window.commit = storage.commitCurrentVault.bind(storage);
    window.hold = () => {
      storage.commitCurrentVault = async (mutation) => {
        storage.commitCurrentVault = window.commit;
        const result = await window.commit(mutation);
        await new Promise((resolve) => (window.release = resolve));
        return result;
      };
    };
  }, seed);
  return page;
}

async function close(context, page) {
  await page
    ?.evaluate(async () => {
      window.release?.();
      await window.db.flushCurrentWrites();
      for (const editor of window.editors) editor.autosave.cancel();
    })
    .catch(() => {});
  await context.close();
}

const status = (page, pane = 'first') => page.locator(`#${pane} .editor__save-status`);
const block = (page) => page.locator('#first .blk[contenteditable="true"]').first();

test('a pane never labels buffered typing or an older acknowledgement as saved', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  try {
    await expect(status(page)).toHaveText('Saved on this device', { timeout: 2_000 });
    await block(page).fill('First draft');
    await expect(status(page)).toHaveText('Unsaved changes');
    await page.evaluate(() => {
      window.hold();
      window.editors[0].flushPending();
    });
    await page.waitForFunction(() => window.release);
    await expect(status(page)).toHaveText('Saving…');
    await block(page).fill('Newer draft');
    await page.evaluate(async () => {
      window.release();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Unsaved changes');
    await expect(block(page)).toBeFocused();
    await expect(block(page)).toHaveText('Newer draft');
    await expect(status(page, 'second')).toHaveText('Saved on this device');
    await page.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Saved on this device');
  } finally {
    await close(context, page);
  }
});

test('title drafts and composition are not acknowledged by content saves', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  try {
    const title = page.locator('#first .editor__title');
    await title.dispatchEvent('compositionstart');
    await expect(status(page)).toHaveText('Title change not applied');
    await title.dispatchEvent('compositionend');
    await expect(status(page)).toHaveText('Saved on this device');
    await title.fill('Unconfirmed title');
    await title.evaluate((input) => input.setSelectionRange(2, 5));
    await expect(status(page)).toHaveText('Title change not applied', { timeout: 2_000 });
    await page.evaluate(async () => {
      const note = window.db.getNote('b');
      note.update({ content: 'Other note' });
      await window.db.saveNoteWithReceipt(note).completion;
    });
    await expect(title).toBeFocused();
    expect(await title.evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([2, 5]);
    await title.press('Escape');
    await expect(status(page)).toHaveText('Saved on this device');
    await block(page).focus();
    await block(page).dispatchEvent('compositionstart');
    await expect(status(page)).toHaveText('Unsaved changes');
    await block(page).evaluate((element) => {
      element.textContent = 'Composing draft';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await page.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Unsaved changes');
    await block(page).dispatchEvent('compositionend');
    await page.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Saved on this device');
  } finally {
    await close(context, page);
  }
});

test('failed saves retain a draft and retry the current content without duplicating a write', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  try {
    await page.evaluate(() => {
      window.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected transaction failure');
      };
    });
    await block(page).fill('Failed draft');
    await page.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toContainText('Save failed');
    await expect(status(page, 'second')).toHaveText('Saved on this device');
    await block(page).fill('Newer retained draft');
    await page.evaluate(() => {
      window.db.storage.commitCurrentVault = window.commit;
    });
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(status(page)).toHaveText('Saved on this device');
    expect(
      await page.evaluate(
        async () => (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content,
      ),
    ).toBe('Newer retained draft');
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeHidden();
  } finally {
    await close(context, page);
  }
});

test('conflicts are pane specific and lead to recovery instead of automatic overwrite', async ({ browser }) => {
  const context = await browser.newContext();
  const current = await open(context);
  const stale = await open(context, false);
  try {
    await block(current).fill('Committed elsewhere');
    await current.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await block(stale).fill('Conflicting local draft');
    await stale.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(stale)).toHaveText('Conflict — review your draft');
    await expect(status(stale, 'second')).toHaveText('Saved on this device');
    await stale.getByRole('button', { name: 'Review and export' }).click();
    expect(await stale.evaluate(() => window.reviews)).toBe(1);
    await expect(block(stale)).toHaveText('Conflicting local draft');
    expect(
      await stale.evaluate(
        async () => (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content,
      ),
    ).toBe('Committed elsewhere');
    await expect(stale.getByRole('button', { name: 'Retry save' })).toBeHidden();
  } finally {
    await close(context, stale);
  }
});

test('late receipts cannot label another note and destroyed editors release subscriptions', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  try {
    await page.evaluate(() => {
      window.hold();
    });
    await block(page).fill('Outgoing draft');
    await page.evaluate(() => window.editors[0].flushPending());
    await page.waitForFunction(() => window.release);
    await page.evaluate(() => window.editors[0].open('b'));
    await block(page).fill('New note draft');
    await page.evaluate(async () => {
      window.release();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Unsaved changes');
    await expect(block(page)).toHaveText('New note draft');
    expect(
      await page.evaluate(async () => {
        const before = window.db.persistenceListeners.size;
        for (const editor of window.editors) editor.destroy();
        await window.db.flushCurrentWrites();
        return {
          removed: before - window.db.persistenceListeners.size,
          children: document.getElementById('first').childElementCount,
        };
      }),
    ).toEqual({ removed: 2, children: 0 });
  } finally {
    await close(context, page);
  }
});

test('unavailable storage never presents a false saved acknowledgement', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context);
  try {
    await page.evaluate(() => {
      window.db._readOnly = true;
      window.editors[0].open('a');
    });
    await expect(status(page)).toHaveText('Storage unavailable — export your draft');
    await block(page).fill('Recovery-only draft');
    await page.evaluate(async () => {
      window.editors[0].flushPending();
      await window.db.flushCurrentWrites();
    });
    await expect(status(page)).toHaveText('Storage unavailable — export your draft');
    await expect(block(page)).toHaveText('Recovery-only draft');
    await expect(page.locator('#first .editor__save-review')).toBeVisible();
    await expect(page.locator('#first .editor__save-retry')).toBeHidden();
  } finally {
    await close(context, page);
  }
});

test('application panes expose save and recovery state with accessible controls', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const seed = await open(context);
  await seed.close();
  const page = await context.newPage();
  try {
    await page.goto(devUrl());
    await page.waitForFunction(() => window.app?.workspace && window.app?.phase5);
    await page.evaluate(async () => {
      await window.app.ready;
      await window.app.phase5.ready;
      await window.app.phase6.ready;
      await window.app.openNote('a');
      await window.app.db.flush();
      window.app.editor.setAutosaveInterval(60_000);
    });
    const pane = page.locator('[data-pane="primary"]');
    await expect(pane.locator('.editor__save-status')).toHaveText('Saved on this device');
    await pane.locator('.blk[contenteditable="true"]').first().fill('Application draft');
    await expect(pane.locator('.editor__save-status')).toHaveText('Unsaved changes');
    await page.evaluate(async () => {
      window.app.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected app transaction failure');
      };
      window.app.editor.flushPending();
      await window.app.db.flushCurrentWrites();
    });
    await expect(pane.locator('.editor__save-status')).toContainText('Save failed');
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    expect((await new AxeBuilder({ page }).include('.editor__save').analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('save-failure-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).not.toHaveClass(/sidebar-open/);
    await expect(pane.locator('.editor__save-review')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('save-failure-phone.png'), animations: 'disabled' });
    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        width: root.clientWidth,
        height: root.clientHeight,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
      };
    });
    await testInfo.attach('phone-root-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    await pane.getByRole('button', { name: 'Review and export' }).click();
    await expect(page.locator('#conflict-dialog')).toBeVisible();
    await expect(page.locator('#conflict-dialog [data-export]')).toBeEnabled();
    expect(
      await page.evaluate(() => {
        const db = window.app.db;
        const before = db.persistenceListeners.size;
        window.app.workspace.destroy();
        return before - db.persistenceListeners.size;
      }),
    ).toBe(1);
  } finally {
    await context.close();
  }
});
