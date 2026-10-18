import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { previewRoot } from './support/runtime.mjs';
import { openMenu } from './support/surfaces.mjs';
import { activatedAppContext } from './support/activated-vault.mjs';

const features = {
  properties: { module: 'properties-view', overlay: '#properties-overlay' },
  capture: { module: 'quick-capture-view', overlay: '#quick-capture-overlay' },
  palette: { module: 'command-palette', overlay: '#palette-overlay' },
  backup: { module: 'backup-view', overlay: '#backup-overlay' },
};
async function launch(browser, setup = async () => {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.goto(previewRoot(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.workspace);
  await page.evaluate(() => window.app.ready);
  await page.evaluate(() => Promise.all([window.app.phase5Ready, window.app.phase6Ready]));
  return { context, page, errors };
}
async function invoke(page, feature) {
  if (feature === 'properties') await page.locator('.editor__properties:visible').first().click();
  else if (feature === 'capture') await page.locator('#capture-btn:visible').first().click();
  else {
    await openMenu(page);
    await page.locator(feature === 'palette' ? '#palette-btn' : '#backup-btn').click();
  }
}
for (const [feature, { module, overlay }] of Object.entries(features)) {
  for (const cause of ['Escape', 'navigation', 'pane change', 'supersession', 'pagehide'])
    test(`${feature} delayed opening stays dismissed after ${cause}`, async ({ browser }) => {
      let release;
      const held = new Promise((resolve) => (release = resolve));
      let requested = false;
      const { context, page, errors } = await launch(browser, async (page) => {
        await page.route(new RegExp(`/assets/${module}-[^/]+\\.js$`), async (route) => {
          requested = true;
          await held;
          await route.continue();
        });
      });
      try {
        await invoke(page, feature);
        await expect.poll(() => requested).toBe(true);
        if (cause === 'Escape') await page.keyboard.press('Escape');
        if (cause === 'navigation')
          await page.evaluate(() => {
            const app = window.app;
            return app.openNote(app.db.getAllNotes().find((note) => note.id !== app.currentId).id);
          });
        if (cause === 'pane change')
          await page.evaluate(() => window.app.workspace.moveToOtherPane(window.app.currentId));
        if (cause === 'supersession') {
          await invoke(page, feature === 'palette' ? 'capture' : 'palette');
          await expect(
            page.locator(feature === 'palette' ? '#quick-capture-overlay' : '#palette-overlay'),
          ).toBeVisible();
        }
        if (cause === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await page.evaluate(() => {
          window.__featureFocus = document.activeElement;
        });
        release();
        await expect(page.locator(overlay)).toHaveCount(1);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(page.locator(overlay)).toBeHidden();
        expect(await page.evaluate(() => document.activeElement === window.__featureFocus)).toBe(true);
        expect(errors).toEqual([]);
        if (cause === 'supersession') await page.keyboard.press('Escape');
        await invoke(page, feature);
        await expect(page.locator(overlay)).toBeVisible();
        await expect(page.locator(overlay)).toHaveCount(1);
      } finally {
        release();
        await context.close();
      }
    });
}
test('failed Capture module evaluation is handled with bounded recovery', async ({ browser }) => {
  let requests = 0;
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, async (route) => {
      requests++;
      await route.fulfill({
        contentType: 'text/javascript',
        body: 'throw new Error("deliberate feature evaluation failure")',
      });
    });
  });
  try {
    await invoke(page, 'capture');
    await expect(page.locator('#feature-status')).toContainText('reload', { ignoreCase: true });
    expect(errors).toEqual([]);
    await expect(page.locator('#quick-capture-overlay')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Save and reload', exact: true })).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    await context.close();
  }
});
test('Properties keeps styled dialog geometry after a stylesheet failure', async ({ browser }) => {
  let failures = 0;
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/properties-view-[^/]+\.css$/, async (route) => {
      if (failures++ === 0) await route.abort('failed');
      else await route.continue();
    });
  });
  try {
    await invoke(page, 'properties');
    // Shell styles make the feature independent of this failed lazy CSS request.
    await expect(page.locator('#properties-overlay')).toBeVisible();
    const layout = await page.locator('.properties-modal__body').evaluate((node) => ({
      display: getComputedStyle(node).display,
      overflow: getComputedStyle(node).overflowY,
      padding: getComputedStyle(node).paddingTop,
    }));
    expect(layout).toEqual({ display: 'grid', overflow: 'auto', padding: '18px' });
    expect(failures).toBe(0); // The essential stylesheet is now in the shell.
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const failure of ['abort', 'stale deploy']) {
  test(`Capture ${failure} stays handled and retries are bounded`, async ({ browser }) => {
    let requests = 0;
    const { context, page, errors } = await launch(browser, async (page) => {
      await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, async (route) => {
        requests++;
        if (failure === 'abort') await route.abort('failed');
        else await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Gone' });
      });
    });
    try {
      await invoke(page, 'capture');
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.locator('.feature-status')).toHaveAttribute('data-state', 'reload-required');
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      await expect(page.locator('#quick-capture-overlay')).toBeHidden();
      expect(requests).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('repeated Backup openings share one mount and Escape closes the resulting dialog', async ({ browser }) => {
  let release;
  let requests = 0;
  const held = new Promise((resolve) => (release = resolve));
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/backup-view-[^/]+\.js$/, async (route) => {
      requests++;
      await held;
      await route.continue();
    });
  });
  try {
    await invoke(page, 'backup');
    await invoke(page, 'backup');
    await invoke(page, 'backup');
    release();
    await expect(page.locator('#backup-overlay')).toBeVisible();
    await expect(page.locator('#backup-overlay')).toHaveCount(1);
    expect(requests).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#backup-overlay')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.close();
  }
});

test('recovery blocks reload on unsaved writes and exports the mounted draft', async ({ browser }) => {
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'throw new Error("deliberate evaluation failure")',
      }),
    );
  });
  try {
    await page.evaluate(() => window.app.workspace.activeEditor.setAutosaveInterval(60_000));
    await page.locator('.editor:visible .blk[contenteditable="true"]').first().fill('Preserve this draft');
    await expect
      .poll(() => page.evaluate(() => window.app.workspace.activeEditor.getSourceMarkdown()))
      .toContain('Preserve this draft');
    await invoke(page, 'capture');
    await expect(page.getByRole('button', { name: 'Save and reload', exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__sameDocument = true;
      window.app.db.flushCurrentWrites = async () => false;
    });
    await page.getByRole('button', { name: 'Save and reload', exact: true }).click();
    await expect(page.locator('#feature-status')).toContainText('Some drafts are not saved');
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export drafts', exact: true }).click();
    const file = await download;
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString());
    expect(exported.drafts.some((draft) => draft.content.includes('Preserve this draft'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('save and reload preserves the edited note and resets invocation state', async ({ browser }) => {
  let requests = 0;
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, async (route) => {
      if (++requests === 1) await route.abort('failed');
      else await route.continue();
    });
  });
  try {
    await page.evaluate(() => window.app.workspace.activeEditor.setAutosaveInterval(60_000));
    await page.locator('.editor:visible .blk[contenteditable="true"]').first().fill('Saved before feature reload');
    await invoke(page, 'capture');
    await expect(page.getByRole('button', { name: 'Save and reload', exact: true })).toBeVisible();
    // The injected outage has ended before the user requests a safe reload.
    await page.unroute(/\/assets\/quick-capture-view-[^/]+\.js$/);
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: 'Save and reload', exact: true }).click(),
    ]);
    await page.waitForFunction(() => window.app?.workspace);
    await page.evaluate(() => window.app.ready);
    expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toContain('Saved before feature reload');
    expect(await page.evaluate(() => window.app.features.loader.entries.size)).toBe(0);
    await expect(page.locator('.feature-status')).toBeHidden();
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('cached production shell supports first use of every affected feature offline', async ({ browser }) => {
  const context = await activatedAppContext(browser, previewRoot(), { serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(previewRoot(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.app?.workspace && navigator.serviceWorker.controller);
    await context.setOffline(true);
    for (const [feature, { overlay }] of Object.entries(features)) {
      await invoke(page, feature);
      await expect(page.locator(overlay)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator(overlay)).toBeHidden();
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('cancelled Capture keeps its explicit destination and payload for the next opening', async ({ browser }) => {
  const { context, page, errors } = await launch(browser);
  try {
    await invoke(page, 'capture');
    await expect(page.locator('#quick-capture-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    const target = await page.evaluate(() => {
      const app = window.app;
      const destinationId = app.db.getAllNotes().find((note) => note.id !== app.currentId).id;
      const original = app.db.flushCurrentWrites.bind(app.db);
      window.__releaseCapture = null;
      app.db.flushCurrentWrites = () =>
        new Promise((resolve) => {
          window.__releaseCapture = () => resolve(true);
        });
      window.__captureRequest = app.phase4.showQuickCapture({
        destinationId,
        payload: { title: 'Explicit capture', text: 'Keep this incoming text', url: 'https://example.com/source' },
      });
      window.__restoreCapture = () => {
        app.db.flushCurrentWrites = original;
      };
      return destinationId;
    });
    await page.waitForFunction(() => Boolean(window.__releaseCapture));
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      window.__restoreCapture();
      window.__releaseCapture();
      await window.__captureRequest;
    });
    await expect(page.locator('#quick-capture-overlay')).toBeHidden();
    await invoke(page, 'capture');
    await expect(page.locator('#quick-capture-overlay')).toBeVisible();
    expect(
      await page.evaluate(() => ({
        title: window.app.phase4.quickCapture.els.title.value,
        text: window.app.phase4.quickCapture.els.text.value,
        destination: window.app.phase4.quickCapture.els.destination.value,
      })),
    ).toEqual({ title: 'Explicit capture', text: 'Keep this incoming text', destination: `existing:${target}` });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const theme of ['light', 'dark']) {
  test(`feature recovery is accessible and bounded in ${theme} mode`, async ({ browser }, testInfo) => {
    for (const width of [375, 1440]) {
      const { context, page, errors } = await launch(browser, async (page) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 540 });
        await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, (route) =>
          route.fulfill({
            contentType: 'text/javascript',
            body: 'throw new Error("evaluation failure for recovery scan")',
          }),
        );
      });
      try {
        await page.evaluate((theme) => window.app.theme.setMode(theme), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await invoke(page, 'capture');
        await expect(page.locator('.feature-status')).toHaveAttribute('data-state', 'reload-required');
        const results = await new AxeBuilder({ page })
          .include('.feature-status')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations).toEqual([]);
        const bounds = await page.locator('.feature-status').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(
          await page.evaluate(() => {
            const root = document.documentElement;
            return root.scrollHeight <= root.clientHeight && root.scrollWidth <= root.clientWidth;
          }),
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`recovery-${theme}-${width}.png`) });
        await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(page.locator('.feature-status')).toBeHidden();
        await expect(page.locator('#capture-btn')).toBeFocused();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
}

test('pending Properties cannot open after its editor owner is destroyed', async ({ browser }) => {
  let release;
  let requested = false;
  const held = new Promise((resolve) => (release = resolve));
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/properties-view-[^/]+\.js$/, async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
  });
  try {
    await invoke(page, 'properties');
    await expect.poll(() => requested).toBe(true);
    await page.evaluate(() => window.app.workspace.activeEditor.destroy());
    release();
    await expect(page.locator('#properties-overlay')).toHaveCount(1);
    await expect(page.locator('#properties-overlay')).toBeHidden();
    await expect(page.locator('.feature-status')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.close();
  }
});

test('Daily note loading can be cancelled before creating a note and keeps its return value', async ({ browser }) => {
  let release;
  let requested = false;
  const held = new Promise((resolve) => (release = resolve));
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/daily-workflow-[^/]+\.js$/, async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
  });
  try {
    await page.evaluate(() => {
      window.__dailyRequest = window.app.openDailyNote('2041-02-03');
    });
    await expect.poll(() => requested).toBe(true);
    await page.keyboard.press('Escape');
    release();
    expect(await page.evaluate(() => window.__dailyRequest)).toBe(false);
    expect(await page.evaluate(() => window.app.db.getAllNotes().some((note) => note.title === '2041-02-03'))).toBe(
      false,
    );
    const result = await page.evaluate(() => window.app.openDailyNote('2041-02-03'));
    expect(result.title).toBe('2041-02-03');
    await expect(page.locator('.editor__title:visible')).toHaveValue('2041-02-03');
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.close();
  }
});

test('Daily note restore works after the current note is trashed', async ({ browser }) => {
  const { context, page, errors } = await launch(browser);
  try {
    const note = await page.evaluate(() => window.app.openDailyNote('2041-02-04'));
    await page.evaluate(async (id) => {
      window.app.db.deleteNote(id);
      await window.app.db.flushCurrentWrites();
    }, note.id);
    for (const choice of ['Cancel', 'Restore and open']) {
      await page.evaluate(() => {
        window.__dailyRestore = window.app.openDailyNote('2041-02-04');
      });
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#confirm-dialog').getByRole('button', { name: choice, exact: true }).click();
      await page.evaluate(() => window.__dailyRestore);
      expect(await page.evaluate((id) => Boolean(window.app.db.notes.get(id)?.isTrashed), note.id)).toBe(
        choice === 'Cancel',
      );
    }
    await expect(page.locator('.editor__title:visible')).toHaveValue('2041-02-04');
    await expect(page.locator('#app-status')).toContainText('Restored and opened');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('an adjacent failed lazy stylesheet requires reload instead of opening an unstyled dialog', async ({
  browser,
}) => {
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/settings-view-[^/]+\.css$/, (route) => route.abort('failed'));
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await openMenu(page);
      await page.locator('#settings-btn').click();
      await expect(page.locator('.feature-status')).toHaveAttribute('data-state', 'reload-required');
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      await expect(page.locator('#settings-overlay')).toBeHidden();
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Daily restore confirmation cannot appear after Escape during its lazy load', async ({ browser }) => {
  let release;
  let requested = false;
  const held = new Promise((resolve) => (release = resolve));
  const { context, page, errors } = await launch(browser, async (page) => {
    await page.route(/\/assets\/dialogs-[^/]+\.js$/, async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
  });
  try {
    await page.evaluate(async () => {
      const note = window.app.db.createNote({ title: '2041-03-04', content: 'Archived Daily note' });
      await window.app.db.flushCurrentWrites();
      window.app.db.archiveNote(note.id);
      await window.app.db.flushCurrentWrites();
      window.__dailyRestore = window.app.openDailyNote('2041-03-04');
    });
    await expect.poll(() => requested).toBe(true);
    await page.keyboard.press('Escape');
    release();
    await page.evaluate(() => window.__dailyRestore);
    await expect(page.locator('#confirm-dialog')).toBeHidden();
    expect(
      await page.evaluate(
        () => [...window.app.db.notes.values()].find((note) => note.title === '2041-03-04').archivedAt,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.close();
  }
});

test('a pending Capture survives same-owner workspace initialization', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseWorkspace, releaseCapture;
  const workspace = new Promise((resolve) => (releaseWorkspace = resolve));
  const capture = new Promise((resolve) => (releaseCapture = resolve));
  let requested = false;
  await page.route(/\/assets\/phase6-[^/]+\.js$/, async (route) => {
    await workspace;
    await route.continue();
  });
  await page.route(/\/assets\/quick-capture-view-[^/]+\.js$/, async (route) => {
    requested = true;
    await capture;
    await route.continue();
  });
  try {
    await page.goto(previewRoot(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.app?.ready);
    await page.evaluate(() => window.app.ready);
    expect(await page.evaluate(() => Boolean(window.app.workspace))).toBe(false);
    await invoke(page, 'capture');
    await expect.poll(() => requested).toBe(true);
    releaseWorkspace();
    await page.waitForFunction(() => window.app.workspace);
    await page.evaluate(() => window.app.phase6Ready);
    releaseCapture();
    await expect(page.locator('#quick-capture-overlay')).toBeVisible();
    await expect(page.locator('#quick-capture-overlay')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    releaseWorkspace();
    releaseCapture();
    await context.close();
  }
});
