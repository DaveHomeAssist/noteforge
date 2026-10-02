// Exercise the real lazy chunk in the production build, with network timing
// controlled so teardown and a retryable CSS preload failure are deterministic.
import { captureRuntimeErrors } from './support/runtime.mjs';
import { openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

const PICKER_JS = /\/assets\/banner-picker-[^/]+\.js$/;
const PICKER_CSS = /\/assets\/banner-picker-[^/]+\.css$/;
const IMAGE = {
  type: 'image',
  value: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  position: 50,
};
const ACTIONS = [
  ['Add', '.banner-add'],
  ['Change', '[data-act="change"]'],
  ['Reposition', '[data-act="reposition"]'],
];

async function prepareBanner(page, name) {
  await page.evaluate(
    (banner) => {
      document.activeElement?.blur();
      window.app.editor.activeEditor.banner.onChange(banner);
      window.__oldBanner = window.app.editor.activeEditor.banner;
      window.__oldNoteId = window.app.currentId;
    },
    name === 'Add' ? null : IMAGE,
  );
}

async function expectAction(page, name) {
  if (name === 'Add') await expect(page.locator('.banner--gradient')).toBeVisible();
  else if (name === 'Change') await expect(page.locator('.banner-picker')).toBeVisible();
  else await expect(page.getByRole('slider', { name: 'Vertical position' })).toBeVisible();
}

for (const [name, selector] of ACTIONS) {
  test(`banner: deferred ${name} is cancelled when switching notes`, async ({ browser, runtimeErrors }) => {
    const { context, page } = await openSurface(browser, { viewport: 1440, surface: 'new-note', runtimeErrors });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requests = 0;
    try {
      await prepareBanner(page, name);
      await page.route(PICKER_JS, async (route) => {
        requests++;
        await held;
        await route.continue();
      });
      await page.locator(selector).click();
      await expect.poll(() => requests).toBe(1);
      await page.evaluate(() => window.app.newNote());
      expect(await page.evaluate(() => window.__oldBanner.host.isConnected)).toBe(false);
      // A live control shares the same in-flight load and must still complete.
      await page.locator('.banner-add').click();
      release();
      await expectAction(page, 'Add');
      expect(requests, 'concurrent controls share the chunk load').toBe(1);
      expect(await page.evaluate(() => window.app.db.getNote(window.__oldNoteId).banner)).toEqual(
        name === 'Add' ? null : IMAGE,
      );
      expect(
        await page.evaluate(() => ({
          picker: window.__oldBanner.picker,
          repositioning: window.__oldBanner.repositioning,
          detachedUI: !!window.__oldBanner.host.querySelector('.banner__reposition'),
        })),
      ).toEqual({ picker: null, repositioning: false, detachedUI: false });
      await expect(page.locator('.banner-picker')).toHaveCount(0);
      // Teardown also guards the synchronous cached-module path.
      await page.evaluate((target) => window.__oldBanner.host.querySelector(target).click(), selector);
      expect(await page.evaluate(() => window.app.db.getNote(window.__oldNoteId).banner)).toEqual(
        name === 'Add' ? null : IMAGE,
      );
      await expect(page.locator('.banner-picker')).toHaveCount(0);
      expect(await page.evaluate(() => window.__oldBanner.repositioning)).toBe(false);
    } finally {
      release();
      await context.close();
    }
  });

  test(`banner: ${name} retries after a failed first picker load`, async ({ browser, runtimeErrors }) => {
    const { context, page } = await openSurface(browser, { viewport: 1440, surface: 'new-note' });
    const loadErrors = [];
    captureRuntimeErrors(page, loadErrors);
    let failedCSS = 0;
    let pickerRequests = 0;
    try {
      await prepareBanner(page, name);
      page.on('request', (request) => {
        if (PICKER_JS.test(request.url())) pickerRequests++;
      });
      // Vite rejects the import wrapper when its stylesheet preload fails.
      // Unlike an ESM evaluation failure, this is retryable in the same page.
      await page.route(
        PICKER_CSS,
        async (route) => {
          failedCSS++;
          await route.abort('failed');
        },
        { times: 1 },
      );
      // Keep prefetch and click on the same promise before the CSS fails.
      await page.locator(selector).evaluate((button) => {
        button.focus();
        button.click();
      });
      await expect.poll(() => failedCSS).toBe(1);
      await expect.poll(() => loadErrors.filter((error) => error.startsWith('requestfailed:')).length).toBe(1);
      // Wait for the rejection to reach the event-handler boundary.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(await page.evaluate(() => window.app.db.getNote(window.__oldNoteId).banner)).toEqual(
        name === 'Add' ? null : IMAGE,
      );
      await expect(page.locator('.banner-picker, .banner__reposition')).toHaveCount(0);

      await page.locator(selector).click();
      await expectAction(page, name);
      expect(pickerRequests, 'successful module is fetched once').toBe(1);
      // Cached Change must open synchronously without another import request.
      expect(
        await page.evaluate(() => {
          window.app.editor.activeEditor.banner.closePicker();
          document.querySelector('[data-act="change"]').click();
          return !!window.app.editor.activeEditor.banner.picker;
        }),
        'cached picker opens synchronously',
      ).toBe(true);
      await expect(page.locator('.banner-picker')).toBeVisible();
      expect(pickerRequests).toBe(1);
      // Only the deliberately failed CSS request and its browser resource log
      // are expected; unhandled promise rejections still fail the test.
      for (const error of loadErrors) {
        if (error.startsWith('requestfailed:') && /banner-picker-.*\.css.*net::ERR_FAILED/.test(error)) continue;
        if (error === 'console.error: Failed to load resource: net::ERR_FAILED') continue;
        runtimeErrors.push(error);
      }
    } finally {
      await context.close();
    }
  });
}
