import assert from 'node:assert/strict';
import { captureRuntimeErrors, newAppContext, TIMEOUT } from './runtime.mjs';

/**
 * Disposable profile whose first application open is the caller's. Activation is
 * automatic since NF-DUR-MIG-01 = C, so the caller's first page activates the
 * vault and creates the ordinary first-run notes, as a new user's would. A
 * worker-enabled profile gets the production worker installed and controlling
 * first, from a blank page inside its scope that never runs the application.
 * No production instance receives a test-only flag or a bypass URL.
 */
export async function activatedAppContext(browser, url, options = {}, runtimeErrors = []) {
  const context = await newAppContext(browser, options);
  if (options.serviceWorkers !== 'allow') return context;
  try {
    const seed = await context.newPage();
    captureRuntimeErrors(seed, runtimeErrors);
    const blank = new URL('__fixture-worker.html', url).href;
    await seed.route(blank, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Worker fixture</title>' }),
    );
    await seed.goto(blank, { waitUntil: 'load', timeout: TIMEOUT });
    await seed.evaluate(async (scope) => {
      const registration = await navigator.serviceWorker.register(new URL('sw.js', scope).href, { scope });
      await navigator.serviceWorker.ready;
      if (registration.active?.state !== 'activated')
        await new Promise((resolve) => registration.active.addEventListener('statechange', resolve, { once: true }));
    }, new URL('.', url).href);
    // Keep the worker's first client alive until it claims that client. Otherwise
    // closing the page can race the caller's navigation.
    await seed.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 20_000 });
    const before = await seed.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('my-notes-app');
          request.onupgradeneeded = () => {
            request.transaction.abort();
            resolve('absent');
          };
          request.onsuccess = () => {
            request.result.close();
            resolve('present');
          };
          request.onerror = () => (request.error?.name === 'AbortError' ? resolve('absent') : reject(request.error));
        }),
    );
    assert.equal(before, 'absent', 'installing the worker must not create the vault');
    await seed.close();
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
