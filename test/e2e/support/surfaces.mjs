// Deterministic app states for the accessibility and visual suites. Every state
// starts from a fresh profile of the production build (Vite preview under
// /noteforge/) with the suite's fixed clock, so the seeded sample notes, their
// timestamps, and the open note are identical on every run.
import { captureRuntimeErrors, newAppContext, previewRoot, TIMEOUT } from './runtime.mjs';

export const VIEWPORTS = {
  390: { width: 390, height: 844 },
  1440: { width: 1440, height: 900 },
  2560: { width: 2560, height: 1440 },
};

async function openFromMenu(page, buttonSelector) {
  // Below 760 px the overflow menu lives in the off-canvas sidebar.
  if (!(await page.locator('#menu-btn').isVisible())) {
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
  }
  await page.locator('#menu-btn').click();
  await page.locator(buttonSelector).click();
}

async function visible(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: TIMEOUT });
}

/** name → how to reach it from the booted shell. */
export const SURFACES = {
  shell: async () => {},
  graph: async (page) => {
    await page.locator('#graph-btn:visible').first().click();
    await visible(page, '#graph:not([hidden])');
  },
  palette: async (page) => {
    await openFromMenu(page, '#palette-btn');
    await visible(page, '#palette-overlay .palette__item');
  },
  settings: async (page) => {
    await openFromMenu(page, '#settings-btn');
    await visible(page, '#settings-overlay');
  },
  trash: async (page) => {
    await openFromMenu(page, '#trash-btn');
    await visible(page, '#trash-overlay');
  },
  backup: async (page) => {
    await openFromMenu(page, '#backup-btn');
    await visible(page, '#backup-overlay');
  },
  tasks: async (page) => {
    await openFromMenu(page, '#tasks-btn');
    await visible(page, '#task-dashboard-overlay');
  },
  calendar: async (page) => {
    await openFromMenu(page, '#calendar-btn');
    await visible(page, '#calendar-overlay');
  },
  archive: async (page) => {
    await openFromMenu(page, '#archive-btn');
    await visible(page, '#archive-overlay');
  },
  'link-tools': async (page) => {
    await openFromMenu(page, '#link-report-btn');
    await visible(page, '#link-tools-overlay');
  },
  'find-replace': async (page) => {
    await openFromMenu(page, '#find-replace-btn');
    await visible(page, '#find-replace-panel');
  },
  'quick-capture': async (page) => {
    await page.locator('#capture-btn:visible').first().click();
    await visible(page, '#quick-capture-overlay');
  },
  properties: async (page) => {
    await page.locator('.editor__properties').click();
    await visible(page, '#properties-overlay');
  },
  clipper: async (page) => {
    await openFromMenu(page, '#clipper-btn');
    await visible(page, '#clipper-overlay');
  },
  reconciliation: async (page) => {
    await openFromMenu(page, '#reconcile-btn');
    await visible(page, '#reconciliation-overlay');
  },
};

/**
 * Boot the production app on a fresh profile at `viewport`, switch to `theme`,
 * and navigate to `surface`. Returns the context (close it) and the page.
 */
export async function openSurface(browser, { viewport, theme = 'light', surface = 'shell', runtimeErrors }) {
  const context = await newAppContext(browser, { viewport: VIEWPORTS[viewport], serviceWorkers: 'block' });
  const page = await context.newPage();
  if (runtimeErrors) captureRuntimeErrors(page, runtimeErrors);
  await page.goto(new URL('noteforge/', previewRoot()).href, { waitUntil: 'load', timeout: TIMEOUT });
  await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
  await page.evaluate(() => window.app.ready);
  await page.locator('.note-item').first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (theme === 'dark') {
    await page.locator('#theme-btn:visible, #mobile-theme-btn:visible').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  }
  await SURFACES[surface](page);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
