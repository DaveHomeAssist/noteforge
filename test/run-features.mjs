// Headless runner for the browser feature suite (test/features.html).
//
// Boots a Vite dev server in-process (so ES-module imports from /src resolve the
// same way they do during development), drives it with Playwright/Chromium, and
// reads the pass/fail summary the page publishes to document.title. Exit code is
// 0 only when every assertion passes without browser errors — this is what CI
// gates on.
//
// Run locally: `npm run test:browser` (requires `npx playwright install chromium`).

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright';

const TIMEOUT = 60_000;
const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE_CLI = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

async function buildProduction() {
  // Vite's dev server sets NODE_ENV in-process. Build in a fresh process so
  // import.meta.env.PROD is compiled correctly and production-only PWA
  // registration cannot be tree-shaken out after the component/dev suite.
  await execFileAsync(process.execPath, [VITE_CLI, 'build'], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function captureRuntimeErrors(page, errors) {
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

async function runRecoverySmoke(browser, base, runtimeErrors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route('**/src/components/history-view.js*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  }, { times: 1 });
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Recovery smoke failed: ${name}`);
    checks.push(`PASS  ${name}`);
  };
  let stage = 'booting the app';
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.locator('.note-item').first().waitFor({ state: 'visible' });
    check('390px app shell has no horizontal document overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    stage = 'persisting an edit';
    await page.locator('.editor__title').fill('Recovery browser smoke');
    await page.locator('.blk[contenteditable="true"]').first().fill('Durable browser edit');
    const debouncedEdit = await page.evaluate(() => ({
      editor: document.querySelector('.blk[contenteditable="true"]')?.textContent || '',
      durable: window.app.db.getNote(window.app.currentId)?.content || '',
      pendingWrites: window.app.db.getPersistenceStatus().pendingWrites,
    }));
    check('history is opened while the latest editor bytes are still pending debounce',
      debouncedEdit.editor.includes('Durable browser edit')
        && !debouncedEdit.durable.includes('Durable browser edit')
        && debouncedEdit.pendingWrites === 0);

    stage = 'opening revision history';
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator('#menu-btn').click();
    await page.locator('#history-btn').click();
    await page.locator('.blk[contenteditable="true"]').first().fill('Typed during lazy History initialization');
    await page.locator('#history-overlay').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.history-revision').first().waitFor({ state: 'visible' });
    check('integrated history shows the durable edit revision',
      await page.locator('.history-revision').count() >= 1
      && /Revision history/i.test(await page.locator('#history-overlay').innerText()));
    const capturedContent = await page.evaluate(async () => {
      const [revision] = await window.app.recovery.listRevisions(window.app.currentId);
      return revision ? (await window.app.recovery.revisions.materialize(revision)).content : '';
    });
    check('opening History flushes edits made during first-use lazy initialization', capturedContent.includes('Typed during lazy History initialization'));
    check('history modal moves focus inside its dialog',
      await page.evaluate(() => document.querySelector('#history-overlay')?.contains(document.activeElement)));
    check('recovery modal inerts every non-modal body surface on mobile',
      await page.evaluate(() => document.querySelector('.mobile-bar')?.inert
        && document.querySelector('#sidebar-backdrop')?.inert
        && document.querySelector('#app')?.inert));
    await page.keyboard.press('Escape');
    await page.locator('#history-overlay').waitFor({ state: 'hidden' });

    stage = 'restoring an older revision through the integrated history UI';
    await page.locator('.blk[contenteditable="true"]').first().fill('Newer browser edit to undo');
    await page.evaluate(async () => {
      // Persist a deterministic second durable state through the same Database
      // boundary. The preceding check already proves the editor-debounce flush;
      // this setup isolates the actual History restore wiring from timer jitter.
      const note = window.app.db.getNote(window.app.currentId);
      note.update({ content: 'Newer browser edit to undo' });
      window.app.db.saveNote(note);
      await window.app.db.flush();
    });
    if (!await page.evaluate(() => document.querySelector('#app')?.classList.contains('sidebar-open'))) {
      await page.locator('#sidebar-toggle').click();
      await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    }
    await page.locator('#menu-btn').click();
    await page.locator('#history-btn').click();
    await page.locator('#history-overlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.history-revision').length >= 2);
    const targetRevisionId = await page.evaluate(async () => {
      const revisions = await window.app.recovery.listRevisions(window.app.currentId);
      for (const revision of revisions) {
        const materialized = await window.app.recovery.revisions.materialize(revision);
        if (materialized.content.includes('Typed during lazy History initialization')) return revision.id;
      }
      return null;
    });
    if (!targetRevisionId) throw new Error('The intended browser-smoke revision could not be found.');
    await page.locator('.history-revision').evaluateAll((buttons, revisionId) => {
      const target = buttons.find((button) => button.dataset.revisionId === revisionId);
      if (!target) throw new Error('The intended browser-smoke revision button could not be found.');
      target.click();
    }, targetRevisionId);
    await page.waitForFunction((revisionId) => {
      const selected = [...document.querySelectorAll('.history-revision')]
        .find((button) => button.dataset.revisionId === revisionId);
      return selected?.getAttribute('aria-current') === 'true'
        && !document.querySelector('#history-restore')?.disabled
        && /Showing revision from/i.test(document.querySelector('#history-status')?.textContent || '');
    }, targetRevisionId);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#history-restore').click();
    await page.waitForFunction(() => window.app.db.getNote(window.app.currentId)?.content.includes('Typed during lazy History initialization'));
    check('integrated revision restore reapplies the selected Markdown after explicit confirmation',
      await page.evaluate(() => window.app.db.getNote(window.app.currentId)?.content.includes('Typed during lazy History initialization')));
    await page.keyboard.press('Escape');
    await page.locator('#history-overlay').waitFor({ state: 'hidden' });

    stage = 'preparing exact portable-backup state';
    await page.evaluate(async () => {
      const trashed = window.app.db.createNote({
        id: 'recovery-smoke-trash',
        title: 'Recovery smoke Trash',
        content: 'must return to Trash',
      });
      window.app.db.deleteNote(trashed.id);
      window.app.db.setConfig({ recoverySmokeConfig: 'backed-up' });
      await window.app.db.flush();
    });

    stage = 'opening Backup center';
    if (!await page.evaluate(() => document.querySelector('#app')?.classList.contains('sidebar-open'))) {
      await page.locator('#sidebar-toggle').click();
      await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    }
    await page.locator('#menu-btn').click();
    await page.locator('#backup-btn').click();
    await page.locator('#backup-overlay').waitFor({ state: 'visible' });
    await page.locator('.backup-health').waitFor({ state: 'visible' });
    const backupText = await page.locator('#backup-overlay').innerText();
    check('integrated Backup center reports IndexedDB and local-versus-portable recovery',
      /IndexedDB/.test(backupText) && /browser-local recovery aids/i.test(backupText) && /portable/i.test(backupText));
    check('integrated rolling snapshots are visible', await page.locator('.backup-snapshot').count() >= 1);
    check('390px Backup center remains within the viewport',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    stage = 'downloading a portable backup';
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#backup-download').click(),
    ]);
    check('portable backup download has the expected JSON filename', /^noteforge-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()));
    stage = 'uploading and verifying the downloaded backup';
    const backupPath = await download.path();
    await page.evaluate(async () => {
      window.app.db.purgeNote('recovery-smoke-trash');
      window.app.db.createNote({ id: 'post-backup-temp', title: 'Remove on restore', content: 'temporary' });
      window.app.db.setConfig({ recoverySmokeConfig: 'mutated-after-backup' });
      await window.app.db.flush();
    });
    await page.locator('#backup-file').setInputFiles(backupPath);
    await page.locator('#backup-verify').click();
    await page.waitForFunction(() => /integrity verified/i.test(document.querySelector('#backup-status')?.textContent || ''));
    check('downloaded backup verifies through the integrated file workflow', /integrity verified/i.test(await page.locator('#backup-status').innerText()));
    stage = 'building the portable restore preview';
    await page.locator('#backup-preview-restore').click();
    await page.locator('.backup-restore-preview').waitFor({ state: 'visible' });
    check('portable restore preview is non-mutating and explicit', /No data has been changed/i.test(await page.locator('#backup-preview').innerText()));
    stage = 'confirming and applying the portable restore';
    page.once('dialog', (dialog) => dialog.accept());
    const [safetyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#backup-restore').click(),
    ]);
    await page.waitForFunction(() => /Restore completed successfully/i.test(document.querySelector('#backup-status')?.textContent || ''));
    check('confirmed restore re-verifies and downloads a pre-restore safety backup', /^noteforge-pre-restore-/.test(safetyDownload.suggestedFilename()));
    check('integrated portable restore reapplies exact config and Trash state while removing later notes',
      await page.evaluate(() => (
        window.app.db.config.recoverySmokeConfig === 'backed-up'
        && Boolean(window.app.db.notes.get('recovery-smoke-trash')?.deletedAt)
        && window.app.db.getNote('post-backup-temp') === null
      )));
    stage = 'closing Backup center after restore';
    await page.keyboard.press('Escape');
    await page.locator('#backup-overlay').waitFor({ state: 'hidden' });
    return checks.join('\n');
  } catch (error) {
    const status = await page.locator('#backup-status').textContent().catch(() => 'unavailable');
    const historyStatus = await page.locator('#history-status').textContent().catch(() => 'unavailable');
    const diagnostics = await page.evaluate(async () => ({
      currentId: window.app?.currentId,
      persistence: window.app?.db?.getPersistenceStatus?.(),
      recoveryReady: Boolean(window.app?.recovery),
      revisions: window.app?.recovery && window.app?.currentId
        ? (await window.app.recovery.listRevisions(window.app.currentId)).length
        : null,
    })).catch(() => null);
    throw new Error(`Recovery smoke failed while ${stage}: ${error?.message || error}; history status: ${String(historyStatus).trim() || 'empty'}; backup status: ${String(status).trim() || 'empty'}; diagnostics: ${JSON.stringify(diagnostics)}`);
  } finally {
    await context.close();
  }
}

async function runProductionOfflineSmoke(browser, runtimeErrors) {
  await buildProduction();
  const server = await preview({ logLevel: 'warn', preview: { open: false, host: '127.0.0.1', port: 0 } });
  const root = server.resolvedUrls?.local?.[0];
  if (!root) throw new Error('Vite preview did not report a local URL');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const page = await context.newPage();
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  let stage = 'loading the production app';
  try {
    const appUrl = new URL('/noteforge/', root).href;
    const shellResponse = await fetch(appUrl);
    const shellHtml = await shellResponse.text();
    const entryPath = shellHtml.match(/<script[^>]+src="([^"]+)"/)?.[1];
    if (!shellResponse.ok || !entryPath) throw new Error(`Production shell preflight failed (${shellResponse.status})`);
    const entryResponse = await fetch(new URL(entryPath, root));
    const entryType = entryResponse.headers.get('content-type') || '';
    if (!entryResponse.ok || !/javascript/i.test(entryType)) {
      throw new Error(`Production entry preflight failed (${entryResponse.status} ${entryType || 'unknown content type'} ${entryPath})`);
    }
    await page.goto(appUrl, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    stage = 'waiting for the production service worker';
    const worker = await page.evaluate(async () => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 15_000));
      const registration = await Promise.race([navigator.serviceWorker.ready, timeout]);
      if (!registration) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        return {
          ready: false,
          controller: Boolean(navigator.serviceWorker.controller),
          registrations: registrations.map((item) => ({
            scope: item.scope,
            installing: item.installing?.state || null,
            waiting: item.waiting?.state || null,
            active: item.active?.state || null,
          })),
          caches: await caches.keys(),
        };
      }
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      return { ready: true, controller: Boolean(navigator.serviceWorker.controller), caches: await caches.keys() };
    });
    if (!worker.ready || !worker.controller) throw new Error(`Service worker did not become ready and controlling: ${JSON.stringify(worker)}`);

    stage = 'reloading the production app offline';
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    checks.push('PASS  production app shell reloads from a fresh service-worker cache while offline');

    stage = 'opening revision history for the first time offline';
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    await page.locator('#menu-btn').click();
    await page.locator('#history-btn').click();
    await page.locator('#history-overlay').waitFor({ state: 'visible' });
    checks.push('PASS  production revision-history lazy chunk opens on first use offline');
    await page.keyboard.press('Escape');

    stage = 'opening Backup center and verifier for the first time offline';
    await page.locator('#menu-btn').click();
    await page.locator('#backup-btn').click();
    await page.locator('#backup-overlay').waitFor({ state: 'visible' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#backup-download').click(),
    ]);
    if (!/^noteforge-backup-/.test(download.suggestedFilename())) {
      throw new Error(`Unexpected offline backup filename: ${download.suggestedFilename()}`);
    }
    checks.push('PASS  production Backup center and backup-core lazy chunks work on first use offline');
    return checks.join('\n');
  } catch (error) {
    throw new Error(`Production offline smoke failed while ${stage}: ${error?.message || error}`);
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

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

  // Let Vite finish first-load dependency discovery before the authoritative
  // error-captured pass. Its optimizer can intentionally reload once and abort
  // module requests; those are dev-server setup, not application failures.
  await page.goto(target, { waitUntil: 'load', timeout: TIMEOUT });
  await page.waitForFunction(
    () => /^(ALL PASS|FAILURES)/.test(document.title),
    undefined,
    { timeout: TIMEOUT }
  );

  const runtimeErrors = [];
  captureRuntimeErrors(page, runtimeErrors);

  let title = '';
  let output = '';
  let failed = false;
  let devServerClosed = false;
  try {
    await page.goto(target, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(
      () => /^(ALL PASS|FAILURES)/.test(document.title),
      undefined,
      { timeout: TIMEOUT }
    );
    title = await page.title();
    // Locator reads retry across a transient Vite full-page reload; a raw
    // $eval can lose its execution context between the completed title wait
    // and result extraction even though the rerun remains healthy.
    output = await page.locator('#out').textContent({ timeout: TIMEOUT });
    const recoveryOutput = await runRecoverySmoke(browser, base, runtimeErrors);
    await page.close();
    await server.close();
    devServerClosed = true;
    const offlineOutput = await runProductionOfflineSmoke(browser, runtimeErrors);
    output += `\n${recoveryOutput}\n${offlineOutput}`;
  } catch (err) {
    failed = true;
    output = `Runner error: ${err.message || err}`;
  } finally {
    await browser.close();
    if (!devServerClosed) await server.close();
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
