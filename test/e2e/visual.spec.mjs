// Screenshot baselines of the production build: shell, the open overflow
// menu, the slash menu, command palette, settings, and Trash, in both themes,
// at 390, 768, 1440, 1920, and 2560 px. Font rasterization differs between
// operating systems, so baselines are rendered and compared only inside the pinned
// mcr.microsoft.com/playwright container (CI job `visual`, which sets
// NOTEFORGE_VISUAL=1). To regenerate after an intended UI change, run the
// `visual-baselines` workflow on the branch and commit its artifact
// (docs/implementation/release_checklist.md).
import { openSurface } from './support/surfaces.mjs';
import { expect, test } from './support/test.mjs';

test.skip(
  !process.env.NOTEFORGE_VISUAL,
  'Visual baselines are compared only in the pinned Playwright container (CI job `visual`).',
);

const SHOTS = ['shell', 'menu', 'slash-menu', 'palette', 'settings', 'trash'];

for (const theme of ['light', 'dark']) {
  for (const viewport of [390, 768, 1440, 1920, 2560]) {
    for (const surface of SHOTS) {
      test(`${surface} · ${theme} · ${viewport}`, async ({ browser, runtimeErrors }) => {
        const { context, page } = await openSurface(browser, { viewport, theme, surface, runtimeErrors });
        try {
          await expect(page).toHaveScreenshot(`${surface}-${theme}-${viewport}.png`, {
            animations: 'disabled',
            caret: 'hide',
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}
