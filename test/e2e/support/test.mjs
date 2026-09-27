// Playwright Test with the suite's shared fixtures.
//
// `runtimeErrors` collects console errors, page errors, failed requests, and
// HTTP 4xx/5xx from every page a test registers with `captureRuntimeErrors`, and
// fails the test at teardown if any occurred, as the old runner did.
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take their dependencies by destructuring.
  runtimeErrors: async ({}, use, testInfo) => {
    const errors = [];
    await use(errors);
    if (errors.length) {
      await testInfo.attach('runtime-errors.txt', { body: errors.join('\n'), contentType: 'text/plain' });
    }
    expect(errors, 'unexpected browser console, page, or network errors').toEqual([]);
  },
});

export { expect };
