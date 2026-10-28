import { TIMEOUT } from './support/runtime.mjs';
import { openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

async function reload(page) {
  await page.evaluate(() => window.app.db.flush());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.ready, undefined, {
    timeout: TIMEOUT,
  });
  await page.evaluate(() => window.app.ready);
}

for (const theme of ['light', 'dark']) {
  test(`component clarity keeps keyboard actions and selection explicit (${theme})`, async ({
    browser,
    runtimeErrors,
  }) => {
    const { context, page } = await openSurface(browser, {
      viewport: 1440,
      theme,
      runtimeErrors,
    });
    try {
      await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Search notes…');
      await page.locator('#search-input').focus();
      await expect(page.locator('#search-help')).toBeVisible();
      await expect(page.locator('.saved-searches header')).toBeHidden();
      await expect(page.locator('[data-saved-create]')).toBeVisible();
      await expect(page.locator('.note-item [data-select]').first()).toBeHidden();
      await page.getByRole('button', { name: 'Select notes', exact: true }).click();
      await page.locator('.note-item [data-select]').first().click();
      await expect(page.locator('.note-item [data-select]').first()).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('#select-notes')).toBeFocused();
      await expect(page.locator('.note-item [data-select]').first()).toBeHidden();
      expect(await page.evaluate(() => window.app.noteList.getSelection())).toEqual([]);
      for (const target of ['[data-bulk-tag]', '[data-bulk-action="archive"]', '#select-notes', '#search-input']) {
        await page.locator('#select-notes').click();
        await page.locator('.note-item [data-select]').first().click();
        await expect(page.locator('.bulk-actions')).toBeVisible();
        await page.locator(target).focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('#select-notes')).toBeFocused();
        await expect(page.locator('#select-notes')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('.bulk-actions')).toBeHidden();
        expect(await page.evaluate(() => window.app.noteList.getSelection())).toEqual([]);
      }
      await page.locator('#select-notes').focus();
      const confirmation = page.evaluate(() => window.app.confirm({ message: 'Disabled return target' }));
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.locator('#select-notes').evaluate((button) => (button.disabled = true));
      await page.keyboard.press('Escape');
      expect(await confirmation).toBe(false);
      await expect(page.locator('#menu-btn')).toBeFocused();
      await page.locator('#select-notes').evaluate((button) => (button.disabled = false));
      await page.locator('#select-notes').click();
      await page.locator('.note-item [data-select]').first().click();
      await page.locator('[data-bulk-action="trash"]').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#confirm-dialog')).toBeHidden();
      await expect(page.locator('.bulk-actions')).toBeVisible();
      expect(await page.evaluate(() => window.app.noteList.getSelection())).toHaveLength(1);
      await page.keyboard.press('Escape');
      await expect(page.locator('.bulk-actions')).toBeHidden();
      await page.locator('.tag-chip[data-tag="projects"]').click();
      await expect(page.locator('.tag-chip[data-tag="projects"]')).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Clear filter' }).click();
      await expect(page.locator('.tag-chip--on')).toHaveCount(0);
      const tabMenu = page.getByRole('button', {
        name: 'Tab actions',
        exact: true,
      });
      const tabs = await page.locator('.workspace-tabs:visible').first().boundingBox();
      const actions = await tabMenu.boundingBox();
      expect(Math.abs(tabs.y - actions.y)).toBeLessThan(12);
      await expect(page.locator('.workspace-tab__move')).toHaveCount(0);
      await tabMenu.focus();
      await page.keyboard.press('ArrowDown');
      await expect(
        page.getByRole('menuitem', {
          name: 'Move to other pane',
        }),
      ).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(tabMenu).toBeFocused();
      await tabMenu.click();
      await page
        .getByRole('menuitem', {
          name: 'Move to other pane',
        })
        .click();
      await expect(page.locator('#workspace')).toHaveAttribute('data-active-pane', 'secondary');
      const noteActions = page.locator('.editor:visible').getByRole('button', { name: 'Note actions' });
      await noteActions.click();
      await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Pin note' })).toBeVisible();
      await page.getByRole('menuitemcheckbox', { name: 'Pin note' }).click();
      await expect(noteActions).toBeFocused();
      await noteActions.click();
      await expect(page.getByRole('menuitemcheckbox', { name: 'Unpin note' })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(noteActions).toBeFocused();
      const toggle = page.locator('.editor:visible .editor__context-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const openColor = await toggle.evaluate((node) => getComputedStyle(node).backgroundColor);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => toggle.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(openColor);
      await reload(page);
      await expect(page.locator('.editor:visible .editor__context-toggle')).toHaveCount(1);
      await expect(page.locator('.editor:visible .editor__context-toggle')).toHaveAttribute('aria-expanded', 'false');
      expect(await page.evaluate(() => window.app.editor.editors.primary.currentId)).toBeNull();
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1440, height: 540 },
  { width: 3840, height: 900 },
]) {
  test(`compact hosted shell and menus fit ${viewport.width}x${viewport.height}`, async ({
    browser,
    runtimeErrors,
  }) => {
    const { context, page } = await openSurface(browser, {
      viewport: 1440,
      runtimeErrors,
    });
    try {
      await page.setViewportSize(viewport);
      // Reproduce the publisher's injected shell without editing its repository.
      await page.evaluate(() => {
        const nav = document.createElement('nav');
        nav.className = 'sbd-site-return';
        nav.setAttribute('aria-label', 'Breadcrumb');
        nav.textContent = 'System by Dave / Tools / NoteForge';
        document.body.prepend(nav);
        const style = document.createElement('style');
        style.textContent =
          '.sbd-site-return {height:44px} .sbd-site-return ~ .app {height:calc(100vh - 44px)} @media(max-width:760px){.sbd-site-return ~ .mobile-bar{top:44px}.sbd-site-return ~ .app{height:calc(100vh - 92px)}}';
        document.head.append(style);
      });
      expect((await page.locator('.sbd-site-return').boundingBox()).height).toBe(32);
      if (viewport.width === 375) {
        await page.locator('#sidebar-toggle').click();
        await page.locator('#select-notes').click();
        await page.locator('.note-item [data-select]').first().click();
        await page.locator('[data-bulk-tag]').focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('#select-notes')).toBeFocused();
        await expect(page.locator('.bulk-actions')).toBeHidden();
        await expect(page.locator('.app')).toHaveClass(/sidebar-open/);
        await page.keyboard.press('Escape');
        await expect(page.locator('.app')).not.toHaveClass(/sidebar-open/);
      }

      for (const button of [
        page.getByRole('button', { name: 'Tab actions', exact: true }),
        page.getByRole('button', { name: 'Note actions', exact: true }),
      ]) {
        await button.click();
        const menu = page.locator('.action-menu:popover-open');
        const box = await menu.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press('Escape');
      }
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
}
