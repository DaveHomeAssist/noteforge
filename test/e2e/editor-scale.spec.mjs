import { test, expect } from '@playwright/test';
import { Note } from '../../src/core/note.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/core/migrations.js';
import { verifyBackup } from '../../src/core/backup.js';
import { previewRoot, captureRuntimeErrors } from './support/runtime.mjs';

const paragraph =
  'Representative source stays portable while ordinary typing, autosave and local revision capture run. '
    .repeat(5)
    .trim();
// The edited note uses canonical body whitespace; untouched notes keep their
// trailing newline. This measures persistence fidelity, not editor normalization.
const source = (index) =>
  `---\n# Preserve this comment\nunknown: [one, two]\npriority: ${index % 5}\n---\n${paragraph}\n\n[[Scale ${(index + 1) % 1000}]] and #scale\n\n- [ ] Follow up @due(2026-10-05)${index ? '\n' : ''}`;
const blockSelector = '[data-pane="primary"] .blk[contenteditable="true"]';

async function ready(page) {
  await page.waitForFunction(() => window.app?.workspace && window.app?.phase5 && window.app?.recoveryReady);
  return page.evaluate(async () => {
    const app = window.app;
    await Promise.all([app.ready, app.phase5.ready, app.phase6.ready, app.vaultRefreshReady, app.recoveryReady]);
    await app.db.initializeKnowledgeIndex();
    await app.openNote('scale-0');
    const initializedMs = performance.now();
    await app.recovery.ensureRollingSnapshots();
    await app.revisionStore.mutationQueue;
    await app.db.flush();
    return { initializedMs, settledMs: performance.now(), autosaveMs: app.db.config.autosaveMs };
  });
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values,
    medianMs: sorted[Math.ceil(sorted.length / 2) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

for (const { count, background } of [1000, 5000].flatMap((count) =>
  [false, true].map((background) => ({ count, background })),
)) {
  test(`production editor and real history preserve 500 typed characters at ${count} notes (${background ? 'background metadata' : 'ordinary'})`, async ({
    browser,
  }, testInfo) => {
    // Real advancing clock: fake scheduling cannot qualify interaction latency.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const notes = Array.from({ length: count }, (_, index) =>
      new Note({
        id: `scale-${index}`,
        title: `Scale ${index}`,
        content: source(index),
        tags: ['scale'],
        future: { preserved: true, index },
      }).toJSON(),
    );
    const page = await context.newPage();
    const errors = [];
    captureRuntimeErrors(page, errors);
    try {
      // Disposable activated fixture, not evidence that production migration is safe.
      await page.route('**/seed-scale.html', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Scale fixture</title>' }),
      );
      await page.goto(new URL('seed-scale.html', previewRoot()).href);
      await page.evaluate(
        async ({ notes, schemaVersion }) => {
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('my-notes-app', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('kv');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('kv', 'readwrite');
              const store = tx.objectStore('kv');
              store.put({ generation: `scale-${notes.length}`, sequence: 0, schemaVersion }, 'vault:meta');
              store.put({ values: { autosaveMs: 400 }, versions: { autosaveMs: 1 } }, 'vault:config');
              for (const note of notes) store.put({ version: 1, value: note }, `note:${note.id}`);
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error);
              };
            };
          });
        },
        { notes, schemaVersion: CURRENT_SCHEMA_VERSION },
      );
      await page.goto(previewRoot());
      const startup = await ready(page);
      expect(startup.autosaveMs).toBe(400);
      const block = page.locator(blockSelector).first();
      await expect(block).toHaveText(paragraph);
      await block.click();
      await block.evaluate((element) => {
        const selection = getSelection();
        selection.selectAllChildren(element);
        selection.collapseToEnd();
      });
      await page.evaluate((background) => {
        const db = window.app.db;
        const measurement = { rows: [], current: null, writes: [], submissions: [] };
        window.scaleMeasurement = measurement;
        const save = db.saveNoteWithReceipt;
        db.saveNoteWithReceipt = function (...args) {
          if (args[0].id !== 'scale-0') return save.apply(this, args);
          const row = measurement.current;
          const submission = { source: args[0].content, submitAt: performance.now() };
          row.submissions.push(submission);
          measurement.submissions.push(submission);
          const result = save.apply(this, args);
          submission.submitReturnedAt = performance.now();
          result.completion.then((receipt) => {
            submission.receipt = receipt;
            submission.receiptAt = performance.now();
          });
          return result;
        };
        const capture = db.onNotesPersisted;
        db.onNotesPersisted = async function (captures) {
          const result = await capture.call(this, captures);
          for (const { note } of captures) {
            if (note.id !== 'scale-0') continue;
            const submission = measurement.submissions.find((entry) => entry.source === note.content);
            if (submission) submission.historyAt = performance.now();
          }
          return result;
        };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          measurement.writes.push(String(key));
          return put.call(this, value, key);
        };
        document.addEventListener(
          'beforeinput',
          (event) => {
            if (!event.target.closest('[data-pane="primary"] .blk')) return;
            const row = measurement.current;
            row.lastInputAt = performance.now();
            const start = row.lastInputAt;
            requestAnimationFrame(() => row.inputFrameMs.push(performance.now() - start));
          },
          true,
        );
        if (background)
          document.addEventListener('input', (event) => {
            if (!event.target.closest('[data-pane="primary"] .blk')) return;
            const row = measurement.current;
            if (++row.inputs % 5 === 0) db.setPinned('scale-1', !db.getNote('scale-1').pinned);
          });
      }, background);
      let typed = '';
      for (let sample = 0; sample < 25; sample++) {
        await page.evaluate(() => {
          const row = { inputFrameMs: [], inputs: 0, submissions: [] };
          window.scaleMeasurement.rows.push(row);
          window.scaleMeasurement.current = row;
        });
        const text = ` edit${String(sample).padStart(2, '0')}abcdefghijklm`;
        expect(text.length).toBe(20);
        if (sample === 2) {
          // A pause can legitimately commit an intermediate source. Exercise it
          // during warmup without changing the autosave delay or forcing a flush.
          await block.pressSequentially(text.slice(0, 6));
          const partial = source(0).replace(paragraph, paragraph + typed + text.slice(0, 6));
          await page.waitForFunction(
            (partial) =>
              window.scaleMeasurement.current.submissions.some(
                (entry) =>
                  entry.receipt?.status === 'committed' && entry.receipt.note.content === partial && entry.historyAt,
              ),
            partial,
          );
          await block.pressSequentially(text.slice(6));
        } else await block.pressSequentially(text);
        typed += text;
        const expected = source(0).replace(paragraph, paragraph + typed);
        await page.evaluate((expected) => {
          window.scaleMeasurement.current.expected = expected;
        }, expected);
        await page.waitForFunction(
          () => {
            const row = window.scaleMeasurement.current;
            const state = window.app.db.getPersistenceStatus();
            row.finalSubmission = row.submissions.find(
              (entry) =>
                entry.receipt?.status === 'committed' && entry.receipt.note.content === row.expected && entry.historyAt,
            );
            return row.finalSubmission && !state.pendingWrites && !state.pendingHistory;
          },
          undefined,
          { timeout: 15_000 },
        );
        const result = await page.evaluate(() => {
          const row = window.scaleMeasurement.current;
          const selection = getSelection();
          const node = selection.anchorNode;
          return {
            receipt: row.finalSubmission.receipt,
            source: window.app.editor.getSourceMarkdown(),
            focus: document.activeElement?.matches('[data-pane="primary"] .blk[contenteditable="true"]'),
            caretAtEnd:
              selection.isCollapsed &&
              node?.nodeType === Node.TEXT_NODE &&
              selection.anchorOffset === node.textContent.length,
          };
        });
        expect(result.receipt).toMatchObject({ status: 'committed', noteId: 'scale-0', note: { content: expected } });
        expect(result.source).toBe(expected);
        expect(result.focus).toBe(true);
        expect(result.caretAtEnd).toBe(true);
        await expect(page.locator('[data-pane="primary"] .editor__save-status')).toHaveText('Saved on this device');
        await expect.poll(() => page.evaluate(() => window.app.noteList._rows[0].note.id)).toBe('scale-0');
        await page.evaluate(() => window.app.noteList.reveal('scale-0'));
        await expect(page.locator('#note-list .note-item[data-id="scale-0"]')).toHaveAttribute('aria-current', 'page');
      }
      const measured = await page.evaluate(async () => {
        const app = window.app;
        const revisions = await app.revisionStore.listRevisions('scale-0');
        const history = await Promise.all(revisions.map((revision) => app.revisionStore.materialize(revision)));
        const vault = await app.db.storage.readCurrentVault();
        const backupStart = performance.now();
        const backup = await app.recovery.createBackup();
        return {
          ...window.scaleMeasurement,
          history,
          revisionCount: revisions.length,
          retentionCount: app.revisionStore.retention.count,
          vault,
          backup: backup.text,
          backupMs: performance.now() - backupStart,
        };
      });
      const expected = source(0).replace(paragraph, paragraph + typed);
      await expect(page.locator('#note-count')).toHaveText(`${count} notes`);
      expect(await page.locator('#note-list .note-item').count()).toBeLessThan(80);
      for (const entry of measured.submissions) expect(['committed', 'superseded']).toContain(entry.receipt?.status);
      const committed = measured.submissions.filter((entry) => entry.receipt.status === 'committed');
      expect(committed.length).toBeGreaterThanOrEqual(26);
      for (const entry of committed) {
        expect(entry.receipt.note.content).toBe(entry.source);
        expect(entry.historyAt).toBeGreaterThan(0);
      }
      expect(measured.history.map((revision) => revision.content)).toEqual(
        committed
          .map((entry) => entry.source)
          .reverse()
          .slice(0, measured.retentionCount),
      );
      for (const revision of measured.history) expect(revision.metadata.future).toEqual(notes[0].future);
      expect(measured.revisionCount).toBe(Math.min(committed.length, measured.retentionCount));
      expect(measured.writes.filter((key) => key === 'note:scale-0')).toHaveLength(committed.length);
      const metadataWrites = measured.writes.filter((key) => key === 'note:scale-1').length;
      expect(metadataWrites).toBeLessThanOrEqual(100);
      if (background) expect(metadataWrites).toBeGreaterThan(0);
      else expect(metadataWrites).toBe(0);
      expect(
        measured.writes.filter((key) => key.startsWith('note:') && !['note:scale-0', 'note:scale-1'].includes(key)),
      ).toEqual([]);
      expect(measured.writes).not.toContain('notes');
      expect(measured.vault.conflicts).toEqual([]);
      const actual = new Map(measured.vault.records);
      for (const note of notes.slice(1))
        expect(actual.get(note.id)).toEqual({ version: note.id === 'scale-1' ? 1 + metadataWrites : 1, value: note });
      expect(actual.get('scale-0').value).toMatchObject({ content: expected, future: notes[0].future });
      const backup = await verifyBackup(measured.backup);
      expect(backup.notes).toHaveLength(count);
      expect(new Map(backup.notes.map((note) => [note.id, note]))).toEqual(
        new Map(measured.vault.records.map(([id, record]) => [id, record.value])),
      );
      await page.reload();
      const reopened = await ready(page);
      expect(await page.evaluate(() => window.app.editor.getSourceMarkdown())).toBe(expected);
      expect(await page.evaluate(async () => (await window.app.revisionStore.listRevisions('scale-0')).length)).toBe(
        measured.revisionCount,
      );
      const samples = measured.rows.slice(5);
      expect(samples.flatMap((row) => row.inputFrameMs)).toHaveLength(400);
      const metrics = {
        count,
        backgroundMetadata: background,
        metadataWrites,
        warmupBatches: 5,
        measuredBatches: samples.length,
        committedSaves: committed.length,
        typedCharacters: typed.length,
        startup,
        reopened,
        inputToAnimationFrame: distribution(samples.flatMap((row) => row.inputFrameMs)),
        lastInputToReceipt: distribution(samples.map((row) => row.finalSubmission.receiptAt - row.lastInputAt)),
        submitToReceipt: distribution(samples.map(({ finalSubmission: entry }) => entry.receiptAt - entry.submitAt)),
        synchronousSubmit: distribution(
          samples.map(({ finalSubmission: entry }) => entry.submitReturnedAt - entry.submitAt),
        ),
        submitToHistory: distribution(samples.map(({ finalSubmission: entry }) => entry.historyAt - entry.submitAt)),
        backupMs: measured.backupMs,
        revisionCount: measured.revisionCount,
      };
      await testInfo.attach(`editor-scale-${count}`, {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });
      const summary = Object.fromEntries(
        Object.entries(metrics).map(([key, value]) => [
          key,
          value?.samples ? { ...value, samples: value.samples.length } : value,
        ]),
      );
      console.log(`EDITOR_SCALE_MEASUREMENT ${testInfo.project.name} ${JSON.stringify(summary)}`);
      expect(errors).toEqual([]);
      // rAF is an upper-bound scheduling proxy, not a physical display measurement.
      expect(metrics.inputToAnimationFrame.p95Ms).toBeLessThan(50);
    } finally {
      await context.close();
    }
  });
}
