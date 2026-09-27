// In-app dialogs against the production build: a confirmation owns the keyboard
// (global shortcuts stay out) and stacks over another dialog, one Escape per layer.
import { openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

test('an open confirmation keeps global shortcuts out and closes on Escape', async ({ browser, runtimeErrors }) => {
  const { context, page } = await openSurface(browser, { viewport: 1440, runtimeErrors });
  try {
    const noteCount = () => page.evaluate(() => window.app.db.getAllNotes().length);
    const before = await noteCount();
    const answer = page.evaluate(() =>
      window.app.confirm({ title: 'Keep going?', message: 'Shortcut gate check.', confirmLabel: 'Continue' }),
    );
    await page.locator('#confirm-dialog [data-confirm-accept]').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+n');
    await page.keyboard.press('Control+k');
    expect(await noteCount(), 'Ctrl+N created a note behind the confirmation').toBe(before);
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await expect(page.locator('#palette-overlay')).toBeHidden();
    await page.keyboard.press('Escape');
    expect(await answer).toBe(false);
    await expect(page.locator('#confirm-dialog')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('a confirmation over another dialog makes it inert and one Escape closes one layer', async ({
  browser,
  runtimeErrors,
}) => {
  const { context, page } = await openSurface(browser, { viewport: 1440, surface: 'settings', runtimeErrors });
  try {
    const answer = page.evaluate(() =>
      window.app.confirm({ title: 'Nested?', message: 'Confirm over Settings.', confirmLabel: 'Continue' }),
    );
    await page.locator('#confirm-dialog [data-confirm-accept]').waitFor({ state: 'visible' });
    expect(await page.locator('#settings-overlay').getAttribute('inert')).not.toBeNull();
    await page.keyboard.press('Escape');
    expect(await answer).toBe(false);
    await expect(page.locator('#confirm-dialog')).toBeHidden();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    expect(await page.locator('#settings-overlay').getAttribute('inert')).toBeNull();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toBeHidden();
  } finally {
    await context.close();
  }
});

// axe reports filtered or blended hover states as "needs review", so hover
// contrast is measured directly from computed colors.
async function hoverContrast(page, selector) {
  await page.locator(selector).hover();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const rgb = (value) =>
      value
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const luminance = ([r, g, b]) => {
      const channel = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const [a, b] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((x, y) => y - x);
    return {
      ratio: (a + 0.05) / (b + 0.05),
      filter: style.filter,
      color: style.color,
      background: style.backgroundColor,
    };
  });
}

for (const theme of ['light', 'dark']) {
  test(`filled buttons keep AA contrast on hover (${theme})`, async ({ browser, runtimeErrors }) => {
    const { context, page } = await openSurface(browser, {
      viewport: 1440,
      theme,
      surface: 'confirm-danger',
      runtimeErrors,
    });
    try {
      const danger = await hoverContrast(page, '#confirm-dialog [data-confirm-accept]');
      expect(danger.filter, 'hover must not rely on a filter').toBe('none');
      expect(danger.ratio, `destructive hover ${danger.color} on ${danger.background}`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
      const primary = await hoverContrast(page, '#new-note-btn');
      expect(primary.filter, 'hover must not rely on a filter').toBe('none');
      expect(primary.ratio, `primary hover ${primary.color} on ${primary.background}`).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
    }
  });
}
