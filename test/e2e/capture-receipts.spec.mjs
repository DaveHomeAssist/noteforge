import { test, expect } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function open(context, seed = false, view = false) {
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(
    async ({ seed, view }) => {
      const { Database } = await import('../src/core/database.js');
      const { storage } = await import('../src/core/storage.js');
      const { Note } = await import('../src/core/note.js');
      const { CURRENT_SCHEMA_VERSION } = await import('../src/core/migrations.js');
      const { CaptureService } = await import('../src/core/capture-service.js');
      if (seed)
        await storage.saveMany([
          ['notes', ['a', 'b'].map((id) => new Note({ id, title: id, content: `Original ${id}` }).toJSON())],
          ['config', {}],
          ['schemaVersion', CURRENT_SCHEMA_VERSION],
        ]);
      window.captures = [];
      window.db = new Database({
        storageBackend: storage,
        onNotesPersisted: async (batch) => window.captures.push(...batch),
      });
      await window.db.init({ allowLegacyMigration: seed });
      window.capture = new CaptureService(window.db);
      window.saved = async (id) => (await storage.readCurrentVault()).records.find(([key]) => key === id)?.[1];
      if (view) {
        await import('../src/styles.css');
        const { QuickCaptureView, createQuickCaptureElements } = await import(
          '../src/components/quick-capture-view.js'
        );
        window.savedEvents = [];
        window.captureView = new QuickCaptureView(createQuickCaptureElements(), window.db, window.capture, {
          onSaved: (result) => window.savedEvents.push(result),
        });
        window.captureView.show({ destinationId: 'b' });
      }
    },
    { seed, view },
  );
  return page;
}

async function holdCommit(page) {
  await page.evaluate(() => {
    const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
    window.db.storage.commitCurrentVault = async (mutation) => {
      window.db.storage.commitCurrentVault = commit;
      const result = await commit(mutation);
      await new Promise((resolve) => {
        window.releaseCapture = resolve;
      });
      return result;
    };
  });
}

async function finish(context, page) {
  await page
    ?.evaluate(async () => {
      window.releaseCapture?.();
      await window.operation;
      await window.db.flushCurrentWrites();
    })
    .catch(() => {});
  await context.close();
}

test('capture acknowledges its own note while another note remains conflicted', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const current = await open(context, true);
    const stale = await open(context);
    await current.evaluate(async () => {
      const note = window.db.getNote('a');
      note.update({ content: 'Other window A' });
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
    });
    const outcome = await stale.evaluate(async () => {
      const note = window.db.getNote('a');
      note.update({ content: 'Conflicting draft A' });
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
      return window.capture.save({ destination: 'existing', noteId: 'b', markdown: 'Independent capture' }).then(
        (result) => ({ result, queue: window.db.getPersistenceStatus().pendingWrites }),
        (error) => ({ error: error.message }),
      );
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.receipt).toMatchObject({ status: 'committed', noteId: 'b', version: 2 });
    expect(outcome.queue).toBeGreaterThan(0);
    const reopened = await open(context);
    expect((await reopened.evaluate(() => window.saved('b'))).value.content).toBe('Original b\n\nIndependent capture');
    expect(await reopened.evaluate(() => window.db.conflicts.size)).toBe(1);
  } finally {
    await context.close();
  }
});

test('capture returns the acknowledged snapshot while later typing commits separately', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true);
  try {
    await holdCommit(page);
    await page.evaluate(() => {
      window.operation = window.capture.save({ destination: 'existing', noteId: 'b', markdown: 'Captured source' });
    });
    await page.waitForFunction(() => window.releaseCapture);
    await page.evaluate(() => {
      const note = window.db.getNote('b');
      note.update({ content: 'Later destination typing' });
      window.db.saveNote(note);
      window.releaseCapture();
    });
    const result = await page.evaluate(() => window.operation);
    expect(result.note.content).toBe('Original b\n\nCaptured source');
    expect(result.receipt).toMatchObject({ status: 'committed', version: 2 });
    await page.evaluate(() => window.db.flushCurrentWrites());
    expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Later destination typing');
  } finally {
    await finish(context, page);
  }
});

test('capture completion retains text entered while the submitted capture is in flight', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true, true);
  try {
    await holdCommit(page);
    await page.getByLabel('Text', { exact: true }).fill('Submitted capture');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await page.waitForFunction(() => window.releaseCapture);
    await page.getByLabel('Text', { exact: true }).fill('New unsaved capture');
    await page.evaluate(() => window.releaseCapture());
    await expect(page.locator('#quick-capture-status')).toContainText('Saved to');
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue('New unsaved capture');
    expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Original b\n\nSubmitted capture');
  } finally {
    await finish(context, page);
  }
});

test('retrying one capture request resubmits its snapshot without appending twice', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true);
  try {
    const outcome = await page.evaluate(async () => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected capture failure');
      };
      const input = { destination: 'existing', noteId: 'b', markdown: 'Once only' };
      const first = await window.capture.save(input).then(
        () => 'unexpected success',
        (e) => e.message,
      );
      window.db.storage.commitCurrentVault = commit;
      const retried = await window.capture.save(input);
      return { first, retried, saved: await window.saved('b') };
    });
    expect(outcome.first).toContain('pending');
    expect(outcome.saved.value.content).toBe('Original b\n\nOnce only');
    expect(outcome.retried.receipt.status).toBe('committed');
  } finally {
    await finish(context, page);
  }
});

test('capture creates and reuses Inbox, records exact revisions and reopens new notes', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true);
  try {
    const result = await page.evaluate(async () => {
      const first = await window.capture.save({ destination: 'inbox', markdown: 'First capture' });
      const second = await window.capture.save({ destination: 'inbox', markdown: 'Second capture' });
      const third = await window.capture.save({
        destination: 'new',
        newTitle: 'Captured note',
        markdown: 'New source',
      });
      await window.db.flush();
      return { first, second, third, captures: window.captures };
    });
    expect(result.first.created).toBe(true);
    expect(result.first.receipt).toMatchObject({ status: 'committed', version: 1 });
    expect(result.second.created).toBe(false);
    expect(result.second.note.id).toBe(result.first.note.id);
    expect(result.second.receipt).toMatchObject({ status: 'committed', version: 2 });
    expect(result.second.note.content).toBe('First capture\n\nSecond capture');
    expect(result.third.created).toBe(true);
    expect(result.captures.map((entry) => entry.reason)).toEqual(['quick_capture', 'quick_capture', 'quick_capture']);
    expect(result.captures.map((entry) => entry.note.content)).toEqual([
      'First capture',
      'First capture\n\nSecond capture',
      'New source',
    ]);
    const reopened = await open(context);
    expect((await reopened.evaluate((id) => window.saved(id), result.second.note.id)).value.content).toBe(
      'First capture\n\nSecond capture',
    );
    expect((await reopened.evaluate((id) => window.saved(id), result.third.note.id)).value.content).toBe('New source');
  } finally {
    await finish(context, page);
  }
});

test('an old capture completion cannot change a reopened dialog or steal its focus', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true, true);
  try {
    await holdCommit(page);
    await page.getByLabel('Text', { exact: true }).fill('Old submitted capture');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await page.waitForFunction(() => window.releaseCapture);
    await page.getByRole('button', { name: 'Close Quick Capture', exact: true }).click();
    await page.evaluate(() => window.captureView.show({ payload: { text: 'Reopened draft' }, destinationId: 'a' }));
    await page.evaluate(async () => {
      window.releaseCapture();
      await window.db.flushCurrentWrites();
    });
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Reopened draft');
    await expect(page.getByLabel('Text', { exact: true })).toBeFocused();
    await expect(page.locator('#quick-capture-status')).toContainText('Nothing is saved');
    expect(await page.evaluate(() => window.savedEvents)).toEqual([]);
    expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Original b\n\nOld submitted capture');
    expect((await page.evaluate(() => window.saved('a'))).value.content).toBe('Original a');
  } finally {
    await finish(context, page);
  }
});

test('capture retry refuses to replace a destination changed after its failed submission', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true);
  try {
    const result = await page.evaluate(async () => {
      const commit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected capture failure');
      };
      const input = { destination: 'existing', noteId: 'b', markdown: 'Original attempt' };
      await window.capture.save(input).catch(() => {});
      window.db.storage.commitCurrentVault = commit;
      const note = window.db.getNote('b');
      note.update({ content: 'Newer destination draft' });
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
      const error = await window.capture.save(input).then(
        () => 'unexpected success',
        (e) => e.message,
      );
      return { error, saved: await window.saved('b') };
    });
    expect(result.error).toContain('destination changed');
    expect(result.saved.value.content).toBe('Newer destination draft');
  } finally {
    await finish(context, page);
  }
});

test('capture UI retries the same pending request and clears it only after acknowledgement', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true, true);
  try {
    await page.evaluate(() => {
      window.restoreCaptureCommit = window.db.storage.commitCurrentVault.bind(window.db.storage);
      window.db.storage.commitCurrentVault = async () => {
        throw new Error('Injected UI capture failure');
      };
    });
    await page.getByLabel('Text', { exact: true }).fill('Retry once');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.locator('#quick-capture-status')).toContainText('still pending');
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Retry once');
    await page.evaluate(() => {
      window.db.storage.commitCurrentVault = window.restoreCaptureCommit;
    });
    await page.getByRole('button', { name: 'Retry capture', exact: true }).click();
    await expect(page.locator('#quick-capture-status')).toContainText('Saved to');
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue('');
    expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Original b\n\nRetry once');
    expect(await page.evaluate(() => window.savedEvents.length)).toBe(1);
  } finally {
    await finish(context, page);
  }
});

test('repeated successful capture requests retain an immutable acknowledgement and do not append again', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await open(context, true);
  try {
    const result = await page.evaluate(async () => {
      const input = { destination: 'existing', noteId: 'b', markdown: 'Original submission' };
      const first = await window.capture.save(input);
      first.note.content = 'Changed public model';
      first.receipt.note.content = 'Changed public receipt';
      const note = window.db.getNote('b');
      note.update({ content: 'Later saved source' });
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
      input.markdown = 'Changed public request';
      return { repeated: await window.capture.save(input), saved: await window.saved('b') };
    });
    expect(result.repeated.note.content).toBe('Original b\n\nOriginal submission');
    expect(result.repeated.receipt).toMatchObject({
      version: 2,
      note: { content: 'Original b\n\nOriginal submission' },
    });
    expect(result.saved).toMatchObject({ version: 3, value: { content: 'Later saved source' } });
  } finally {
    await finish(context, page);
  }
});

for (const dismissed of [false, true]) {
  test(`capture image preparation retains its original form ownership (dismissed ${dismissed})`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await open(context, true, true);
    try {
      await page.evaluate(() => {
        const read = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function (...args) {
          FileReader.prototype.readAsDataURL = read;
          window.releaseImage = () => read.apply(this, args);
        };
      });
      await page.getByLabel('Text', { exact: true }).fill('Original form text');
      await page.locator('#capture-image').setInputFiles({
        name: 'capture.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>',
        ),
      });
      await page.getByRole('button', { name: 'Save capture', exact: true }).click();
      await page.waitForFunction(() => window.releaseImage);
      if (dismissed) {
        await page.keyboard.press('Escape');
      } else {
        await page.getByLabel('Text', { exact: true }).fill('New image draft');
        await page.locator('#capture-destination').selectOption('existing:a');
      }
      await page.evaluate(() => window.releaseImage());
      // Image processing completion is observable without an arbitrary delay.
      await page.waitForFunction(() => !window.captureView.activeSave);
      if (dismissed) {
        await page.evaluate(() =>
          window.captureView.show({ payload: { text: 'Reopened image draft' }, destinationId: 'a' }),
        );
        await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Reopened image draft');
        await expect(page.locator('#quick-capture-status')).toContainText('Nothing is saved');
        expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Original b');
      } else {
        await expect(page.locator('#quick-capture-status')).toContainText('New input has not been saved');
        await expect(page.getByLabel('Text', { exact: true })).toHaveValue('New image draft');
        const content = (await page.evaluate(() => window.saved('b'))).value.content;
        expect(content).toContain('Original form text');
        expect(content).toContain('data:image/jpeg');
        expect(content).not.toContain('New image draft');
      }
      expect((await page.evaluate(() => window.saved('a'))).value.content).toBe('Original a');
      expect(await page.evaluate(() => window.savedEvents)).toEqual([]);
    } finally {
      await finish(context, page);
    }
  });
}

test('a failed post-save navigation does not turn an acknowledged capture into a failed save', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await open(context, true, true);
  try {
    await page.evaluate(() => {
      window.captureView.onSaved = async () => {
        throw new Error('Injected navigation failure');
      };
    });
    await page.getByLabel('Text', { exact: true }).fill('Saved before navigation');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.locator('#quick-capture-status')).toHaveText(
      'Saved to “b”. The destination could not be opened.',
    );
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Save capture', exact: true })).toBeEnabled();
    expect((await page.evaluate(() => window.saved('b'))).value.content).toBe('Original b\n\nSaved before navigation');
  } finally {
    await finish(context, page);
  }
});

test('the application opens Capture despite another note conflict and keeps its editor draft', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const remote = await open(context, true);
    const app = await context.newPage();
    await app.goto(devUrl());
    await app.waitForFunction(() => window.app?.phase5 && window.app?.phase6);
    await app.evaluate(async () => {
      await window.app.ready;
      await Promise.all([window.app.phase5.ready, window.app.phase6.ready, window.app.vaultRefreshReady]);
      await window.app.openNote('a');
      await window.app.db.flush();
      window.app.stopVaultRefresh?.();
    });
    await remote.evaluate(async () => {
      const note = window.db.getNote('a');
      note.update({ content: 'Remote saved A' });
      window.db.saveNote(note);
      await window.db.flushCurrentWrites();
    });
    await app.evaluate(async () => {
      const note = window.app.db.getNote('a');
      note.update({ content: 'Retained local A' });
      window.app.db.saveNote(note);
      await window.app.db.flushCurrentWrites();
      window.app.editor.syncAuthoritative(['a']);
    });
    await app.getByRole('button', { name: 'Open Quick Capture', exact: true }).click();
    await expect(app.getByRole('dialog', { name: 'Quick Capture', exact: true })).toBeVisible();
    await app.locator('#capture-destination').selectOption('existing:b');
    await app.getByLabel('Text', { exact: true }).fill('Independent application capture');
    await app.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(app.locator('#quick-capture-status')).toContainText('Saved to “b”');
    await expect(app.locator('#quick-capture-status')).toContainText('destination could not be opened');
    expect(await app.evaluate(() => window.app.editor.getSourceMarkdown())).toBe('Retained local A');
    expect(await app.evaluate(() => window.app.db.conflicts.size)).toBeGreaterThan(0);
    const reopened = await open(context);
    expect((await reopened.evaluate(() => window.saved('a'))).value.content).toBe('Remote saved A');
    expect((await reopened.evaluate(() => window.saved('b'))).value.content).toBe(
      'Original b\n\nIndependent application capture',
    );
    expect(
      await reopened.evaluate(() =>
        [...window.db.conflicts.values()].some((c) => c.mutation.notes[0]?.value?.content === 'Retained local A'),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
