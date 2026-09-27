// The Phase 1 app shell: icon rail, collapsible and resizable sidebar, and the
// phone layout (bottom rail, nothing off-screen), against the production build.
import { TIMEOUT } from './support/runtime.mjs';
import { openMenu, openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

// Settings are written to IndexedDB as soon as they change, but a reload in the
// same few milliseconds can beat the commit. Wait for it, as a person would.
async function reload(page) {
  await page.evaluate(() => window.app.db.flush());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
  await page.evaluate(() => window.app.ready);
}

test('desktop rail opens its tools and the sidebar collapses and resizes, persisted', async ({
  browser,
  runtimeErrors,
}) => {
  const { context, page } = await openSurface(browser, { viewport: 1440, runtimeErrors });
  try {
    const rail = page.getByRole('navigation', { name: 'Workspace' });
    for (const name of [
      'Notes sidebar',
      'Search notes',
      'Open Quick Capture',
      'Open tasks',
      'Open calendar',
      'Toggle graph view',
      'Open settings',
    ]) {
      await expect(rail.getByRole('button', { name }), name).toBeVisible();
    }
    await rail.getByRole('button', { name: 'Open tasks' }).click();
    await expect(page.locator('#task-dashboard-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await rail.getByRole('button', { name: 'Open calendar' }).click();
    await expect(page.locator('#calendar-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await rail.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.keyboard.press('Escape');

    const graph = rail.getByRole('button', { name: 'Toggle graph view' });
    await graph.click();
    await expect(graph).toHaveAttribute('aria-pressed', 'true');
    await graph.click();
    await expect(graph).toHaveAttribute('aria-pressed', 'false');

    const toggle = rail.getByRole('button', { name: 'Notes sidebar' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar')).toBeHidden();
    await reload(page);
    await expect(page.locator('#sidebar'), 'collapse persists across reload').toBeHidden();
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notes sidebar' })).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Search notes' }).click();
    await expect(page.locator('#sidebar'), 'search expands a collapsed sidebar').toBeVisible();
    await expect(page.locator('#search-input')).toBeFocused();

    const handle = page.getByRole('separator', { name: 'Resize notes sidebar' });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '336');
    await expect(handle, 'resizing keeps focus on the separator').toBeFocused();
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '480');
    expect(Math.round((await page.locator('#sidebar').boundingBox()).width)).toBe(480);
    await reload(page);
    await expect(page.getByRole('separator', { name: 'Resize notes sidebar' })).toHaveAttribute('aria-valuenow', '480');

    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y + 200, { steps: 4 });
    await page.mouse.up();
    const dragged = Number(await handle.getAttribute('aria-valuenow'));
    expect(dragged, 'dragging narrows the sidebar within bounds').toBeGreaterThanOrEqual(240);
    expect(dragged).toBeLessThan(480);
  } finally {
    await context.close();
  }
});

test('the overflow menu is a grouped WAI-ARIA menu driven from the keyboard', async ({ browser, runtimeErrors }) => {
  const { context, page } = await openSurface(browser, { viewport: 1440, runtimeErrors });
  try {
    const button = page.locator('#menu-btn');
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await button.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const groups = await menu
      .getByRole('group')
      .evaluateAll((nodes) =>
        nodes.map((node) => document.getElementById(node.getAttribute('aria-labelledby'))?.textContent),
      );
    expect(groups).toEqual(['Create', 'Views', 'Knowledge', 'Data', 'App']);
    await expect(menu.getByRole('menuitem')).toHaveCount(17);
    await expect(menu.getByRole('separator')).toHaveCount(4);

    const focused = () => page.evaluate(() => document.activeElement?.id);
    expect(await focused(), 'ArrowDown opens at the first item').toBe('template-btn');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('today-btn');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await focused(), 'ArrowUp wraps to the last item').toBe('settings-btn');
    await page.keyboard.press('Home');
    expect(await focused()).toBe('template-btn');
    await page.keyboard.press('End');
    expect(await focused()).toBe('settings-btn');
    await page.keyboard.press('b');
    expect(await focused(), 'a letter jumps to the next matching item').toBe('backup-btn');

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button, 'Escape returns focus to the menu button').toBeFocused();

    await page.keyboard.press('ArrowUp');
    expect(await focused(), 'ArrowUp opens at the last item').toBe('settings-btn');
    await page.keyboard.press('Tab');
    await expect(menu, 'Tab closes the menu').toBeHidden();
    expect(await focused()).not.toBe('settings-btn');

    await button.focus();
    await page.keyboard.press('Enter');
    expect(await focused(), 'Enter opens at the first item').toBe('template-btn');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await expect(menu).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toBeHidden();
    await expect(button, 'closing a dialog opened from the menu returns focus to its button').toBeFocused();

    await button.click();
    await expect(menu).toBeVisible();
    await page.locator('.editor__blocks').click();
    await expect(menu, 'clicking outside closes the menu').toBeHidden();
  } finally {
    await context.close();
  }
});

test('phone layout: the rail is a bottom bar of touch targets and nothing overflows', async ({
  browser,
  runtimeErrors,
}) => {
  const { context, page } = await openSurface(browser, { viewport: 390, runtimeErrors });
  try {
    const rail = page.getByRole('navigation', { name: 'Workspace' });
    const railBox = await rail.boundingBox();
    expect(railBox.y + railBox.height, 'rail sits at the bottom of the viewport').toBeGreaterThan(844 - 2);
    const visible = await rail.locator('.rail__btn:visible').all();
    expect(visible.length).toBe(5);
    for (const button of visible) {
      const b = await button.boundingBox();
      expect(Math.min(b.width, b.height), 'touch target').toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('#rail-sidebar-btn')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const selector of ['.editor__properties', '.editor__pin', '.editor__delete']) {
      const b = await page.locator(selector).boundingBox();
      expect(b.x + b.width, `${selector} stays on screen`).toBeLessThanOrEqual(390);
    }
    const toolbar = page.locator('.workspace__toolbar');
    const actions = await toolbar.locator('.btn:visible').all();
    const centers = [];
    for (const action of actions) {
      const b = await action.boundingBox();
      centers.push(b.y + b.height / 2);
    }
    expect(Math.max(...centers) - Math.min(...centers), 'workspace toolbar actions fit on one row').toBeLessThan(12);
    await expect(page.getByRole('button', { name: 'Reopen tab' })).toBeVisible();

    await openMenu(page);
    const dropdown = await page.locator('#menu-dropdown').boundingBox();
    expect(dropdown.y + dropdown.height, 'the overflow menu ends inside the viewport').toBeLessThanOrEqual(844);
    await page.keyboard.press('End');
    const last = await page.locator('#settings-btn').boundingBox();
    expect(last.y + last.height, 'End scrolls the last menu item into view').toBeLessThanOrEqual(844);
    await page.keyboard.press('Escape');
    await expect(page.locator('#menu-dropdown')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).not.toHaveClass(/sidebar-open/);

    await page.locator('#capture-btn').click();
    await expect(page.locator('#quick-capture-overlay')).toBeVisible();
  } finally {
    await context.close();
  }
});

async function contextBeside(page, root = page) {
  const blocks = await root.locator('.editor__blocks').first().boundingBox();
  const backlinks = await root.locator('.backlinks').first().boundingBox();
  return { beside: backlinks.x >= blocks.x + blocks.width, below: backlinks.y >= blocks.y + blocks.height - 1 };
}

test('wide editors put outline, backlinks, and mentions in a context column; narrow ones stack them', async ({
  browser,
  runtimeErrors,
}) => {
  let { context, page } = await openSurface(browser, { viewport: 1440, runtimeErrors });
  try {
    const wide = await contextBeside(page);
    expect(wide.beside, 'backlinks sit beside the text at 1440 px').toBe(true);
    const outline = await page.locator('.editor__outline').boundingBox();
    const backlinks = await page.locator('.backlinks').boundingBox();
    expect(Math.abs(outline.x - backlinks.x), 'outline and backlinks share the context column').toBeLessThan(2);
    const mentions = await page.locator('.mentions').boundingBox();
    expect(Math.abs(mentions.width - backlinks.width), 'mentions fill the column like backlinks').toBeLessThan(2);

    await page.getByRole('button', { name: 'Split view' }).click();
    await expect(page.locator('.workspace--split')).toBeVisible();
    const split = await contextBeside(page, page.locator('.workspace__pane[data-pane="primary"]'));
    expect(split.below, 'a half-width pane stacks its context under the text').toBe(true);
  } finally {
    await context.close();
  }
  ({ context, page } = await openSurface(browser, { viewport: 390, runtimeErrors }));
  try {
    const narrow = await contextBeside(page);
    expect(narrow.below, 'phones stack backlinks under the text').toBe(true);
  } finally {
    await context.close();
  }
});

test('the text column keeps its width in empty and short notes', async ({ browser, runtimeErrors }) => {
  for (const viewport of [1440, 390]) {
    const { context, page } = await openSurface(browser, { viewport, surface: 'new-note', runtimeErrors });
    try {
      const title = await page.locator('.editor__title:visible').boundingBox();
      const blocks = page.locator('.editor__blocks:visible');
      const empty = await blocks.boundingBox();
      expect(Math.abs(empty.x - title.x), `${viewport}: an empty note's body starts under its title`).toBeLessThan(2);
      expect(empty.width, `${viewport}: an empty note's body spans the text column`).toBeGreaterThan(
        viewport === 1440 ? 500 : 300,
      );
      const first = page.locator('.editor__blocks:visible .blk').first();
      await first.click();
      await expect(first, `${viewport}: clicking an empty note's body starts editing`).toBeFocused();
      await page.keyboard.type('Hi');
      expect((await blocks.boundingBox()).width, `${viewport}: a one-word note keeps the full column`).toBe(
        empty.width,
      );
    } finally {
      await context.close();
    }
  }
});

test('menus and dialogs animate in, and reduced motion removes the animation', async ({ browser, runtimeErrors }) => {
  const animation = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, seconds: Number.parseFloat(style.animationDuration) };
    });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const { context, page } = await openSurface(browser, { viewport: 1440, runtimeErrors });
    try {
      await page.emulateMedia({ reducedMotion });
      await page.locator('#menu-btn').click();
      const menu = await animation(page.locator('#menu-dropdown'));
      await page.locator('#settings-btn').click();
      const dialog = await animation(page.locator('#settings-overlay .modal__panel'));
      expect([menu.name, dialog.name]).toEqual(['nf-drop-in', 'nf-rise-in']);
      if (reducedMotion === 'reduce') {
        expect(Math.max(menu.seconds, dialog.seconds), 'reduced motion shortens enter animations').toBeLessThan(0.001);
      } else {
        expect([menu.seconds, dialog.seconds], 'enter animations use the motion tokens').toEqual([0.12, 0.18]);
      }
    } finally {
      await context.close();
    }
  }
});
