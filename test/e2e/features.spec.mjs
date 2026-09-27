// The in-page feature suite (test/features.html): component, editor, view, and
// golden-render checks that run inside one page against the Vite dev server. The
// page publishes `ALL PASS (n)` or `FAILURES: k of n` to document.title and one
// PASS/FAIL line per check to #out.
import { captureRuntimeErrors, devUrl, newAppContext, TIMEOUT } from './support/runtime.mjs';
import { expect, test } from './support/test.mjs';

// Raise when checks are added; a refactor that silently drops checks fails here.
const CHECK_FLOOR = 450;

// Banner/image checks use these reserved hosts to exercise URL handling. Stub
// them so the suite stays offline and expected image failures do not look like
// real resource errors.
const GIF = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');

test('in-page feature suite (test/features.html)', async ({ browser, runtimeErrors }, testInfo) => {
  const context = await newAppContext(browser);
  try {
    const page = await context.newPage();
    await page.route(/^https:\/\/(?:example\.com|invalid\.invalid)\//, (route) =>
      route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }),
    );
    captureRuntimeErrors(page, runtimeErrors);
    await page.goto(new URL('test/features.html', devUrl()).href, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => /^(ALL PASS|FAILURES)/.test(document.title), undefined, { timeout: TIMEOUT });
    const output = (await page.locator('#out').textContent({ timeout: TIMEOUT })) || '';
    await testInfo.attach('features-output.txt', { body: output, contentType: 'text/plain' });

    const checks = output.split('\n').slice(1).filter(Boolean);
    const failures = checks.filter((line) => !line.startsWith('PASS'));
    testInfo.annotations.push({
      type: 'checks',
      description: `${checks.length - failures.length} of ${checks.length} passed`,
    });
    expect(failures, `${failures.length} in-page check(s) failed`).toEqual([]);
    expect(checks.length, `in-page check count fell below the floor of ${CHECK_FLOOR}`).toBeGreaterThanOrEqual(
      CHECK_FLOOR,
    );
  } finally {
    await context.close();
  }
});
