// Headless runner for the browser feature suite (test/features.html).
//
// Boots a Vite dev server in-process (so ES-module imports from /src resolve the
// same way they do during development), drives it with Playwright/Chromium, and
// reads the pass/fail summary the page publishes to document.title. Exit code is
// 0 only when every assertion passes — this is what CI gates on.
//
// Run locally: `npm run test:browser` (requires `npx playwright install chromium`).

import { createServer } from 'vite';
import { chromium } from 'playwright';

const TIMEOUT = 60_000;

async function main() {
  const server = await createServer({
    // Never pop a browser open in CI; everything else comes from vite.config.js.
    server: { open: false },
    logLevel: 'warn',
  });
  await server.listen();

  const base = server.resolvedUrls?.local?.[0];
  if (!base) throw new Error('Vite did not report a local URL');
  const target = new URL('test/features.html', base).href;

  // Prefer Playwright's bundled Chromium (installed in CI via `playwright
  // install`); fall back to a system Chrome/Edge install so the suite runs
  // locally without a browser download.
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const channel = process.env.PW_CHANNEL || 'chrome';
    console.warn(`[test] bundled Chromium unavailable (${err.message}); trying channel "${channel}"`);
    browser = await chromium.launch({ channel });
  }
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message || err}`));

  let title = '';
  let output = '';
  let failed = false;
  try {
    await page.goto(target, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(
      () => /^(ALL PASS|FAILURES)/.test(document.title),
      undefined,
      { timeout: TIMEOUT }
    );
    title = await page.title();
    output = await page.$eval('#out', (el) => el.textContent);
  } catch (err) {
    failed = true;
    output = `Runner error: ${err.message || err}`;
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(output);
  if (consoleErrors.length) {
    console.log('\nConsole/page errors during run:');
    for (const e of consoleErrors) console.log('  ' + e);
  }

  if (failed || !title.startsWith('ALL PASS')) {
    console.error(`\n❌ Browser feature tests failed${title ? ` — ${title}` : ''}`);
    process.exit(1);
  }
  console.log(`\n✅ ${title}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
