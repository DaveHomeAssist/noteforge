// Shared runtime for the Playwright suite: timeouts, the fixed clock, browser
// error capture, and a context factory that applies all of them. Every page the
// suite drives is created through `newAppContext` so the date, time zone, and
// locale are identical on a laptop in Philadelphia and a CI runner in UTC.

export const TIMEOUT = 60_000;

// The suite's "now". Mid-month, mid-week, mid-day, away from DST changes and
// month boundaries, so date fixtures (today, yesterday, +7 days, calendar weeks)
// never straddle an edge. The clock then runs forward in real time, so debounces,
// idle callbacks, and animations still fire.
export const FIXED_NOW = new Date('2026-09-16T15:00:00Z'); // 11:00 in America/New_York
export const TIME_ZONE = 'America/New_York';
export const LOCALE = 'en-US';

/** Browser-side failures that fail a test unless the test expects them. */
export function captureRuntimeErrors(page, errors) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.stack || err.message || err}`));
  page.on('requestfailed', (request) => {
    errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText || 'unknown error'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
  });
}

/**
 * Install the fixed, forward-running clock on a context before any page loads.
 * NOTEFORGE_E2E_REAL_CLOCK=1 skips it, to tell a clock-dependent failure from a
 * real one (the fixed clock once exposed a tab-close race the real clock hid).
 */
export async function installFixedClock(context) {
  if (process.env.NOTEFORGE_E2E_REAL_CLOCK) return;
  await context.clock.install({ time: FIXED_NOW });
}

// Test-only stand-in for page.on('dialog'): NoteForge confirms with an in-app
// dialog (src/ui/dialogs.js), not window.confirm. When #confirm-dialog opens,
// this answers it with window.__e2eConfirmNext (used once, like page.once) or
// window.__e2eConfirmAll (every time, like page.on); with neither set, the
// dialog stays open for the test to drive.
function confirmResponder() {
  const answer = () => {
    const dialog = document.getElementById('confirm-dialog');
    if (!dialog || dialog.hidden) {
      if (dialog) delete dialog.dataset.e2eAnswered;
      return;
    }
    if (dialog.dataset.e2eAnswered) return;
    const choice = window.__e2eConfirmNext || window.__e2eConfirmAll;
    if (!choice) return;
    dialog.dataset.e2eAnswered = '1';
    if (window.__e2eConfirmNext) window.__e2eConfirmNext = null;
    setTimeout(() =>
      dialog
        .querySelector(choice === 'accept' ? '[data-confirm-accept]' : '.confirm-dialog__actions [data-confirm-cancel]')
        ?.click(),
    );
  };
  new MutationObserver(answer).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });
}

/** Answer the next in-app confirm dialog with 'accept' or 'dismiss'. */
export async function confirmNext(page, choice) {
  await page.evaluate((value) => {
    window.__e2eConfirmNext = value;
  }, choice);
}

/** Answer every in-app confirm dialog on this page (including after navigation). */
export async function confirmAll(page, choice) {
  await page.addInitScript((value) => {
    window.__e2eConfirmAll = value;
  }, choice);
}

/**
 * A browser context with the suite's clock, time zone, and locale. Pass the same
 * options as `browser.newContext` (viewport, serviceWorkers, acceptDownloads...).
 */
export async function newAppContext(browser, options = {}) {
  const context = await browser.newContext({ timezoneId: TIME_ZONE, locale: LOCALE, ...options });
  await installFixedClock(context);
  await context.addInitScript(confirmResponder);
  return context;
}

export function devUrl() {
  const url = process.env.NOTEFORGE_E2E_DEV_URL;
  if (!url)
    throw new Error(
      'NOTEFORGE_E2E_DEV_URL is unset; run the suite through `playwright test` (global setup starts Vite).',
    );
  return url;
}

export function previewRoot() {
  const url = process.env.NOTEFORGE_E2E_PREVIEW_URL;
  if (!url)
    throw new Error(
      'NOTEFORGE_E2E_PREVIEW_URL is unset; run the suite through `playwright test` (global setup builds and previews).',
    );
  return url;
}
