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

export async function openMenu(page) {
  // Below 760 px the overflow menu lives in the off-canvas sidebar. Its button
  // still counts as "visible" there (it has a size, just off-screen), so key on
  // the mobile bar's sidebar toggle instead.
  const mobile = await page.locator('#sidebar-toggle').isVisible();
  const open = await page.evaluate(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
  if (mobile && !open) {
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
  }
  await page.locator('#menu-btn').click();
  await page.locator('#menu-dropdown').waitFor({ state: 'visible', timeout: TIMEOUT });
}

async function openFromMenu(page, buttonSelector) {
  await openMenu(page);
  await page.locator(buttonSelector).click();
}

async function visible(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: TIMEOUT });
}

/** name → how to reach it from the booted shell. */
export const SURFACES = {
  shell: async () => {},
  menu: async (page) => {
    await openMenu(page);
  },
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
  // A note without a banner shows the "Add banner" control.
  'new-note': async (page) => {
    await page.evaluate(() => window.app.newNote());
    await visible(page, '.banner-add');
  },
  // The slash menu over a new note's empty first block. Typing "/" autosaves
  // after a debounce and the note list then shows "/" as the snippet; wait for
  // that so screenshots never race it.
  'slash-menu': async (page) => {
    await page.evaluate(() => window.app.newNote());
    await page.locator('.editor__blocks .blk:visible').first().click();
    await page.keyboard.type('/');
    await visible(page, '.blk-menu [role="option"]');
    await page.waitForFunction(() => window.app.db.getNote(window.app.currentId)?.content === '/', undefined, {
      timeout: TIMEOUT,
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await visible(page, '.blk-menu [role="option"]');
  },
  // A notice with an action, as after moving a note to Trash.
  toast: async (page) => {
    await page.evaluate(() => window.app.toast('Moved “Welcome” to Trash.', { action: { label: 'Undo', run() {} } }));
    await visible(page, '.toasts .toast .toast__close');
  },
  // A destructive confirmation with the pointer on its confirm button, so the
  // hover colors are what axe measures.
  'confirm-danger': async (page) => {
    await page.evaluate(() => {
      void window.app.confirm({
        title: 'Delete permanently?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete permanently',
        danger: true,
      });
    });
    await visible(page, '#confirm-dialog [data-confirm-accept]');
    await page.locator('#confirm-dialog [data-confirm-accept]').hover();
  },
};

// The app paints first and then initializes recovery, the knowledge index,
// navigation, saved views, properties, and the workspace tab bar on idle
// callbacks. Scans and screenshots wait for all of them, or they race the
// workspace UI appearing (it adds buttons and a tablist).
async function settle(page) {
  await page.waitForFunction(
    () =>
      Boolean(
        window.app?.recovery &&
          window.app?.navigationReady &&
          window.app?.savedSearchesReady &&
          window.app?.phase5Ready &&
          window.app?.phase6Ready,
      ),
    undefined,
    { timeout: TIMEOUT },
  );
  await page.evaluate(() =>
    Promise.all([
      window.app.recoveryReady,
      window.app.navigationReady,
      window.app.savedSearchesReady,
      window.app.phase5Ready,
      window.app.phase6Ready,
      window.app.db.initializeKnowledgeIndex(),
      window.app.editor.enableOutline(),
    ]),
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

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
  await settle(page);
  if (theme === 'dark') {
    await page.locator('#theme-btn:visible, #mobile-theme-btn:visible').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  }
  await SURFACES[surface](page);
  await page.evaluate(() => document.fonts.ready);
  // A theme switch or an opening dialog starts CSS transitions; axe and
  // screenshots must see the end state, not a blend of both themes.
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    {
      timeout: TIMEOUT,
    },
  );
  return { context, page };
}
