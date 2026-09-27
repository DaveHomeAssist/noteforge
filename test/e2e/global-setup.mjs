// Starts the servers the suite drives and publishes their URLs to the workers:
//   NOTEFORGE_E2E_DEV_URL      Vite dev server (source modules, test/features.html)
//   NOTEFORGE_E2E_PREVIEW_URL  Vite preview of a fresh production build (/noteforge/)
// Returns the teardown that closes both.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';
import { TIMEOUT } from './support/runtime.mjs';
import { warmLazyAppModules } from './support/smokes.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITE_CLI = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));

async function buildProduction() {
  // Vite's dev server sets NODE_ENV in-process. Build in a fresh process so
  // import.meta.env.PROD is compiled correctly and production-only PWA
  // registration cannot be tree-shaken out.
  await execFileAsync(process.execPath, [VITE_CLI, 'build'], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function launchChromium() {
  try {
    return await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
  } catch (error) {
    console.warn(`[e2e] bundled Chromium unavailable (${error.message}); trying channel "chrome"`);
    return chromium.launch({ channel: 'chrome' });
  }
}

async function warmDevServer(server, base) {
  // Let Vite finish first-load dependency discovery before any authoritative,
  // error-captured page: its optimizer can reload once and abort module requests.
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.goto(new URL('test/features.html', base).href, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => /^(ALL PASS|FAILURES)/.test(document.title), undefined, { timeout: TIMEOUT });
    await page.close();
    await warmLazyAppModules(browser, base);
    await server.waitForRequestsIdle();
  } finally {
    await browser.close();
  }
}

export default async function globalSetup() {
  const devServer = await createServer({ root: REPO_ROOT, server: { open: false }, logLevel: 'warn' });
  await devServer.listen();
  const devUrl = devServer.resolvedUrls?.local?.[0];
  if (!devUrl) throw new Error('Vite did not report a local URL');

  await buildProduction();
  const previewServer = await preview({
    root: REPO_ROOT,
    logLevel: 'warn',
    preview: { open: false, host: '127.0.0.1', port: 0 },
  });
  const previewUrl = previewServer.resolvedUrls?.local?.[0];
  if (!previewUrl) throw new Error('Vite preview did not report a local URL');

  process.env.NOTEFORGE_E2E_DEV_URL = devUrl;
  process.env.NOTEFORGE_E2E_PREVIEW_URL = previewUrl;
  await warmDevServer(devServer, devUrl);

  return async () => {
    await devServer.close();
    await new Promise((resolve) => previewServer.httpServer.close(resolve));
  };
}
