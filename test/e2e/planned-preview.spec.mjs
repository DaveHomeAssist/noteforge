import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { verifyBackup } from '../../src/core/backup.js';
import { Note } from '../../src/core/note.js';
import { parseFrontmatter, splitFrontmatterSource } from '../../src/utils/frontmatter.js';
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
      // Include archived source for the Unarchive concurrency fixture.
      const current = window.db.notes.get('a');
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

for (const action of ['set', 'remove']) {
  for (const boundary of ['before apply', 'during safety capture']) {
    test(`Properties ${action} rejects a remote edit ${boundary} and preserves reviewed intent`, async ({
      browser,
    }) => {
      const context = await browser.newContext();
      try {
        const { app, writer } = await openWork(context);
        const original = '---\n# Keep comment\npriority: 1\nunknown: [one, two]\n---\nOriginal body';
        expect(await writer.evaluate((source) => window.save(source), original)).toBe(true);
        await app.locator('.editor__properties').click();
        const save = app.locator('.properties-form button[type="submit"]');
        const remove = app.locator('[data-property-delete="priority"]');
        await expect(remove).toBeEnabled();
        if (action === 'set') {
          await app.locator('[data-property-edit="priority"]').click();
          await app.locator('.properties-form [name="value"]').fill('2');
        }
        if (boundary === 'during safety capture') {
          await app.evaluate(() => {
            const db = window.app.db;
            const capture = db.captureRevisionBoundary.bind(db);
            db.captureRevisionBoundary = async (...args) => {
              const result = await capture(...args);
              db.captureRevisionBoundary = capture;
              await new Promise((resolve) => {
                window.releasePropertyCapture = resolve;
              });
              return result;
            };
          });
          await (action === 'set' ? save : remove).click();
          await app.waitForFunction(() => window.releasePropertyCapture);
        }
        const remote = original.replace('priority: 1', 'priority: 3').replace('Original body', 'Acknowledged body');
        expect(await writer.evaluate((source) => window.save(source), remote)).toBe(true);
        if (boundary === 'before apply') await (action === 'set' ? save : remove).click();
        else await app.evaluate(() => window.releasePropertyCapture());
        await expect(app.locator('#properties-status')).toContainText('Refresh saved properties');
        await expect(save).toBeDisabled();
        await expect(remove).toBeDisabled();
        expect((await saved(writer)).content).toBe(remote);
        await app.locator('[data-properties-refresh]').click();
        await expect(remove).toBeEnabled();
        await expect(app.locator('.properties-row').filter({ has: remove }).locator('code')).toHaveText('3');
        if (action === 'set') {
          await expect(app.locator('.properties-form [name="key"]')).toHaveValue('priority');
          await expect(app.locator('.properties-form [name="type"]')).toHaveValue('number');
          await expect(app.locator('.properties-form [name="value"]')).toHaveValue('2');
        }
        expect((await saved(writer)).content).toBe(remote);
        await (action === 'set' ? save : remove).click();
        await expect(app.locator('#properties-status')).toContainText(
          action === 'set' ? 'Property saved' : 'Property removed',
        );
        const actual = (await saved(writer)).content;
        // Typed YAML edits may normalize flow spacing; the documented byte
        // invariant applies to the Markdown body and unmodified source.
        expect((await parseFrontmatter(actual)).properties.get('unknown')).toEqual(['one', 'two']);
        expect(splitFrontmatterSource(actual).body).toBe('Acknowledged body');
        if (action === 'set') expect(actual).toContain('priority: 2');
        else expect(actual).not.toContain('priority:');
        const safety = await app.evaluate(async () => {
          const store = window.app.revisionStore;
          const revisions = await store.listRevisions('a');
          return Promise.all(
            revisions.filter((entry) => entry.reason === 'pre_property_edit').map((entry) => store.materialize(entry)),
          );
        });
        expect(safety.map((entry) => entry.content)).toContain(remote);
        await app.reload();
        await app.evaluate(async () => {
          await window.app.ready;
          await window.app.openNote('a');
        });
        expect(await app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe(actual);
      } finally {
        await context.close();
      }
    });
  }
}

for (const boundary of ['before apply', 'during safety backup']) {
  test(`local snapshot rejects a remote edit ${boundary} and requires a new confirmed preview`, async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const { app, writer } = await openWork(context);
      const snapshot = await app.evaluate(async () => (await window.app.recovery.createLocalSnapshot()).snapshot.id);
      await menu(app, '#backup-btn');
      await app.locator(`[data-snapshot-id="${snapshot}"]`).click();
      await expect(app.locator('#backup-restore')).toBeEnabled();
      const generation = await app.evaluate(() => window.app.db._vaultMeta.generation);
      await app.evaluate((boundary) => {
        window.confirmations = 0;
        window.app.backup.confirmRestore = () => {
          window.confirmations++;
          return true;
        };
        if (boundary === 'during safety backup') {
          const recovery = window.app.recovery;
          const backup = recovery.createBackup.bind(recovery);
          recovery.createBackup = async () => {
            const result = await backup();
            recovery.createBackup = backup;
            await new Promise((resolve) => {
              window.releaseSnapshotSafety = resolve;
            });
            return result;
          };
        }
      }, boundary);
      if (boundary === 'during safety backup') {
        await app.locator('#backup-restore').click();
        await app.waitForFunction(() => window.releaseSnapshotSafety);
      }
      expect(await writer.evaluate(() => window.save('Snapshot destination acknowledged elsewhere'))).toBe(true);
      if (boundary === 'before apply') await app.locator('#backup-restore').click();
      else await app.evaluate(() => window.releaseSnapshotSafety());
      await expect(app.locator('#backup-status')).toContainText('Refresh the restore preview');
      await expect(app.locator('#backup-restore')).toBeDisabled();
      expect((await saved(writer)).content).toBe('Snapshot destination acknowledged elsewhere');
      await app.locator('#backup-preview-restore').click();
      await expect(app.locator('#backup-restore')).toBeEnabled();
      expect((await saved(writer)).content).toBe('Snapshot destination acknowledged elsewhere');
      const download = app.waitForEvent('download');
      await app.locator('#backup-restore').click();
      await expect(app.locator('#backup-status')).toContainText('Restore completed successfully');
      const backup = await verifyBackup(await readFile(await (await download).path(), 'utf8'));
      expect(backup.notes.find((note) => note.id === 'a').content).toBe('Snapshot destination acknowledged elsewhere');
      expect((await saved(writer)).content).toBe('Current content');
      expect(await app.evaluate(() => window.confirmations)).toBe(2);
      expect(await app.evaluate(() => window.app.db._vaultMeta.generation)).not.toBe(generation);
      await app.reload();
      await app.evaluate(async () => {
        await window.app.ready;
        await window.app.openNote('a');
      });
      expect(await app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Current content');
    } finally {
      await context.close();
    }
  });
}

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

async function holdCallerSafety(app) {
  await app.evaluate(() => {
    const db = window.app.db;
    const capture = db.captureRevisionBoundary.bind(db);
    db.captureRevisionBoundary = async (...args) => {
      const result = await capture(...args);
      db.captureRevisionBoundary = capture;
      await new Promise((resolve) => {
        window.releaseCallerSafety = resolve;
      });
      return result;
    };
  });
}

async function capturedSources(app, reason) {
  return app.evaluate(async (reason) => {
    const store = window.app.revisionStore;
    const revisions = await store.listRevisions('a');
    return Promise.all(
      revisions
        .filter((entry) => entry.reason === reason)
        .map(async (entry) => (await store.materialize(entry)).content),
    );
  }, reason);
}

for (const action of ['archive', 'unarchive', 'reparent', 'trash']) {
  test(`bulk ${action} rejects a change during safety capture and retries only reviewed source`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const { app, writer } = await openWork(context);
      await app.evaluate(async (action) => {
        const db = window.app.db;
        db.createNote({ id: 'parent', title: 'Parent', content: 'Unchanged parent' });
        if (action === 'unarchive') db.archiveNote('a');
        await db.flush();
        window.app.noteList.applySearchState({ query: action === 'unarchive' ? 'is:archived' : '' });
      }, action);
      await writer.evaluate(() => window.db.refreshCurrentVault());
      await app.locator('.note-item[data-id="a"] [data-select]').click();
      const apply = app.locator(`[data-bulk-action="${action}"]`);
      await expect(apply).toBeEnabled();
      if (action === 'reparent') await app.locator('[data-bulk-parent]').selectOption('parent');
      await app.evaluate(() => {
        window.confirmations = 0;
        window.app.bulkActions.confirmAction = () => {
          window.confirmations++;
          return true;
        };
      });
      await holdCallerSafety(app);
      await apply.click();
      await app.waitForFunction(() => window.releaseCallerSafety);
      const remote = `Acknowledged during bulk ${action}`;
      expect(await writer.evaluate((source) => window.save(source), remote)).toBe(true);
      await app.evaluate(() => window.releaseCallerSafety());
      await expect(app.locator('.bulk-actions__status')).toContainText('Refresh the action preview');
      await expect(apply).toBeDisabled();
      expect((await saved(writer)).content).toBe(remote);
      await app.locator('[data-bulk-refresh]').click();
      await expect(app.locator('[data-bulk-retry]')).toBeEnabled();
      expect((await saved(writer)).content).toBe(remote);
      await app.locator('[data-bulk-retry]').click();
      await expect
        .poll(async () => {
          const note = await saved(writer);
          return action === 'archive'
            ? Boolean(note.archivedAt)
            : action === 'unarchive'
              ? note.archivedAt === null
              : action === 'trash'
                ? Boolean(note.deletedAt)
                : note.parentId === 'parent';
        })
        .toBe(true);
      expect((await saved(writer)).content).toBe(remote);
      expect(await capturedSources(app, 'pre_bulk_action')).toContain(remote);
      expect(await app.evaluate(() => window.confirmations)).toBe(action === 'trash' ? 2 : 0);
      expect(
        await writer.evaluate(
          async () =>
            (await window.db.storage.readCurrentVault()).records.find(([id]) => id === 'parent')[1].value.content,
        ),
      ).toBe('Unchanged parent');
    } finally {
      await context.close();
    }
  });
}

for (const action of ['alias', 'mention']) {
  test(`link ${action} rejects a change during safety capture and retains current source`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { app, writer } = await openWork(context);
      await app.evaluate(async (action) => {
        const app = window.app;
        await app.phase5.ready;
        const note = app.db.getNote('a');
        if (action === 'alias')
          note.update({ aliases: ['Legacy'], content: '---\naliases: [Legacy]\nkeep: true\n---\nOriginal body' });
        else {
          app.db.createNote({ id: 'target', title: 'Target', content: 'Untouched target' });
          note.update({ content: 'Read Target before continuing.' });
        }
        await app.db.saveNoteWithReceipt(note).completion;
        await app.phase5.reconcileAliases({ changedOnly: true, noteIds: ['a'] });
        await app.db.flush();
        await app.db.initializeKnowledgeIndex();
      }, action);
      await writer.evaluate(() => window.db.refreshCurrentVault());
      await menu(app, '#link-report-btn');
      await expect(app.locator('#link-tools-overlay')).toBeVisible();
      await app.evaluate((action) => {
        const app = window.app;
        if (action === 'alias') app.linkTools.showAliasRemoval('a', 'Legacy');
        else app.linkTools.showMention(app.db.unlinkedMentionsFor('target')[0]);
      }, action);
      await expect(app.locator('#link-tools-apply')).toBeEnabled();
      const remote = (await saved(writer)).content + '\nAcknowledged elsewhere';
      await holdCallerSafety(app);
      await app.locator('#link-tools-apply').click();
      await app.waitForFunction(() => window.releaseCallerSafety);
      expect(await writer.evaluate((source) => window.save(source), remote)).toBe(true);
      await app.evaluate(() => window.releaseCallerSafety());
      await expect(app.locator('#link-tools-status')).toContainText('Refresh the preview');
      await expect(app.locator('#link-tools-apply')).toBeDisabled();
      expect((await saved(writer)).content).toBe(remote);
      await app.locator('#link-tools-refresh').click();
      await expect(app.locator('#link-tools-apply')).toBeEnabled();
      expect((await saved(writer)).content).toBe(remote);
      await app.locator('#link-tools-apply').click();
      await expect(app.locator('#link-tools-status')).toContainText(
        action === 'alias' ? 'removed.' : 'Mention converted',
      );
      expect(await capturedSources(app, action === 'alias' ? 'pre_alias_repair' : 'pre_link_conversion')).toContain(
        remote,
      );
      if (action === 'alias') {
        await expect.poll(async () => (await saved(writer)).content.includes('aliases:')).toBe(false);
        expect((await saved(writer)).aliases).toEqual([]);
        expect((await parseFrontmatter((await saved(writer)).content)).properties.get('keep')).toBe(true);
      } else expect((await saved(writer)).content).toBe(remote.replace('Target', '[[Target]]'));
      expect((await saved(writer)).content).toContain('Acknowledged elsewhere');
    } finally {
      await context.close();
    }
  });
}

for (const failedStore of ['history', 'note']) {
  test(`Properties retains its typed draft after a native ${failedStore} transaction abort`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { app, writer } = await openWork(context);
      await app.locator('.editor__properties').click();
      const save = app.locator('.properties-form button[type="submit"]');
      await expect(save).toBeEnabled();
      await app.locator('.properties-form [name="key"]').fill('priority');
      await app.locator('.properties-form [name="type"]').selectOption('number');
      await app.locator('.properties-form [name="value"]').fill('2');
      await app.evaluate(async (failedStore) => {
        await window.app.db.flush();
        const put = IDBObjectStore.prototype.put;
        window.injectedAborts = 0;
        window.restoreCallerStorage = () => {
          IDBObjectStore.prototype.put = put;
        };
        IDBObjectStore.prototype.put = function (value, key) {
          const result = put.call(this, value, key);
          if (failedStore === 'note' ? key === 'note:a' : String(key).startsWith('revision:record:')) {
            window.injectedAborts++;
            this.transaction.abort();
          }
          return result;
        };
      }, failedStore);
      await save.click();
      await expect.poll(() => app.evaluate(() => window.injectedAborts)).toBeGreaterThan(0);
      await expect(save).toBeEnabled();
      await expect(app.locator('#properties-status')).not.toContainText('Property saved');
      expect((await saved(writer)).content).toBe('Current content');
      await expect(app.locator('.properties-form [name="value"]')).toHaveValue('2');
      await app.evaluate(() => window.restoreCallerStorage());
      await save.click();
      await expect(app.locator('#properties-status')).toContainText('Property saved');
      expect((await parseFrontmatter((await saved(writer)).content)).properties.get('priority')).toBe(2);
      expect(splitFrontmatterSource((await saved(writer)).content).body).toBe('Current content');
      expect(await capturedSources(app, 'pre_property_edit')).toContain('Current content');
    } finally {
      await context.close();
    }
  });
}

for (const [view, button, surface, suffix] of [
  ['tasks', '#tasks-btn', '#task-dashboard-list', 'task'],
  ['calendar', '#calendar-btn', '#calendar-overlay', 'task'],
  ['archive', '#archive-btn', '#archive-list', 'archived'],
  ['trash', '#trash-btn', '#trash-list', 'trashed'],
  ['graph', '#graph-btn', '#graph', 'source'],
]) {
  test(`full replacement refreshes the open ${view} view, property search and backlinks`, async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { app, writer } = await openWork(context);
      const vault = (label) =>
        [
          new Note({
            id: 'a',
            title: `${label} source`,
            content: `---\nstatus: ${label}\n---\n# ${label} heading\n\n[[${label} target]]\n\n- [ ] ${label} task @due(2026-10-04)`,
            future: { keep: label },
          }),
          new Note({ id: `${label}-target`, title: `${label} target`, content: `${label} target body` }),
          new Note({
            id: `${label}-archived`,
            title: `${label} archived`,
            content: `${label} archived body`,
            archivedAt: '2026-10-01T00:00:00.000Z',
          }),
          new Note({
            id: `${label}-trashed`,
            title: `${label} trashed`,
            content: `${label} trashed body`,
            deletedAt: '2026-10-01T00:00:00.000Z',
          }),
        ].map((note) => note.toJSON());
      const replace = async (notes) => {
        expect(
          await writer.evaluate(async (notes) => {
            await window.db.refreshCurrentVault();
            return window.db.replaceVault({ notes, config: window.db.config });
          }, notes),
        ).toBe(true);
        expect(
          await app.evaluate(async () => {
            await window.app.db.flush();
            return (await window.app.db.refreshCurrentVault()).status;
          }),
        ).toBe('refreshed');
      };
      await replace(vault('Before'));
      if (view === 'graph') await app.locator(button).click();
      else await menu(app, button);
      await expect(app.locator(surface)).toBeVisible();
      if (view === 'calendar') await app.evaluate(() => window.app.phase4.calendar.show({ date: '2026-10-04' }));
      await expect(app.locator(surface)).toContainText(`Before ${suffix}`);
      const after = vault('After');
      await replace(after);
      await expect(app.locator(surface)).toBeVisible();
      await expect(app.locator(surface)).toContainText(`After ${suffix}`);
      await expect(app.locator(surface)).not.toContainText(`Before ${suffix}`);
      expect(
        await writer.evaluate(async () =>
          (await window.db.storage.readCurrentVault()).records.map(([id]) => id).sort(),
        ),
      ).toEqual(after.map((note) => note.id).sort());
      await app.evaluate(() => window.app.openNote('After-target'));
      await expect(app.locator('.backlinks__list').first()).toContainText('After source');
      await expect(app.locator('.backlinks__list').first()).not.toContainText('Before source');
      await app.locator('#search-input').fill('prop:status=Before');
      await expect(app.locator('#note-list .note-item')).toHaveCount(0);
      await app.locator('#search-input').fill('prop:status=After');
      await expect(app.locator('#note-list .note-item')).toHaveCount(1);
      await expect(app.locator('#note-list .note-item')).toContainText('After source');
      const backup = await verifyBackup(
        await app.evaluate(async () => (await window.app.recovery.createBackup()).text),
      );
      expect(new Map(backup.notes.map((note) => [note.id, note]))).toEqual(
        new Map(after.map((note) => [note.id, note])),
      );
      await app.reload();
      await app.waitForFunction(() => window.app?.workspace);
      await app.evaluate(async () => {
        await window.app.ready;
        await window.app.openNote('a');
      });
      expect(await app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe(after[0].content);
    } finally {
      await context.close();
    }
  });
}
