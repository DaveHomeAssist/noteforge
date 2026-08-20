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
import { readFile } from 'node:fs/promises';
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

async function warmLazyAppModules(browser, base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const modules = [
    '/src/components/history-view.js',
    '/src/components/backup-view.js',
    '/src/components/link-tools-view.js',
    '/src/components/outline-view.js',
    '/src/components/archive-view.js',
    '/src/components/bulk-actions-view.js',
    '/src/components/command-palette.js',
    '/src/components/find-replace-view.js',
    '/src/components/graph.js',
    '/src/components/saved-searches-view.js',
    '/src/components/settings-view.js',
    '/src/components/trash-view.js',
    '/src/components/quick-capture-view.js',
    '/src/components/task-dashboard-view.js',
    '/src/components/calendar-view.js',
    '/src/components/block-editor-phase5.js',
    '/src/components/properties-view.js',
    '/src/app/phase4.js',
    '/src/app/phase5.js',
    '/src/core/capture-service.js',
    '/src/core/task-service.js',
    '/src/core/revision-store.js',
    '/src/core/recovery-service.js',
    '/src/core/backup.js',
    '/src/core/knowledge-index.js',
    '/src/core/knowledge-index.css',
    '/src/utils/navigation.js',
    '/src/utils/local-date.js',
    '/src/utils/daily-workflow.js',
    '/src/utils/capture.js',
    '/src/utils/tasks.js',
    '/src/utils/calendar.js',
    '/src/utils/frontmatter.js',
    '/src/utils/block-links.js',
    '/src/utils/transclusion.js',
  ];
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    for (const modulePath of modules) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
          await page.evaluate(() => window.app.ready);
          await page.evaluate((path) => import(path), modulePath);
          break;
        } catch (error) {
          if (!/Execution context was destroyed|navigation|timeout|closed|connection refused/i.test(error?.message || '') || attempt === 2) throw error;
          // Dependency optimisation can briefly replace the document or restart
          // the dev listener. Re-enter the app instead of waiting forever on the
          // stale error document left by that transient response.
          let restored = false;
          for (let retry = 0; retry < 20 && !restored; retry += 1) {
            try {
              await page.goto(base, { waitUntil: 'load', timeout: 10_000 });
              restored = true;
            } catch {
              await page.waitForTimeout(250);
            }
          }
          if (!restored) throw error;
        }
      }
    }
    // Vite may schedule its one-time optimizer reload just after the import
    // promise resolves. Let it settle while this throwaway page still exists.
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
  } finally {
    await context.close();
  }
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
    // Phase 5 may perform a one-time revision-protected alias migration after
    // first paint. Let that safe startup write settle before this smoke asserts
    // that its own editor bytes are still inside the autosave debounce window.
    await page.waitForFunction(() => Boolean(window.app?.phase5), undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.phase5Ready);
    await page.locator('.note-item').first().waitFor({ state: 'visible' });
    check('390px app shell has no horizontal document overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    stage = 'persisting an edit';
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

async function runLinkIntegritySmoke(browser, base, runtimeErrors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Link-integrity smoke failed: ${name}`);
    checks.push(`PASS  ${name}`);
  };
  let stage = 'booting the app';
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.waitForFunction(() => Boolean(window.app?.recovery), undefined, { timeout: TIMEOUT });
    await page.evaluate(() => Promise.all([
      window.app.db.initializeKnowledgeIndex(),
      window.app.editor.enableOutline(),
    ]));
    // Both helpers are idle-loaded in the real app. Vite may complete their
    // promises just before its dependency optimizer issues a one-time reload.
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);

    stage = 'creating the Phase 2 fixture';
    await page.evaluate(async () => {
      const target = window.app.db.createNote({
        id: 'phase2-target',
        title: 'Phase2 Target',
        aliases: ['Previous Phase2'],
        content: '# Repeat\n\n## Repeat\n\n#### Café\n\n###### Final',
      });
      window.app.db.createNote({
        id: 'phase2-source',
        title: 'Phase2 Source',
        content: '# Source context\n[[Phase2 Target|shown]]\nPhase2 Target appears in prose.\n`[[Phase2 Target]]`\n[[Previous Phase2]]',
      });
      await window.app.db.flush();
      window.app.openNote(target.id);
    });
    await page.locator('.editor__title').waitFor({ state: 'visible' });
    check('390px Phase 2 editor and navigation chrome have no horizontal overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check('contextual backlinks and unlinked mentions render from one live index',
      await page.locator('.backlinks__item').count() === 2
      && await page.locator('.mention-convert').count() === 1
      && /Source context/.test(await page.locator('.backlinks').innerText()));

    stage = 'jumping through the mobile heading outline';
    await page.locator('.outline__summary').click();
    check('mobile outline exposes deterministic duplicate heading anchors',
      await page.locator('.outline__item').evaluateAll((items) => items.map((item) => item.dataset.outlineAnchor).join(','))
        === 'heading-repeat,heading-repeat-2,heading-café,heading-final');
    await page.locator('[data-outline-anchor="heading-final"]').click();
    check('outline click lands focus on the exact rendered heading after editor render',
      await page.evaluate(() => document.activeElement?.id === 'heading-final'));

    stage = 'previewing and applying a rename-safe title edit';
    await page.locator('.editor__title').fill('Phase2 Atlas');
    await page.locator('.editor__title').press('Enter');
    await page.locator('#link-tools-overlay').waitFor({ state: 'visible' });
    check('full-app rename preview reports exact protected notes and links before mutation',
      /1 exact inbound link across 2 protected notes/.test(await page.locator('#link-tools-overlay').innerText())
      && await page.evaluate(() => window.app.db.getNote('phase2-target')?.title === 'Phase2 Target'));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, bubbles: true, cancelable: true,
    })));
    check('command-palette shortcut cannot stack a second modal over Link tools',
      await page.locator('#palette-overlay').isHidden());
    await page.locator('#link-tools-apply').click();
    await page.waitForFunction(() => /Rename completed/.test(document.querySelector('#link-tools-status')?.textContent || ''));
    check('full-app rename atomically rewrites links, preserves excluded code, and resolves old aliases',
      await page.evaluate(() => {
        const target = window.app.db.getNote('phase2-target');
        const source = window.app.db.getNote('phase2-source');
        return target?.title === 'Phase2 Atlas'
          && target.aliases.includes('Phase2 Target')
          && target.aliases.includes('Previous Phase2')
          && source?.content.includes('[[Phase2 Atlas|shown]]')
          && source.content.includes('`[[Phase2 Target]]`')
          && source.content.includes('[[Previous Phase2]]')
          && window.app.db.resolveTitle('Phase2 Target')?.id === target.id
          && window.app.db.resolveTitle('Previous Phase2')?.id === target.id;
      }));
    check('full-app rename captured pre-change revisions for every protected note',
      await page.evaluate(async () => {
        const batches = await Promise.all([
          window.app.recovery.listRevisions('phase2-target'),
          window.app.recovery.listRevisions('phase2-source'),
        ]);
        return batches.every((revisions) => revisions.some((revision) => revision.reason === 'pre_rename'));
      }));
    await page.keyboard.press('Escape');
    check('closing the rename dialog restores focus to the re-rendered title control',
      await page.evaluate(() => document.activeElement?.classList.contains('editor__title')));

    stage = 'previewing and applying an unlinked mention';
    await page.locator('.mention-convert').click();
    await page.locator('#link-tools-overlay').waitFor({ state: 'visible' });
    check('full-app mention conversion preview names source, target, heading, and exact edit',
      /Phase2 Source/.test(await page.locator('#link-tools-overlay').innerText())
      && /Phase2 Atlas/.test(await page.locator('#link-tools-overlay').innerText())
      && /Source context/.test(await page.locator('#link-tools-overlay').innerText())
      && /No data changes until/.test(await page.locator('#link-tools-overlay').innerText()));
    await page.locator('#link-tools-apply').click();
    await page.waitForFunction(() => /Mention converted/.test(document.querySelector('#link-tools-status')?.textContent || ''));
    check('full-app mention conversion edits one exact source range with a safety revision',
      await page.evaluate(async () => {
        const source = window.app.db.getNote('phase2-source');
        const revisions = await window.app.recovery.listRevisions('phase2-source');
        return source?.content.includes('[[Phase2 Atlas|Phase2 Target]] appears in prose.')
          && revisions.some((revision) => revision.reason === 'pre_link_conversion');
      }));
    await page.keyboard.press('Escape');

    stage = 'using back and forward navigation';
    await page.locator('.backlinks__item').first().click();
    await page.waitForFunction(() => window.app.currentId === 'phase2-source');
    check('alias and canonical links render as resolved after rename',
      await page.locator('a.wikilink--missing').count() === 0
      && await page.locator('a[data-wikilink]').count() >= 3);
    await page.locator('#mobile-nav-back').click();
    await page.waitForFunction(() => window.app.currentId === 'phase2-target');
    await page.locator('#mobile-nav-forward').click();
    await page.waitForFunction(() => window.app.currentId === 'phase2-source');
    check('mobile Back and Forward replay history without duplicate entries',
      await page.evaluate(() => window.app.navigation.current === 'phase2-source'
        && window.app.navigation.back.at(-1) === 'phase2-target'
        && window.app.navigation.forward.length === 0));

    stage = 'importing an ambiguous alias for repair reporting';
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#import-file').setInputFiles({
      name: 'phase2-alias-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{
        id: 'external-id',
        title: 'Imported ambiguous alias',
        content: '# Imported',
        aliases: ['Phase2 Atlas'],
      }])),
    });
    await page.locator('#link-tools-overlay').waitFor({ state: 'visible' });
    check('merge import preserves aliases and opens the ambiguity repair report instead of guessing',
      await page.evaluate(() => {
        const imported = window.app.db.getAllNotes().find((note) => note.title === 'Imported ambiguous alias');
        return imported?.aliases[0] === 'Phase2 Atlas'
          && window.app.db.resolveTitle('Phase2 Atlas')?.id === 'phase2-target';
      })
      && /Title and alias collision/.test(await page.locator('#link-tools-overlay').innerText()));
    await page.keyboard.press('Escape');

    stage = 'verifying persisted recents after reload';
    await page.evaluate(() => window.app.db.flush());
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    check('persisted recents survive reload while session history starts without a duplicate reload entry',
      await page.evaluate(() => window.app.recentNoteIds.slice(0, 2).join(',') === 'phase2-source,phase2-target'
        && window.app.navigation.back.length === 0));
    await page.locator('#sidebar-toggle').click();
    await page.locator('#menu-btn').click();
    await page.locator('#palette-btn').click();
    check('command palette presents persisted recent-note order after reload',
      /Phase2 Source/.test(await page.locator('.palette__item').first().innerText()));
    return checks.join('\n');
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      currentId: window.app?.currentId,
      navigation: window.app?.navigation,
      recents: window.app?.recentNoteIds,
      linkStatus: document.querySelector('#link-tools-status')?.textContent || '',
      linkText: document.querySelector('#link-tools-overlay')?.innerText || '',
    })).catch(() => null);
    throw new Error(`Link-integrity smoke failed while ${stage}: ${error?.message || error}; diagnostics: ${JSON.stringify(diagnostics)}`);
  } finally {
    await context.close();
  }
}

async function runPhase3Smoke(browser, base, runtimeErrors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Phase 3 smoke failed: ${name}`);
    checks.push(`PASS  ${name}`);
  };
  const openSidebar = async () => {
    if (!await page.evaluate(() => document.querySelector('#app')?.classList.contains('sidebar-open'))) {
      await page.locator('#sidebar-toggle').click();
      await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    }
  };
  let stage = 'booting the app';
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.waitForFunction(() => Boolean(window.app?.recovery && window.app?.savedSearches), undefined, { timeout: TIMEOUT });

    stage = 'creating the Phase 3 fixture';
    await page.evaluate(async () => {
      const db = window.app.db;
      db.createNote({ id: 'phase3-current', title: 'Phase3 Current', content: 'alpha $& alpha' });
      db.createNote({ id: 'phase3-vault', title: 'Phase3 Vault', content: 'needle needle' });
      db.createNote({ id: 'phase3-unchanged', title: 'Phase3 Unchanged', content: 'other' });
      db.createNote({ id: 'phase3-archived', title: 'Phase3 Archived', content: 'needle', archivedAt: '2026-08-20T12:00:00.000Z' });
      const trash = db.createNote({ id: 'phase3-trash', title: 'Phase3 Trash', content: 'needle' });
      db.deleteNote(trash.id);
      db.createNote({ id: 'phase3-batch-a', title: 'Phase3 Batch A', content: 'batch one' });
      db.createNote({ id: 'phase3-batch-b', title: 'Phase3 Batch B', content: 'batch two' });
      db.createNote({ id: 'phase3-parent', title: 'Phase3 Parent', content: 'parent' });
      db.createNote({ id: 'phase3-child', title: 'Phase3 Child', content: 'child', parentId: 'phase3-parent' });
      await db.flush();
      window.app.openNote('phase3-current');
    });
    await page.locator('.editor__title').waitFor({ state: 'visible' });

    stage = 'previewing current-note replacement';
    await page.keyboard.press('Control+f');
    await page.locator('#find-replace-panel').waitFor({ state: 'visible' });
    await page.locator('#find-input').fill('alpha');
    await page.locator('#replace-input').fill('$&\\done');
    await page.locator('[data-find-preview]').click();
    check('integrated current-note replace previews exact source count without mutation',
      /2 source matches/.test(await page.locator('.find-replace__preview').innerText())
      && await page.evaluate(() => window.app.db.getNote('phase3-current')?.content === 'alpha $& alpha'));
    await page.locator('[data-find-apply]').click();
    await page.waitForFunction(() => window.app.db.getNote('phase3-current')?.content === '$&\\done $& $&\\done');
    check('integrated current-note replace keeps replacement syntax literal and announces completion',
      /2 replacements applied/.test(await page.locator('.find-replace__status').innerText()));
    await page.locator('[data-find-close]').click();
    await page.locator('.blk[contenteditable="true"]').first().focus();
    await page.keyboard.press('Control+z');
    await page.evaluate(async () => { window.app.editor.flushPending(); await window.app.db.flush(); });
    check('integrated current-note replace remains one undo step',
      await page.evaluate(() => window.app.db.getNote('phase3-current')?.content === 'alpha $& alpha'));

    stage = 'previewing and applying vault replacement';
    await page.keyboard.press('Control+f');
    await page.locator('[data-scope="vault"]').click();
    await page.locator('#find-input').fill('needle');
    await page.locator('#replace-input').fill('done');
    await page.locator('[data-find-preview]').click();
    const previewText = await page.locator('.find-replace__preview').innerText();
    check('integrated vault replace preview reports active changes and Archive/Trash skips',
      /1 changed/.test(previewText) && /2 skipped/.test(previewText)
      && await page.evaluate(() => window.app.db.getNote('phase3-vault')?.content === 'needle needle'));
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-find-apply]').click();
    await page.waitForFunction(() => /0 failed/.test(document.querySelector('.find-replace__status')?.textContent || ''));
    check('integrated vault replace applies atomically with a pre-change revision',
      await page.evaluate(async () => {
        const revisions = await window.app.recovery.listRevisions('phase3-vault');
        return window.app.db.getNote('phase3-vault')?.content === 'done done'
          && window.app.db.getArchivedNote('phase3-archived')?.content === 'needle'
          && window.app.db.notes.get('phase3-trash')?.content === 'needle'
          && revisions.some((revision) => revision.reason === 'pre_bulk_replace');
      }));
    await page.locator('[data-find-close]').click();

    stage = 'exporting Archive metadata through the merge-export flow';
    await openSidebar();
    await page.locator('#menu-btn').click();
    const [mergeExport] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-btn').click(),
    ]);
    const exportedNotes = JSON.parse(await readFile(await mergeExport.path(), 'utf8'));
    check('legacy JSON export preserves archivedAt while leaving Trash to portable backup',
      exportedNotes.some((note) => note.id === 'phase3-archived' && note.archivedAt === '2026-08-20T12:00:00.000Z')
      && !exportedNotes.some((note) => note.id === 'phase3-trash'));

    stage = 'creating and running a saved view';
    await openSidebar();
    await page.locator('#search-input').fill('phase3 batch');
    await page.locator('#sort-select').selectOption('title');
    await page.locator('[data-saved-create]').click();
    await page.locator('#saved-searches-overlay').waitFor({ state: 'visible' });
    await page.locator('.saved-searches-form [name="name"]').fill('Phase3 batch work');
    await page.locator('.saved-searches-form [name="icon"]').fill('🧭');
    await page.locator('.saved-searches-form button[type="submit"]').click();
    check('integrated saved view persists stable query, sort, icon, and order',
      await page.evaluate(() => {
        const record = window.app.db.config.savedSearches?.[0];
        return Boolean(record?.id) && record.name === 'Phase3 batch work' && record.icon === '🧭'
          && record.query === 'phase3 batch' && record.sortMode === 'title' && record.order === 0;
      }));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await page.locator('#palette-input').fill('> run saved view phase3');
    await page.locator('.palette__item').first().waitFor({ state: 'visible' });
    check('integrated command palette exposes the saved view',
      /Run saved view: Phase3 batch work/.test(await page.locator('.palette__item').first().innerText()));
    await page.locator('#palette-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#search-input')?.value === 'phase3 batch');
    check('running a saved view restores its complete search state',
      await page.evaluate(() => window.app.noteList.getSearchState().query === 'phase3 batch'
        && window.app.noteList.getSearchState().sortMode === 'title'));

    stage = 'importing archived hierarchy';
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#import-file').setInputFiles({
      name: 'phase3-archive-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([
        { id: 'external-archive-parent', title: 'Phase3 Imported Archive Parent', content: '', archivedAt: '2026-08-20T12:00:00.000Z' },
        { id: 'external-archive-child', title: 'Phase3 Imported Archive Child', content: '', parentId: 'external-archive-parent', archivedAt: '2026-08-20T12:00:00.000Z' },
      ])),
    });
    await page.waitForFunction(() => window.app.db.getArchived().some((note) => note.title === 'Phase3 Imported Archive Child'));
    check('merge import preserves archivedAt and remaps archived parent-child hierarchy',
      await page.evaluate(() => {
        const parent = window.app.db.getArchived().find((note) => note.title === 'Phase3 Imported Archive Parent');
        const child = window.app.db.getArchived().find((note) => note.title === 'Phase3 Imported Archive Child');
        return Boolean(parent && child && child.parentId === parent.id);
      }));

    stage = 'applying batch tag and Trash actions';
    await openSidebar();
    await page.locator('.note-item[data-id="phase3-batch-a"] [data-select]').click();
    await page.locator('.note-item[data-id="phase3-batch-b"] [data-select]').click();
    await page.locator('.bulk-actions').waitFor({ state: 'visible' });
    await page.locator('[data-bulk-tag]').fill('reviewed');
    await page.locator('[data-bulk-action="tag"]').click();
    await page.waitForFunction(() => window.app.db.getNote('phase3-batch-a')?.tags.includes('reviewed')
      && window.app.db.getNote('phase3-batch-b')?.tags.includes('reviewed'));
    check('integrated multi-select batch tag updates exact IDs with safety revisions',
      await page.evaluate(async () => {
        const revisions = await window.app.recovery.listRevisions('phase3-batch-a');
        return revisions.some((revision) => revision.reason === 'pre_bulk_action');
      }));
    await page.locator('.note-item[data-id="phase3-batch-a"] [data-select]').click();
    await page.locator('.note-item[data-id="phase3-batch-b"] [data-select]').click();
    await page.locator('.bulk-actions').waitFor({ state: 'visible' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-bulk-action="trash"]').click();
    await page.waitForFunction(() => !window.app.db.getNote('phase3-batch-a') && !window.app.db.getNote('phase3-batch-b'));
    check('integrated destructive batch requires confirmation and moves only selected notes to Trash',
      await page.evaluate(() => window.app.db.notes.get('phase3-batch-a')?.isTrashed
        && window.app.db.notes.get('phase3-batch-b')?.isTrashed
        && Boolean(window.app.db.getNote('phase3-current'))));

    stage = 'archiving and restoring a parent note';
    await page.evaluate(() => {
      window.app.noteList.applySearchState({ query: '', sortMode: 'updated' });
      window.app.openNote('phase3-parent');
    });
    await page.keyboard.press('Control+p');
    await page.locator('#palette-input').fill('> archive current note');
    await page.locator('#palette-input').press('Enter');
    await page.waitForFunction(() => Boolean(window.app.db.getArchivedNote('phase3-parent')));
    check('integrated Archive removes the parent from active identity while promoting its child',
      await page.evaluate(() => window.app.db.resolveTitle('Phase3 Parent') === null
        && window.app.db.getNote('phase3-child')?.parentId === 'phase3-parent'));
    await openSidebar();
    await page.locator('#menu-btn').click();
    await page.locator('#archive-btn').click();
    await page.locator('#archive-overlay').waitFor({ state: 'visible' });
    await page.locator('.archive-item[data-id="phase3-parent"] [data-preview]').click();
    check('integrated Archive view previews the exact selected note in a labelled modal',
      /Phase3 Parent/.test(await page.locator('#archive-preview').innerText())
      && await page.evaluate(() => document.querySelector('#archive-overlay')?.contains(document.activeElement)));
    await page.locator('#archive-preview [data-unarchive-preview]').click();
    await page.waitForFunction(() => window.app.currentId === 'phase3-parent' && Boolean(window.app.db.getNote('phase3-parent')));
    check('integrated Unarchive restores the retained parent-child hierarchy and opens the note',
      await page.evaluate(() => window.app.db.ancestorsOf('phase3-child').map((note) => note.id).join(',') === 'phase3-parent'));

    stage = 'verifying persistence and mobile layout';
    await page.evaluate(() => window.app.db.flush());
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.waitForFunction(() => Boolean(window.app?.savedSearches), undefined, { timeout: TIMEOUT });
    check('saved views and Phase 3 lifecycle state survive reload exactly',
      await page.evaluate(() => window.app.db.config.savedSearches?.[0]?.name === 'Phase3 batch work'
        && window.app.db.notes.get('phase3-batch-a')?.isTrashed
        && Boolean(window.app.db.getNote('phase3-parent'))));
    check('390px Phase 3 controls have no horizontal document overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    return checks.join('\n');
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      currentId: window.app?.currentId,
      query: document.querySelector('#search-input')?.value || '',
      findStatus: document.querySelector('.find-replace__status')?.textContent || '',
      bulkStatus: document.querySelector('.bulk-actions__status')?.textContent || '',
      archiveStatus: document.querySelector('#archive-status')?.textContent || '',
    })).catch(() => null);
    throw new Error(`Phase 3 smoke failed while ${stage}: ${error?.message || error}; diagnostics: ${JSON.stringify(diagnostics)}`);
  } finally {
    await context.close();
  }
}

async function runPhase4Smoke(browser, base, runtimeErrors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route('**/src/utils/daily-workflow.js*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  }, { times: 1 });
  await page.addInitScript(() => {
    window.__phase4Clipboard = { value: 'Clipboard browser text', fail: false };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          if (window.__phase4Clipboard.fail) throw new Error('permission denied');
          return window.__phase4Clipboard.value;
        },
      },
    });
  });
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Phase 4 smoke failed: ${name}`);
    checks.push(`PASS  ${name}`);
  };
  const openSidebar = async () => {
    const state = await page.evaluate(() => ({
      mobile: matchMedia('(max-width: 760px)').matches,
      open: document.querySelector('#app')?.classList.contains('sidebar-open'),
    }));
    if (state.mobile && !state.open) {
      await page.locator('#sidebar-toggle').click();
      await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    }
  };
  const openMenuAction = async (selector) => {
    await openSidebar();
    await page.locator('#menu-btn').click();
    await page.locator(selector).click();
  };
  let stage = 'booting the app';
  let dates = null;
  let firstDailyId = null;
  let emptyDailyDate = null;
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);

    stage = 'creating the Phase 4 fixture';
    dates = await page.evaluate(async () => {
      const key = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const day = (offset) => {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() + offset);
        return key(date);
      };
      const result = { today: day(0), overdue: day(-1), tomorrow: day(1), upcoming: day(7) };
      const db = window.app.db;
      db.createNote({
        id: 'phase4-task-source', title: 'Phase4 Task Source', tags: ['phase4'],
        content: `# Work\n- [ ] Duplicate task\n- [ ] Duplicate task\n- [ ] Today source task @due(${result.today})\n- [ ] Late source task @due(${result.overdue})\n- [ ] Upcoming source task @due(${result.upcoming})\n- [ ] No date source task\n- [x] Finished source task @due(${result.today})`,
      });
      db.createNote({ id: 'phase4-calendar-event', title: 'Phase4 Calendar Event', content: `@date(${result.tomorrow})`, tags: [] });
      db.createNote({ id: 'phase4-archived-task', title: 'Phase4 Archived Task', content: '- [ ] Hidden archived task', archivedAt: new Date().toISOString() });
      const trashed = db.createNote({ id: 'phase4-trashed-task', title: 'Phase4 Trashed Task', content: '- [ ] Hidden trashed task' });
      db.deleteNote(trashed.id);
      await db.flush();
      return result;
    });

    stage = 'creating and reopening Today through the mobile menu';
    const outgoingId = await page.evaluate(() => window.app.currentId);
    await openMenuAction('#today-btn');
    await page.locator('.blk[contenteditable="true"]').first().fill('Typed during Daily lazy initialization');
    await page.waitForFunction((today) => window.app.db.getNote(window.app.currentId)?.title === today, dates.today);
    firstDailyId = await page.evaluate(() => window.app.currentId);
    check('Open Today’s Note flushes first-use edits and creates the exact local-date Daily template',
      await page.evaluate(({ today, outgoingId }) => {
        const note = window.app.db.getNote(window.app.currentId);
        return note?.title === today
          && note.content === `@date(${today})\n\n## Notes\n\n\n## Tasks\n- [ ] `
          && window.app.db.getNote(outgoingId)?.content.includes('Typed during Daily lazy initialization')
          && window.app.db.getPersistenceStatus().pendingWrites === 0;
      }, { today: dates.today, outgoingId }));
    await openMenuAction('#today-btn');
    await page.waitForFunction((id) => window.app.currentId === id, firstDailyId);
    check('repeated Today invocation reopens one live note without duplication',
      await page.evaluate((today) => window.app.db.getAllNotes().filter((note) => note.title === today).length === 1, dates.today));

    stage = 'exercising explicit Trash cancellation and restore for Today';
    await page.evaluate(async (id) => { window.app.db.deleteNote(id); await window.app.db.flush(); }, firstDailyId);
    let dailyDialogChoice = 'dismiss';
    const handleDailyDialog = (dialog) => dailyDialogChoice === 'accept' ? dialog.accept() : dialog.dismiss();
    page.on('dialog', handleDailyDialog);
    await openMenuAction('#today-btn');
    await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#app-status')?.textContent || ''));
    check('trashed Today requires an explicit restore choice and cancellation leaves it in Trash',
      await page.evaluate((id) => Boolean(window.app.db.notes.get(id)?.isTrashed), firstDailyId));
    dailyDialogChoice = 'accept';
    await openMenuAction('#today-btn');
    await page.waitForFunction((id) => window.app.currentId === id
      && Boolean(window.app.db.getNote(id))
      && /Restored and opened/.test(document.querySelector('#app-status')?.textContent || ''), firstDailyId);
    page.off('dialog', handleDailyDialog);
    check('confirmed Today restore reuses the original note ID and announces completion',
      await page.evaluate((id) => window.app.currentId === id && /Restored and opened/.test(document.querySelector('#app-status')?.textContent || ''), firstDailyId));

    stage = 'capturing text, URL, and clipboard content to the default Inbox';
    await openSidebar();
    await page.locator('#capture-btn').click();
    await page.locator('#quick-capture-overlay').waitFor({ state: 'visible' });
    check('Quick Capture defaults to Inbox with labelled focus and no 390px overflow',
      await page.evaluate(() => (
        document.querySelector('#capture-destination')?.value === 'inbox'
        && document.querySelector('#quick-capture-overlay')?.contains(document.activeElement)
        && document.documentElement.scrollWidth <= window.innerWidth
      )));
    await page.locator('#capture-title').fill('Captured reference');
    await page.locator('#capture-text').fill('Captured browser text');
    await page.locator('#capture-url').fill('https://example.com/phase4');
    await page.locator('[data-read-clipboard]').click();
    await page.waitForFunction(() => document.querySelector('#capture-text')?.value.includes('Clipboard browser text'));
    await page.locator('#quick-capture-form [type="submit"]').click();
    await page.waitForFunction(() => /Saved to “Inbox”/.test(document.querySelector('#quick-capture-status')?.textContent || ''));
    check('text, URL, and clipboard capture append exact Markdown through the normal durable queue',
      await page.evaluate(() => {
        const inbox = window.app.db.getAllNotes().find((note) => note.title === 'Inbox');
        return inbox?.content === 'Captured browser text\n\nClipboard browser text\n\n[Captured reference](https://example.com/phase4)'
          && window.app.db.getPersistenceStatus().pendingWrites === 0;
      }));
    await page.keyboard.press('Escape');

    stage = 'capturing a local image to an arbitrary existing note';
    await openSidebar();
    await page.locator('#capture-btn').click();
    await page.locator('#capture-destination').selectOption('existing:phase4-task-source');
    await page.locator('#capture-text').fill('Local image capture');
    await page.locator('#capture-image').setInputFiles({
      name: 'phase4.svg', mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>'),
    });
    await page.locator('#quick-capture-form [type="submit"]').click();
    await page.waitForFunction(() => window.app.db.getNote('phase4-task-source')?.content.includes('data:image/jpeg'));
    check('local image capture targets an arbitrary note and persists embedded Markdown',
      await page.evaluate(() => /Local image capture\n\n!\[phase4\]\(data:image\/jpeg/.test(window.app.db.getNote('phase4-task-source')?.content || '')));
    await page.keyboard.press('Escape');

    stage = 'capturing to a new destination and handling clipboard denial';
    await openSidebar();
    await page.locator('#capture-btn').click();
    await page.evaluate(() => { window.__phase4Clipboard.fail = true; });
    await page.locator('[data-read-clipboard]').click();
    await page.waitForFunction(() => /Clipboard access was unavailable/.test(document.querySelector('#quick-capture-status')?.textContent || ''));
    check('clipboard denial provides a visible manual-paste fallback', /Paste into the Text field/.test(await page.locator('#quick-capture-status').innerText()));
    await page.locator('#capture-destination').selectOption('new');
    await page.locator('#capture-new-title').fill('Phase4 New Capture');
    await page.locator('#capture-text').fill('New destination bytes');
    await page.locator('#quick-capture-form [type="submit"]').click();
    await page.waitForFunction(() => window.app.db.getAllNotes().some((note) => note.title === 'Phase4 New Capture' && note.content === 'New destination bytes')
      && /Saved to “Phase4 New Capture”/.test(document.querySelector('#quick-capture-status')?.textContent || '')
      && window.app.db.getPersistenceStatus().pendingWrites === 0);
    check('Quick Capture creates and durably commits an explicitly named new destination without changing other notes', true);
    await page.keyboard.press('Escape');

    stage = 'opening the one-shot GET share target';
    const beforeShareCount = await page.evaluate(() => window.app.db.notes.size);
    // Vite reserves a root-level `?url=` request for its own asset handling;
    // use the explicit HTML path while exercising the same browser URL intake.
    const shareUrl = new URL('index.html', base);
    shareUrl.search = new URLSearchParams({
      source: 'share-target', title: 'Shared browser title', text: 'Shared browser text',
      url: 'https://example.com/shared', ignored: 'must-not-enter-vault',
    }).toString();
    await page.goto(shareUrl.href, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.locator('#quick-capture-overlay').waitFor({ state: 'visible' });
    check('GET share target clears its URL, allowlists fields, and never auto-saves',
      await page.evaluate((count) => (
        location.search === ''
        && document.querySelector('#capture-title')?.value === 'Shared browser title'
        && document.querySelector('#capture-text')?.value === 'Shared browser text'
        && document.querySelector('#capture-url')?.value === 'https://example.com/shared'
        && document.querySelector('#capture-destination')?.value === 'inbox'
        && window.app.db.notes.size === count
        && !document.querySelector('#quick-capture-overlay')?.textContent.includes('must-not-enter-vault')
      ), beforeShareCount));
    await page.locator('#quick-capture-form [type="submit"]').click();
    await page.waitForFunction(() => window.app.db.getAllNotes().find((note) => note.title === 'Inbox')?.content.includes('Shared browser text'));
    await page.keyboard.press('Escape');

    stage = 'grouping and mutating source-verified tasks';
    await openMenuAction('#tasks-btn');
    await page.locator('#task-dashboard-overlay').waitFor({ state: 'visible' });
    const taskText = await page.locator('#task-dashboard-overlay').innerText();
    check('task dashboard exposes all local-date groups while excluding Archive and Trash',
      /Today/.test(taskText) && /Overdue/.test(taskText) && /Upcoming/.test(taskText)
      && /No date/.test(taskText) && /Completed/.test(taskText)
      && !/Hidden archived task|Hidden trashed task/.test(taskText));
    const duplicates = page.locator('.task-card').filter({ hasText: 'Duplicate task' });
    check('duplicate task text remains separately addressable', await duplicates.count() === 2);
    await duplicates.nth(1).locator('[data-task-toggle]').check();
    await page.waitForFunction(() => window.app.db.getNote('phase4-task-source')?.content.includes('- [ ] Duplicate task\n- [x] Duplicate task'));
    check('task toggle edits only the verified duplicate occurrence and announces durable success',
      /Saved “Duplicate task”/.test(await page.locator('#task-dashboard-status').innerText()));
    const todayCard = page.locator('.task-card').filter({ hasText: 'Today source task' });
    await todayCard.locator('[data-task-due]').fill(dates.upcoming);
    await page.waitForFunction((due) => window.app.db.getNote('phase4-task-source')?.content.includes(`Today source task @due(${due})`), dates.upcoming);
    check('task due editing changes only the terminal source marker and creates a safety revision',
      await page.evaluate(async () => {
        const reasons = (await window.app.recovery.listRevisions('phase4-task-source')).map((revision) => revision.reason);
        return reasons.includes('quick_capture') && reasons.includes('pre_task_change');
      }));
    await page.locator('#task-group-filter').selectOption('completed');
    check('task group filter exposes the completed source state', /Finished source task/.test(await page.locator('#task-dashboard-list').innerText()));
    await page.locator('#task-group-filter').selectOption('all');
    await page.locator('.task-card').filter({ hasText: 'Today source task' }).locator('[data-task-open]').click();
    await page.waitForFunction(() => window.app.currentId === 'phase4-task-source');
    check('task source control opens the exact note and moves focus to its task block',
      await page.evaluate(() => document.activeElement?.closest('.blk-row')?.dataset.type === 'todo'));

    stage = 'operating the month/week calendar';
    await openMenuAction('#calendar-btn');
    await page.locator('#calendar-overlay').waitFor({ state: 'visible' });
    check('390px Calendar uses an equivalent agenda without clipping',
      await page.evaluate(() => (
        getComputedStyle(document.querySelector('#calendar-agenda')).display !== 'none'
        && document.querySelectorAll('#calendar-grid [data-calendar-item]').length === document.querySelectorAll('#calendar-agenda [data-calendar-item]').length
        && document.documentElement.scrollWidth <= window.innerWidth
      )));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator('[data-calendar-mode="week"]').click();
    check('week view exposes seven labelled grid cells and a polite item summary',
      await page.locator('#calendar-grid [role="gridcell"]').count() === 7
      && await page.locator('#calendar-grid > [role="row"]').count() === 2
      && await page.locator('#calendar-grid').getAttribute('aria-rowcount') === '2'
      && await page.locator('#calendar-status').getAttribute('role') === 'status');
    const startingDate = await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => button.closest('[data-calendar-date]').dataset.calendarDate);
    await page.locator('#calendar-grid [data-day][tabindex="0"]').press('ArrowRight');
    const nextDate = await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => button.closest('[data-calendar-date]').dataset.calendarDate);
    check('calendar roving focus follows Arrow, Home, End, and Page navigation', await page.evaluate(({ startingDate, nextDate }) => {
      const add = (value, amount) => {
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day + amount));
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      };
      return nextDate === add(startingDate, 1) && document.activeElement?.matches('[data-day][tabindex="0"]');
    }, { startingDate, nextDate }));
    await page.locator('#calendar-grid [data-day][tabindex="0"]').press('Home');
    check('calendar Home moves to the first day of the local calendar week',
      await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => new Date(`${button.closest('[data-calendar-date]').dataset.calendarDate}T00:00:00Z`).getUTCDay() === 0));
    await page.locator('#calendar-grid [data-day][tabindex="0"]').press('End');
    check('calendar End moves to the final day of the local calendar week',
      await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => new Date(`${button.closest('[data-calendar-date]').dataset.calendarDate}T00:00:00Z`).getUTCDay() === 6));
    const beforePage = await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => button.closest('[data-calendar-date]').dataset.calendarDate);
    await page.locator('#calendar-grid [data-day][tabindex="0"]').press('PageDown');
    const afterPage = await page.locator('#calendar-grid [data-day][tabindex="0"]').evaluate((button) => button.closest('[data-calendar-date]').dataset.calendarDate);
    check('calendar Page Down advances one week in week mode',
      (new Date(`${afterPage}T00:00:00Z`) - new Date(`${beforePage}T00:00:00Z`)) / 86_400_000 === 7);
    await page.locator('[data-period="today"]').click();
    await page.locator('[data-calendar-mode="month"]').click();
    await page.locator('#calendar-grid [data-calendar-item^="date:phase4-calendar-event:"]').click();
    await page.waitForFunction(() => window.app.currentId === 'phase4-calendar-event');
    check('calendar source link opens the exact note represented by its derived item', true);

    stage = 'creating a Daily note from an empty calendar day';
    await openMenuAction('#calendar-btn');
    emptyDailyDate = await page.evaluate(() => [...document.querySelectorAll('#calendar-grid [data-calendar-date]')]
      .find((cell) => !cell.querySelector('[data-calendar-item]') && !cell.querySelector('[aria-current="date"]'))?.dataset.calendarDate || null);
    if (!emptyDailyDate) throw new Error('No empty calendar day was available in the visible month.');
    await page.locator(`#calendar-grid [data-calendar-date="${emptyDailyDate}"] [data-day]`).click();
    await page.waitForFunction((date) => window.app.db.getNote(window.app.currentId)?.title === date, emptyDailyDate);
    await page.evaluate((date) => window.app.openDailyNote(date), emptyDailyDate);
    check('empty-day action creates one idempotent Daily note',
      await page.evaluate((date) => window.app.db.getAllNotes().filter((note) => note.title === date).length === 1, emptyDailyDate));
    await page.setViewportSize({ width: 640, height: 720 });
    await openMenuAction('#calendar-btn');
    check('Calendar remains readable at a 200%-equivalent CSS viewport',
      await page.evaluate(() => getComputedStyle(document.querySelector('#calendar-agenda')).display !== 'none'
        && document.documentElement.scrollWidth <= window.innerWidth));
    await page.keyboard.press('Escape');

    stage = 'reloading the complete Phase 4 state';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    check('Daily, capture, task, due-date, image, and calendar state survive reload exactly',
      await page.evaluate(({ firstDailyId, upcoming, emptyDailyDate }) => {
        const task = window.app.db.getNote('phase4-task-source');
        const inbox = window.app.db.getAllNotes().find((note) => note.title === 'Inbox');
        return window.app.db.getNote(firstDailyId)?.title
          && task?.content.includes('- [ ] Duplicate task\n- [x] Duplicate task')
          && task?.content.includes(`Today source task @due(${upcoming})`)
          && task?.content.includes('data:image/jpeg')
          && inbox?.content.includes('Shared browser text')
          && window.app.db.getAllNotes().some((note) => note.title === 'Phase4 New Capture')
          && window.app.db.getAllNotes().filter((note) => note.title === emptyDailyDate).length === 1;
      }, { firstDailyId, upcoming: dates.upcoming, emptyDailyDate }));
    check('reloaded 390px Phase 4 shell has no horizontal overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    return checks.join('\n');
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      currentId: window.app?.currentId,
      title: window.app?.db?.getNote?.(window.app?.currentId)?.title || '',
      appStatus: document.querySelector('#app-status')?.textContent || '',
      captureStatus: document.querySelector('#quick-capture-status')?.textContent || '',
      taskStatus: document.querySelector('#task-dashboard-status')?.textContent || '',
      calendarStatus: document.querySelector('#calendar-status')?.textContent || '',
      openOverlay: [...document.querySelectorAll('.modal:not([hidden])')].map((node) => node.id),
    })).catch(() => null);
    throw new Error(`Phase 4 smoke failed while ${stage}: ${error?.message || error}; diagnostics: ${JSON.stringify(diagnostics)}`);
  } finally {
    await context.close();
  }
}

async function runPhase5Smoke(browser, base, runtimeErrors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__phase5Clipboard = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__phase5Clipboard = value; } },
    });
  });
  captureRuntimeErrors(page, runtimeErrors);
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Phase 5 smoke failed: ${name}`);
    checks.push(`PASS  ${name}`);
  };
  let stage = 'booting the app';
  try {
    await page.goto(base, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    await page.waitForFunction(() => Boolean(window.app?.phase5), undefined, { timeout: TIMEOUT });

    stage = 'creating the Phase 5 fixture and migrating aliases';
    await page.evaluate(async () => {
      const db = window.app.db;
      db.createNote({
        id: 'phase5-target', title: 'Phase5 Target', aliases: ['Legacy Phase5'],
        content: '---\n# preserved\nfuture: { keep: true }\n---\nTarget **safe** <img src=x onerror="alert(1)"> ^target',
      });
      db.createNote({
        id: 'phase5-source', title: 'Phase5 Source',
        content: 'Jump [[Legacy Phase5#^target]]\n\nEmbed ![[Phase5 Target#^target]]',
      });
      db.createNote({
        id: 'phase5-cycle', title: 'Phase5 Cycle',
        content: 'Cycle ![[Phase5 Cycle#^self]] ^self',
      });
      db.createNote({
        id: 'phase5-invalid', title: 'Phase5 Invalid', aliases: ['Repair Later'],
        content: '---\naliases: [broken\n---\nBody remains exact',
      });
      await db.flush();
      await window.app.phase5.reconcileAliases();
      await db.flush();
      window.app.openNote('phase5-target');
    });
    check('one-time alias migration preserves unknown YAML and mirrors aliases for Phase 2 compatibility',
      await page.evaluate(() => {
        const note = window.app.db.getNote('phase5-target');
        return note.aliases.join(',') === 'Legacy Phase5'
          && /aliases:\s*\n?\s*- Legacy Phase5|aliases: \[Legacy Phase5\]/.test(note.content)
          && /future: \{ keep: true \}/.test(note.content)
          && /# preserved/.test(note.content);
      }));
    check('malformed alias frontmatter stays byte-exact and is reported for repair',
      await page.evaluate(() => window.app.db.getNote('phase5-invalid').content === '---\naliases: [broken\n---\nBody remains exact'
        && window.app.db.config.frontmatterAliasMigration?.status === 'repair_required'));

    stage = 'editing typed properties on mobile';
    const propertiesTrigger = page.locator('.editor__properties');
    await propertiesTrigger.focus();
    await propertiesTrigger.click();
    await page.locator('#properties-overlay').waitFor({ state: 'visible' });
    check('390px Properties dialog is labelled, focused, trapped, and has no horizontal overflow',
      await page.evaluate(() => document.querySelector('#properties-overlay')?.contains(document.activeElement)
        && document.querySelector('#properties-overlay [role="dialog"]')?.getAttribute('aria-labelledby') === 'properties-title'
        && document.documentElement.scrollWidth <= window.innerWidth));
    await page.locator('.properties-form [name="key"]').fill('priority');
    await page.locator('.properties-form [name="type"]').selectOption('number');
    await page.locator('.properties-form [name="value"]').fill('7');
    await page.locator('.properties-form button[type="submit"]').click();
    await page.waitForFunction(() => /Property saved to Markdown/.test(document.querySelector('#properties-status')?.textContent || ''));
    check('typed property edits persist into YAML without reformatting the Markdown body',
      await page.evaluate(() => {
        const content = window.app.db.getNote('phase5-target').content;
        return /priority: 7/.test(content)
          && content.endsWith('Target **safe** <img src=x onerror="alert(1)"> ^target');
      }));
    await page.locator('.properties-form [name="key"]').fill('site');
    await page.locator('.properties-form [name="type"]').selectOption('url');
    await page.locator('.properties-form [name="value"]').fill('javascript:alert(1)');
    await page.locator('.properties-form button[type="submit"]').click();
    await page.waitForFunction(() => /Only HTTP and HTTPS/.test(document.querySelector('#properties-status')?.textContent || ''));
    check('unsafe property URLs are rejected before source mutation',
      !await page.evaluate(() => window.app.db.getNote('phase5-target').content.includes('javascript:')));
    await page.keyboard.press('Escape');
    await page.locator('#properties-overlay').waitFor({ state: 'hidden' });
    check('closing Properties restores focus to its editor trigger', await propertiesTrigger.evaluate((node) => document.activeElement === node));

    stage = 'filtering by a derived property';
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    await page.locator('#search-input').fill('prop:priority=7');
    await page.waitForFunction(() => document.querySelectorAll('.note-item').length === 1);
    check('property filters use a derived index without adding fields to JSON notes',
      await page.evaluate(() => document.querySelector('.note-item')?.dataset.id === 'phase5-target'
        && !JSON.stringify(window.app.db.getNote('phase5-target')).includes('_propertySearchIndex')));

    stage = 'copying and following block links';
    await page.locator('#sidebar-backdrop').click();
    await page.locator('.blk-copy-link').click();
    await page.waitForFunction(() => window.__phase5Clipboard === '[[Phase5 Target#^target]]'
      && /Copied block link/.test(document.querySelector('#app-status')?.textContent || ''));
    check('Copy Block Link preserves an existing stable ID and exposes clipboard success',
      await page.evaluate(() => window.__phase5Clipboard === '[[Phase5 Target#^target]]'
        && /Copied block link/.test(document.querySelector('#app-status')?.textContent || '')
        && document.activeElement?.classList.contains('blk-copy-link')));
    await page.evaluate(() => window.app.openNote('phase5-source'));
    const sourceLinks = page.locator('a[data-wikilink="Legacy Phase5"][data-fragment="^target"]');
    await sourceLinks.first().click();
    await page.waitForFunction(() => window.app.currentId === 'phase5-target' && document.activeElement?.dataset.blockId === 'target');
    check('alias block links resolve to the canonical note and focus the exact block', true);

    stage = 'rendering nested and cyclic transclusions safely';
    await page.evaluate(() => window.app.openNote('phase5-source'));
    check('block transclusion renders read-only through the shared sanitizer',
      await page.evaluate(() => {
        const transclusion = document.querySelector('.transclusion');
        return Boolean(transclusion)
          && transclusion.getAttribute('contenteditable') === 'false'
          && /Target safe/.test(transclusion.textContent)
          && !transclusion.querySelector('[onerror],script');
      }));
    await page.evaluate(() => window.app.openNote('phase5-cycle'));
    check('cyclic transclusion stops at a visible bounded placeholder',
      await page.locator('.transclusion--cycle').count() === 1);

    stage = 'repairing malformed YAML through its raw-only state';
    await page.evaluate(() => window.app.openNote('phase5-invalid'));
    await page.locator('.editor__properties').click();
    await page.locator('#properties-overlay').waitFor({ state: 'visible' });
    check('invalid YAML remains visible while typed property controls fail closed',
      await page.evaluate(() => document.querySelector('.properties-form fieldset')?.disabled
        && /aliases: \[broken/.test(document.querySelector('.properties-raw-form textarea')?.value || '')));
    await page.locator('.properties-raw-form textarea').fill('---\naliases: [Repair Later]\nunknown: keep\n---');
    await page.locator('.properties-raw-form button[type="submit"]').click();
    await page.waitForFunction(() => /Raw YAML source saved/.test(document.querySelector('#properties-status')?.textContent || ''));
    check('raw repair re-enables typed controls and preserves the note body',
      !await page.evaluate(() => document.querySelector('.properties-form fieldset')?.disabled)
        && await page.evaluate(() => window.app.db.getNote('phase5-invalid').content.endsWith('Body remains exact')));
    await page.keyboard.press('Escape');

    stage = 'reloading the complete Phase 5 state';
    await page.evaluate(() => window.app.db.flush());
    await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => window.app?.ready, undefined, { timeout: TIMEOUT });
    await page.evaluate(() => window.app.ready);
    check('frontmatter, unknown properties, aliases, and block IDs survive reload exactly',
      await page.evaluate(() => {
        const target = window.app.db.getNote('phase5-target');
        const invalid = window.app.db.getNote('phase5-invalid');
        return /future: \{ keep: true \}/.test(target.content)
          && /priority: 7/.test(target.content)
          && target.content.endsWith('^target')
          && target.aliases.includes('Legacy Phase5')
          && /unknown: keep/.test(invalid.content)
          && invalid.content.endsWith('Body remains exact');
      }));
    return checks.join('\n');
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      currentId: window.app?.currentId,
      title: window.app?.db?.getNote?.(window.app?.currentId)?.title || '',
      appStatus: document.querySelector('#app-status')?.textContent || '',
      propertiesStatus: document.querySelector('#properties-status')?.textContent || '',
      openOverlay: [...document.querySelectorAll('.modal:not([hidden])')].map((node) => node.id),
    })).catch(() => null);
    throw new Error(`Phase 5 smoke failed while ${stage}: ${error?.message || error}; diagnostics: ${JSON.stringify(diagnostics)}`);
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
    const entryMatch = shellHtml.match(/<script[^>]+src=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
    const entryPath = entryMatch?.[1] || entryMatch?.[2] || entryMatch?.[3];
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

    // The app intentionally starts recovery/index initialization after its first
    // usable paint. Let those startup requests settle before the deliberate
    // offline navigation so the browser does not report navigation-aborted
    // requests as runtime failures. The History, Backup, and Link-tools views
    // remain unopened/cold and are still exercised for first use while offline.
    await page.waitForFunction(() => Boolean(window.app?.recovery), undefined, { timeout: TIMEOUT });
    await page.evaluate(() => Promise.all([
      window.app.recoveryReady,
      window.app.db.initializeKnowledgeIndex(),
      window.app.editor.enableOutline(),
    ]));

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
    await page.keyboard.press('Escape');

    stage = 'opening Link integrity report for the first time offline';
    await page.locator('#menu-btn').click();
    await page.locator('#link-report-btn').click();
    await page.locator('#link-tools-overlay').waitFor({ state: 'visible' });
    checks.push('PASS  production Link tools lazy chunk opens on first use offline');
    await page.keyboard.press('Escape');

    stage = 'opening Phase 4 daily, capture, task, and calendar tools for the first time offline';
    await page.keyboard.press('Control+Shift+C');
    await page.locator('#quick-capture-overlay').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    await page.locator('#menu-btn').click();
    await page.locator('#tasks-btn').click();
    await page.locator('#task-dashboard-overlay').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    await page.locator('#menu-btn').click();
    await page.locator('#calendar-btn').click();
    await page.locator('#calendar-overlay').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.app.openDailyNote('2040-01-02'));
    await page.waitForFunction(() => window.app.db.getNote(window.app.currentId)?.title === '2040-01-02');
    checks.push('PASS  production Phase 4 lazy chunks and Daily creation work on first use offline');

    stage = 'opening Phase 5 properties for the first time offline';
    await page.locator('.editor__properties').click();
    await page.locator('#properties-overlay').waitFor({ state: 'visible' });
    if (!/Note properties/.test(await page.locator('#properties-overlay').innerText())) {
      throw new Error('Properties dialog did not render offline.');
    }
    checks.push('PASS  production Phase 5 Properties and YAML chunks open on first use offline');
    await page.keyboard.press('Escape');

    stage = 'opening Phase 3 retrieval and lifecycle tools for the first time offline';
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#app')?.classList.contains('sidebar-open'));
    await page.locator('#menu-btn').click();
    await page.locator('#archive-btn').click();
    await page.locator('#archive-overlay').waitFor({ state: 'visible' });
    checks.push('PASS  production Archive lazy chunk opens on first use offline');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+f');
    await page.locator('#find-replace-panel').waitFor({ state: 'visible' });
    if (!await page.locator('.saved-searches').count()) throw new Error('Saved views did not initialize offline');
    checks.push('PASS  production find/replace and saved-view chunks work on first use offline');
    await page.locator('[data-find-close]').click();
    await page.locator('#sidebar-toggle').click();
    await page.locator('.note-item [data-select]').first().click();
    await page.locator('.bulk-actions').waitFor({ state: 'visible' });
    checks.push('PASS  production multi-select bulk-action chunk opens on first use offline');
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

  // The integrated app uses several genuinely post-usable chunks. Transform
  // them before error capture so Vite's one-time dependency discovery cannot
  // abort an authoritative delayed-import request.
  await warmLazyAppModules(browser, base);
  await server.waitForRequestsIdle();

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
    const linkIntegrityOutput = await runLinkIntegritySmoke(browser, base, runtimeErrors);
    const phase3Output = await runPhase3Smoke(browser, base, runtimeErrors);
    const phase4Output = await runPhase4Smoke(browser, base, runtimeErrors);
    const phase5Output = await runPhase5Smoke(browser, base, runtimeErrors);
    await page.close();
    await server.close();
    devServerClosed = true;
    const offlineOutput = await runProductionOfflineSmoke(browser, runtimeErrors);
    output += `\n${recoveryOutput}\n${linkIntegrityOutput}\n${phase3Output}\n${phase4Output}\n${phase5Output}\n${offlineOutput}`;
  } catch (err) {
    failed = true;
    output += `${output ? '\n' : ''}Runner error: ${err.message || err}`;
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
