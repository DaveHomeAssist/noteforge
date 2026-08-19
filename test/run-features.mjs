// Headless runner for the browser feature suite (test/features.html).
//
// Boots a Vite dev server in-process (so ES-module imports from /src resolve the
// same way they do during development), drives it with Playwright/Chromium, and
// reads the pass/fail summary the page publishes to document.title. Exit code is
// 0 only when every assertion passes without browser errors — this is what CI
// gates on.
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

  // Banner/image tests use these reserved hosts to exercise URL handling. Stub
  // them so the suite stays offline and expected image failures do not obscure
  // real console, page, or same-origin resource errors.
  const imageBody = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
  await page.route(/^https:\/\/(?:example\.com|invalid\.invalid)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: imageBody }));

  const runtimeErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') runtimeErrors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => runtimeErrors.push(`pageerror: ${err.stack || err.message || err}`));
  page.on('requestfailed', (request) => {
    runtimeErrors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText || 'unknown error'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) runtimeErrors.push(`http ${response.status()}: ${response.url()}`);
  });

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
  if (runtimeErrors.length) {
    console.error('\nUnexpected browser errors during run:');
    for (const error of runtimeErrors) console.error('  ' + error);
  }

  if (failed || runtimeErrors.length || !title.startsWith('ALL PASS')) {
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
