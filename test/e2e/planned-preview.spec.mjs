import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { devUrl } from './support/runtime.mjs';

async function openHistory(context) {
  const writer = await context.newPage();
  await writer.goto(new URL('test/durability.html', devUrl()).href);
  await writer.evaluate(async () => {
    const { Database } = await import('../src/core/database.js');
    const { storage } = await import('../src/core/storage.js');
    const { Note } = await import('../src/core/note.js');
    const { RevisionStore } = await import('../src/core/revision-store.js');
    const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
    const note = new Note({ id: 'a', title: 'History destination', content: 'Current content' });
    await storage.saveMany([
      ['notes', [note.toJSON()]],
      ['config', {}],
      ['schemaVersion', CURRENT_SCHEMA_VERSION],
    ]);
    window.db = new Database({ storageBackend: storage, onNotesPersisted: async () => {} });
    // Synthetic activation only; actual cached-client migration remains gated.
    await window.db.init({ allowLegacyMigration: true });
    const revisions = new RevisionStore(storage);
    await revisions.capture({ ...note.toJSON(), content: 'Selected revision' }, { reason: 'manual', force: true });
    window.save = async (content) => {
      const current = window.db.getNote('a');
      current.update({ content });
      window.db.saveNote(current);
      return window.db.flushCurrentWrites();
    };
    window.savedContent = async () =>
      (await storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value.content;
  });
  const app = await context.newPage();
  await app.goto(devUrl());
  await app.evaluate(async () => {
    await window.app.ready;
    await window.app.vaultRefreshReady;
    await window.app.openNote('a');
    await window.app.db.flush();
  });
  await app.locator('#menu-btn').click();
  await app.locator('#history-btn').click();
  await expect(app.locator('#history-restore')).toBeEnabled();
  await expect(app.locator('#history-diff')).toContainText('Current content');
  await app.evaluate(() => {
    window.confirmations = 0;
    window.app.history.confirmRestore = async () => {
      window.confirmations++;
      return true;
    };
  });
  return { app, writer };
}

test('history rejects a stale comparison and refreshes before a separately confirmed restore', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    expect(await writer.evaluate(() => window.save('Acknowledged elsewhere'))).toBe(true);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-status')).toContainText('Refresh the comparison');
    await expect(app.locator('#history-restore')).toBeDisabled();
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
    await app.locator('#history-refresh').click();
    await expect(app.locator('#history-diff')).toContainText('Acknowledged elsewhere');
    await expect(app.locator('#history-restore')).toBeEnabled();
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
    expect(await app.evaluate(() => window.confirmations)).toBe(1);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-status')).toContainText('Revision restored.');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Selected revision');
    expect(await app.evaluate(() => window.confirmations)).toBe(2);
    expect(
      await app.evaluate(async () => {
        const revisions = await window.app.recovery.listRevisions('a');
        const safety = revisions.find((revision) => revision.reason === 'pre_restore');
        return (await window.app.recovery.revisions.materialize(safety.id)).content;
      }),
    ).toBe('Acknowledged elsewhere');
  } finally {
    await context.close();
  }
});

test('history retains an edit made while confirmation is pending', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    await app.evaluate(() => {
      window.app.history.confirmRestore = () =>
        new Promise((resolve) => {
          window.confirmRestore = resolve;
        });
    });
    await app.locator('#history-restore').click();
    await app.waitForFunction(() => window.confirmRestore);
    expect(
      await app.evaluate(async () => {
        const note = window.app.db.getNote('a');
        note.update({ content: 'Acknowledged during confirmation' });
        window.app.db.saveNote(note);
        return window.app.db.flushCurrentWrites();
      }),
    ).toBe(true);
    await app.evaluate(() => window.confirmRestore(true));
    await expect(app.locator('#history-status')).toContainText('Refresh the comparison');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged during confirmation');
  } finally {
    await context.close();
  }
});

test('dismissed history confirmation cannot restore or replace a reopened preview', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    await app.evaluate(() => {
      window.app.history.confirmRestore = () =>
        new Promise((resolve) => {
          window.confirmRestore = resolve;
        });
    });
    await app.locator('#history-restore').click();
    await app.waitForFunction(() => window.confirmRestore);
    await app.locator('#history-overlay [data-close]').last().click();
    await expect(app.locator('#history-overlay')).toBeHidden();
    await app.evaluate(() => window.app.history.show('a'));
    await expect(app.locator('#history-restore')).toBeEnabled();
    await app.evaluate(() => window.confirmRestore(true));
    expect(await writer.evaluate(() => window.savedContent())).toBe('Current content');
    await expect(app.locator('#history-status')).toContainText('Showing revision');
    await expect(app.locator('#history-restore')).toBeEnabled();
  } finally {
    await context.close();
  }
});

test('history refresh preserves an unqueued draft and keeps restore disabled', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openHistory(context);
    expect(await writer.evaluate(() => window.save('Acknowledged elsewhere'))).toBe(true);
    await app.locator('#history-restore').click();
    await expect(app.locator('#history-refresh')).toBeVisible();
    await app.evaluate(() => window.app.db.getNote('a').update({ content: 'Unqueued draft' }));
    await app.locator('#history-refresh').click();
    await expect(app.locator('#history-status')).toContainText('An active draft was preserved');
    await expect(app.locator('#history-restore')).toBeDisabled();
    expect(await app.evaluate(() => window.app.db.getNote('a').content)).toBe('Unqueued draft');
    expect(await writer.evaluate(() => window.savedContent())).toBe('Acknowledged elsewhere');
  } finally {
    await context.close();
  }
});

test('stale history controls support keyboard refresh and accessible light and dark layouts', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const { app, writer } = await openHistory(context);
    for (const width of [1440, 375]) {
      await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      for (const theme of ['light', 'dark']) {
        await app.evaluate((mode) => window.app.theme.setMode(mode, { persist: false }), theme);
        const content = `Saved for ${width} ${theme}`;
        expect(await writer.evaluate((value) => window.save(value), content)).toBe(true);
        await app.locator('#history-restore').click();
        await expect(app.getByRole('button', { name: 'Refresh comparison' })).toBeVisible();
        await waitForReviewPaint(app);
        const scan = await new AxeBuilder({ page: app })
          .include('#history-overlay')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(scan.violations, `${width}/${theme}`).toEqual([]);
        await app.getByRole('button', { name: 'Refresh comparison' }).focus();
        await app.keyboard.press('Enter');
        await expect(app.locator('#history-restore')).toBeEnabled();
        await expect(app.locator('#history-diff')).toContainText(content);
        expect(await writer.evaluate(() => window.savedContent())).toBe(content);
      }
    }
  } finally {
    await context.close();
  }
});

async function openWork(context) {
  const result = await openHistory(context);
  await result.app.evaluate(() => {
    window.app.history.close();
    // Deterministically leave this window stale until the explicit UI refresh.
    window.app.stopVaultRefresh?.();
  });
  return result;
}

async function menu(app, selector) {
  await app.locator('#menu-btn').click();
  await app.locator(selector).click();
}

async function saved(writer) {
  return writer.evaluate(
    async () => (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'a')[1].value,
  );
}

async function waitForReviewPaint(app) {
  await app.evaluate(async () => {
    await document.fonts.ready;
    // A hide/show geometry probe and theme update need a rendered frame before
    // a newly created CSS animation or transition can report completion.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await app.waitForFunction(() =>
    document.getAnimations().every((animation) => !animation.pending && animation.playState !== 'running'),
  );
}

async function checkReviewAccessibility(app, selector) {
  for (const width of [1440, 375]) {
    await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const theme of ['light', 'dark']) {
      await app.evaluate((mode) => window.app.theme.setMode(mode, { persist: false }), theme);
      await waitForReviewPaint(app);
      const rendering = await app.evaluate((target) => {
        const panel = document.querySelector(target);
        return {
          theme: document.documentElement.dataset.theme,
          elements: [panel, ...panel.querySelectorAll('.modal__panel, button, dd')].map((element) => {
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              id: element.id,
              text: element.textContent.slice(0, 70),
              color: style.color,
              background: style.backgroundColor,
              opacity: style.opacity,
            };
          }),
          animations: document.getAnimations().map((animation) => ({
            target: animation.effect?.target?.outerHTML.slice(0, 180),
            name: animation.animationName || animation.transitionProperty,
            state: animation.playState,
            time: animation.currentTime,
            timing: animation.effect?.getComputedTiming(),
          })),
        };
      }, selector);
      await test.info().attach(`review-rendering-${selector}-${width}-${theme}`, {
        body: JSON.stringify(rendering),
        contentType: 'application/json',
      });
      const scan = await new AxeBuilder({ page: app })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(scan.violations, `${selector}/${width}/${theme}`).toEqual([]);
      const geometry = await app.evaluate((target) => {
        const root = document.documentElement;
        const measure = () => ({ width: root.scrollWidth, height: root.scrollHeight });
        const panel = document.querySelector(target);
        const visible = measure();
        panel.hidden = true;
        const shell = measure();
        panel.hidden = false;
        return { visible, shell, viewport: { width: root.clientWidth, height: root.clientHeight } };
      }, selector);
      // F07 tracks existing phone shell overflow separately. New review controls
      // may not enlarge it; attach exact dimensions rather than claiming F07 passes.
      await test.info().attach(`review-geometry-${selector}-${width}-${theme}`, {
        body: JSON.stringify(geometry),
        contentType: 'application/json',
      });
      expect(geometry.visible.width).toBeLessThanOrEqual(Math.max(geometry.shell.width, geometry.viewport.width));
      expect(geometry.visible.height).toBeLessThanOrEqual(Math.max(geometry.shell.height, geometry.viewport.height));
    }
  }
  await app.setViewportSize({ width: 1440, height: 900 });
}

for (const [button, selector] of [
  ['#find-replace-btn', '#find-replace-panel'],
  ['#backup-btn', '#backup-overlay'],
]) {
  test(`review accessibility waits for slow transitions in ${selector}`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { app } = await openWork(context);
      // A duration longer than the former fixed delay makes the readiness
      // requirement deterministic instead of relying on a busy CI renderer.
      await app.addStyleTag({
        content: '.btn { transition-duration: 2s !important; } .modal__panel { animation-duration: 2s !important; }',
      });
      await menu(app, button);
      await checkReviewAccessibility(app, selector);
    } finally {
      await context.close();
    }
  });
}

test('rename keeps its proposed title and requires explicit refreshed review after a remote edit', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await app.evaluate(() => window.app.editor.actions.requestRename('a', 'Reviewed name'));
    await expect(app.locator('#link-tools-apply')).toBeEnabled();
    expect(await writer.evaluate(() => window.save('Acknowledged remote content'))).toBe(true);
    await app.locator('#link-tools-apply').click();
    await expect(app.locator('#link-tools-status')).toContainText('Refresh the preview');
    await expect(app.locator('#link-tools-apply')).toBeDisabled();
    await expect(app.locator('#link-rename-input')).toHaveValue('Reviewed name');
    await checkReviewAccessibility(app, '#link-tools-overlay');
    await app.locator('#link-tools-refresh').click();
    await expect(app.locator('#link-tools-apply')).toBeEnabled();
    expect((await saved(writer)).title).toBe('History destination');
    await app.locator('#link-tools-apply').click();
    await expect(app.locator('#link-tools-status')).toContainText('Rename completed');
    expect((await saved(writer)).title).toBe('Reviewed name');
    expect((await saved(writer)).content).toContain('Acknowledged remote content');
  } finally {
    await context.close();
  }
});

test('vault replace refreshes its match preview without applying under the old confirmation', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await menu(app, '#find-replace-btn');
    await app.locator('[data-scope="vault"]').click();
    await app.locator('#find-input').fill('Current');
    await app.locator('#replace-input').fill('Changed');
    await app.locator('[data-find-preview]').click();
    await expect(app.locator('[data-find-apply]')).toBeEnabled();
    await app.evaluate(() => {
      window.confirmations = 0;
      window.app.findReplace.confirmVaultApply = () => {
        window.confirmations++;
        return true;
      };
    });
    expect(await writer.evaluate(() => window.save('Current remote content'))).toBe(true);
    await app.locator('[data-find-apply]').click();
    await expect(app.locator('.find-replace__status')).toContainText('Refresh the preview');
    await expect(app.locator('[data-find-apply]')).toBeDisabled();
    await checkReviewAccessibility(app, '#find-replace-panel');
    await app.getByRole('button', { name: 'Refresh preview', exact: true }).click();
    await expect(app.locator('[data-find-apply]')).toBeEnabled();
    expect((await saved(writer)).content).toBe('Current remote content');
    expect(await app.evaluate(() => window.confirmations)).toBe(1);
    await app.locator('[data-find-apply]').click();
    await expect(app.locator('.find-replace__status')).toContainText('1 changed');
    expect((await saved(writer)).content).toBe('Changed remote content');
    expect(await app.evaluate(() => window.confirmations)).toBe(2);
  } finally {
    await context.close();
  }
});

test('changing find intent during confirmation cancels the earlier apply request', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await menu(app, '#find-replace-btn');
    await app.locator('[data-scope="vault"]').click();
    await app.locator('#find-input').fill('Current');
    await app.locator('#replace-input').fill('Changed');
    await app.locator('[data-find-preview]').click();
    await expect(app.locator('[data-find-apply]')).toBeEnabled();
    await app.evaluate(() => {
      window.app.findReplace.confirmVaultApply = () =>
        new Promise((resolve) => {
          window.approveFind = resolve;
        });
    });
    // A delayed blur/change notification with identical values must not cancel
    // the reviewed plan. A genuinely changed value below still invalidates it.
    await app.locator('#replace-input').dispatchEvent('change');
    await expect(app.locator('[data-find-apply]')).toBeEnabled();
    await app.locator('[data-find-apply]').click();
    await app.waitForFunction(() => window.approveFind);
    await app.locator('#replace-input').fill('New intent');
    await app.evaluate(() => window.approveFind(true));
    await expect(app.locator('[data-find-apply]')).toBeDisabled();
    expect((await saved(writer)).content).toBe('Current content');
  } finally {
    await context.close();
  }
});

test('bulk stale action preserves its payload and requires a reviewed retry', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await app.locator('.note-item[data-id="a"] [data-select]').click();
    await app.locator('[data-bulk-tag]').fill('retained-tag');
    expect(await writer.evaluate(() => window.save('Remote body for bulk'))).toBe(true);
    await app.locator('[data-bulk-action="tag"]').click();
    await expect(app.locator('.bulk-actions__status')).toContainText('Refresh the action preview');
    await expect(app.locator('[data-bulk-tag]')).toHaveValue('retained-tag');
    await app.locator('[data-bulk-refresh]').click();
    await expect(app.locator('[data-bulk-retry]')).toBeEnabled();
    await checkReviewAccessibility(app, '.bulk-actions');
    expect((await saved(writer)).tags).not.toContain('retained-tag');
    await app.locator('[data-bulk-retry]').click();
    await expect.poll(async () => (await saved(writer)).tags).toContain('retained-tag');
    expect((await saved(writer)).content).toBe('Remote body for bulk');
  } finally {
    await context.close();
  }
});

test('portable backup restore refreshes its destination and requires renewed confirmation', async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const { app, writer } = await openWork(context);
    const text = await app.evaluate(async () => (await window.app.recovery.createBackup()).text);
    await menu(app, '#backup-btn');
    await app
      .locator('#backup-file')
      .setInputFiles({ name: 'reviewed.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await app.locator('#backup-verify').click();
    await expect(app.locator('#backup-preview-restore')).toBeEnabled();
    await app.locator('#backup-preview-restore').click();
    await expect(app.locator('#backup-restore')).toBeEnabled();
    await app.evaluate(() => {
      window.confirmations = 0;
      window.app.backup.confirmRestore = () => {
        window.confirmations++;
        return true;
      };
    });
    expect(await writer.evaluate(() => window.save('Remote backup destination'))).toBe(true);
    await app.locator('#backup-restore').click();
    await expect(app.locator('#backup-status')).toContainText('Refresh the restore preview');
    await expect(app.locator('#backup-restore')).toBeDisabled();
    await checkReviewAccessibility(app, '#backup-overlay');
    expect((await saved(writer)).content).toBe('Remote backup destination');
    await app.locator('#backup-preview-restore').click();
    await expect(app.locator('#backup-restore')).toBeEnabled();
    expect((await saved(writer)).content).toBe('Remote backup destination');
    await app.locator('#backup-restore').click();
    await expect(app.locator('#backup-status')).toContainText('Restore completed successfully');
    expect((await saved(writer)).content).toBe('Current content');
    expect(await app.evaluate(() => window.confirmations)).toBe(2);
  } finally {
    await context.close();
  }
});

test('folder reconciliation refreshes source and destination and resets reviewed decisions', async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const { app, writer } = await openWork(context);
    await menu(app, '#reconcile-btn');
    await app.locator('#reconciliation-overlay [data-files]').setInputFiles({
      name: 'Existing.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nnoteforge_id: a\n---\nFolder content'),
    });
    await expect(app.locator('#reconciliation-overlay [data-decision]').first()).toBeVisible();
    await app.locator('#reconciliation-overlay select[data-decision]').selectOption('apply');
    await app.evaluate(() => {
      window.app.phase6.reconciliation.confirmApply = () => true;
    });
    expect(await writer.evaluate(() => window.save('Remote folder destination'))).toBe(true);
    await app.locator('#reconciliation-overlay [data-apply]').click();
    await expect(app.locator('#reconciliation-overlay [role="status"]')).toContainText('Refresh the preview');
    await expect(app.locator('#reconciliation-overlay [data-apply]')).toBeDisabled();
    await app.locator('#reconciliation-overlay [data-refresh]').click();
    await expect(app.locator('#reconciliation-overlay select[data-decision]')).toHaveValue('');
    await expect(app.locator('#reconciliation-overlay [data-apply]')).toBeDisabled();
    expect((await saved(writer)).content).toBe('Remote folder destination');
    await app.locator('#reconciliation-overlay select[data-decision]').selectOption('apply');
    await app.locator('#reconciliation-overlay [data-apply]').click();
    await expect(app.locator('#reconciliation-overlay [role="status"]')).toContainText('completed');
    expect((await saved(writer)).content).toContain('Folder content');
  } finally {
    await context.close();
  }
});

test('Properties retains a raw draft while refreshing separately displayed saved YAML', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await app.locator('.editor__properties').click();
    await expect(app.locator('.properties-raw-form button')).toBeEnabled();
    const draft = '---\nvalue: proposed\n---';
    await app.locator('.properties-raw-form textarea').fill(draft);
    expect(await writer.evaluate(() => window.save('---\nvalue: acknowledged\n---\nRemote body'))).toBe(true);
    await app.locator('.properties-raw-form button').click();
    await expect(app.locator('#properties-status')).toContainText('Refresh saved properties');
    await expect(app.locator('.properties-raw-form button')).toBeDisabled();
    await checkReviewAccessibility(app, '#properties-overlay');
    await app.locator('[data-properties-refresh]').click();
    await expect(app.locator('.properties-raw-form button')).toBeEnabled();
    await expect(app.locator('.properties-raw-form textarea')).toHaveValue(draft);
    await expect(app.locator('[data-properties-current] pre')).toHaveText('---\nvalue: acknowledged\n---');
    expect((await saved(writer)).content).toContain('value: acknowledged');
    await app.locator('.properties-raw-form button').click();
    await expect(app.locator('#properties-status')).toContainText('Raw YAML source saved');
    expect((await saved(writer)).content).toBe(`${draft}\nRemote body`);
  } finally {
    await context.close();
  }
});

test('a new reconciliation source disables the previous plan before file reading completes', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await menu(app, '#reconcile-btn');
    const source = app.locator('#reconciliation-overlay [data-files]');
    await source.setInputFiles({
      name: 'Existing.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nnoteforge_id: a\n---\nFirst folder content'),
    });
    await app.locator('#reconciliation-overlay select[data-decision]').selectOption('apply');
    await expect(app.locator('#reconciliation-overlay [data-apply]')).toBeEnabled();
    await app.evaluate(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        return new Promise((resolve) => {
          window.finishSourceRead = async () => resolve(await read.call(this));
        });
      };
    });
    await source.setInputFiles({
      name: 'Replacement.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nnoteforge_id: a\n---\nSecond folder content'),
    });
    await app.waitForFunction(() => window.finishSourceRead);
    await expect(app.locator('#reconciliation-overlay [data-apply]')).toBeDisabled();
    expect((await saved(writer)).content).toBe('Current content');
    await checkReviewAccessibility(app, '#reconciliation-overlay');
    await app.evaluate(() => window.finishSourceRead());
    await expect(app.locator('.reconciliation-items')).toContainText('Replacement.md');
    await expect(app.locator('#reconciliation-overlay select[data-decision]')).toHaveValue('');
    await expect(app.locator('#reconciliation-overlay [data-apply]')).toBeDisabled();
    expect((await saved(writer)).content).toBe('Current content');
  } finally {
    await context.close();
  }
});

test('a dismissed rename refresh cannot replace or focus a newly opened preview', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { app, writer } = await openWork(context);
    await app.evaluate(() => window.app.editor.actions.requestRename('a', 'First intent'));
    expect(await writer.evaluate(() => window.save('Remote content'))).toBe(true);
    await app.locator('#link-tools-apply').click();
    await expect(app.locator('#link-tools-refresh')).toBeVisible();
    await app.evaluate(() => {
      window.app.linkTools.refreshPreview = () =>
        new Promise((resolve) => {
          window.finishPreview = resolve;
        });
    });
    await app.locator('#link-tools-refresh').click();
    await app.waitForFunction(() => window.finishPreview);
    await app.locator('#link-tools-overlay [data-close]').last().click();
    await app.evaluate(() => window.app.linkTools.showRename('a', 'Second intent'));
    await app.evaluate(() => window.finishPreview());
    await expect(app.locator('#link-rename-input')).toHaveValue('Second intent');
    await expect(app.locator('#link-tools-apply')).toBeEnabled();
    expect((await saved(writer)).title).toBe('History destination');
  } finally {
    await context.close();
  }
});
