import { expect, test } from '@playwright/test';
import { devUrl } from './support/runtime.mjs';

async function fixture(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL('test/durability.html', devUrl()).href);
  await page.evaluate(async () => {
    window.vault = await import('../src/core/vault-transactions.js');
    window.connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open('transaction-contract', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.initial = { notes: [], config: {}, schemaVersion: 0 };
    window.seed = {
      notes: [
        { id: 'a', content: 'A' },
        { id: 'b', content: 'B' },
      ],
      config: { theme: 'light' },
      schemaVersion: 6,
    };
    window.timestamp = '2026-10-03T23:00:00.000Z';
    window.write = (notes, extra = {}) =>
      window.vault.commitVault(window.connection, 'kv', {
        generation: 'initial',
        notes,
        timestamp: window.timestamp,
        ...extra,
      });
    window.read = () => window.vault.readVault(window.connection, 'kv');
    window.initialize = () =>
      window.vault.initializeVault(
        window.connection,
        'kv',
        {
          timestamp: window.timestamp,
          indexedDB: {},
          localStorage: null,
          backup: window.initial,
          migrated: window.seed,
        },
        'initial',
      );
    await window.initialize();
  });
  return { context, page };
}

test('atomic note versions preserve independent concurrent writes and retain conflicting drafts', async ({
  browser,
}) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const writes = await Promise.all([
        window.write([{ id: 'a', expected: 1, value: { id: 'a', content: 'A edited' } }]),
        window.write([{ id: 'b', expected: 1, value: { id: 'b', content: 'B edited' } }]),
      ]);
      const conflict = await window.write([{ id: 'a', expected: 1, value: { id: 'a', content: 'Other draft' } }], {
        conflictId: 'draft-1',
      });
      return { writes, conflict, snapshot: await window.read() };
    });
    expect(result.writes.map((item) => item.status)).toEqual(['committed', 'committed']);
    expect(result.conflict.status).toBe('conflict');
    expect(result.snapshot.records.map(([id, record]) => [id, record.version, record.value.content])).toEqual([
      ['a', 2, 'A edited'],
      ['b', 2, 'B edited'],
    ]);
    expect(result.snapshot.conflicts[0].mutation.notes[0].value.content).toBe('Other draft');
    expect(result.snapshot.conflicts[0].conflicts[0].current.value.content).toBe('A edited');
  } finally {
    await context.close();
  }
});

test('a stale multi-note plan changes nothing and a tombstone prevents resurrection', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      await window.write([{ id: 'b', expected: 1, value: null }]);
      const plan = await window.write(
        [
          { id: 'a', expected: 1, value: { id: 'a', content: 'Rename replacement' } },
          { id: 'b', expected: 1, value: { id: 'b', content: 'Stale resurrection' } },
        ],
        { sequence: 0 },
      );
      return { plan, snapshot: await window.read() };
    });
    expect(result.plan.status).toBe('conflict');
    expect(result.snapshot.records).toEqual([
      ['a', { version: 1, value: { id: 'a', content: 'A' } }],
      ['b', { version: 2, value: null }],
    ]);
  } finally {
    await context.close();
  }
});

test('invalid note or setting batches cannot partially mutate the vault', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const valid = { id: 'a', expected: 1, value: { id: 'a', content: 'Must not commit' } };
      const attempts = [
        { notes: [valid, valid] },
        { notes: [valid, { id: 'b', expected: -1, value: null }] },
        { notes: [valid, { id: 'b', expected: 1.5, value: null }] },
        { notes: [valid, { id: '', expected: 1, value: null }] },
        { notes: [valid, { id: 'b', expected: 1, value: { id: 'a' } }] },
        { notes: [valid], config: [{ key: 'theme', expected: -1, value: 'dark' }] },
        { notes: [valid], config: [{ key: '', expected: 0, value: 'dark' }] },
        {
          notes: [valid],
          config: [
            { key: 'theme', expected: 1, value: 'dark' },
            { key: 'theme', expected: 1, value: 'light' },
          ],
        },
      ];
      const before = await window.read();
      const rejected = [];
      for (const mutation of attempts) {
        try {
          await window.write(mutation.notes, mutation);
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      return { before, after: await window.read(), rejected };
    });
    expect(result.rejected).toEqual(Array(8).fill(true));
    expect(result.after).toEqual(result.before);
  } finally {
    await context.close();
  }
});

test('configuration compares fields independently and safely preserves prototype-shaped keys', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const first = await window.write([], { config: [{ key: 'theme', expected: 1, value: 'dark' }] });
      const independent = await window.write([], {
        config: [
          { key: 'font', expected: 0, value: 'large' },
          { key: '__proto__', expected: 0, value: 'opaque' },
        ],
      });
      const stale = await window.write([], { config: [{ key: 'theme', expected: 1, value: 'light' }] });
      const snapshot = await window.read();
      return {
        first,
        independent,
        stale,
        snapshot,
        protoValue: Object.getOwnPropertyDescriptor(snapshot.config.values, '__proto__')?.value,
      };
    });
    expect([result.first.status, result.independent.status, result.stale.status]).toEqual([
      'committed',
      'committed',
      'conflict',
    ]);
    expect(result.snapshot.config.values.theme).toBe('dark');
    expect(result.snapshot.config.values.font).toBe('large');
    expect(result.protoValue).toBe('opaque');
  } finally {
    await context.close();
  }
});

test('full replacement is atomic and invalidates previously queued mutations', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const replace = await window.write([], {
        sequence: 0,
        replacement: { notes: [{ id: 'restored', content: 'Restored' }], config: { theme: 'dark' }, schemaVersion: 6 },
      });
      const old = await window.write([{ id: 'a', expected: 1, value: { id: 'a', content: 'Old queued edit' } }]);
      return { replace, old, snapshot: await window.read() };
    });
    expect(result.replace.status).toBe('committed');
    expect(result.old.status).toBe('conflict');
    expect(result.snapshot.records).toEqual([
      ['restored', { version: 1, value: { id: 'restored', content: 'Restored' } }],
    ]);
    expect(result.snapshot.config.values).toEqual({ theme: 'dark' });
  } finally {
    await context.close();
  }
});

test('transaction abort never acknowledges a partial mutation', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const original = window.connection.transaction.bind(window.connection);
      window.connection.transaction = (...args) => {
        const tx = original(...args);
        const getStore = tx.objectStore.bind(tx);
        tx.objectStore = (...names) => {
          const store = getStore(...names);
          const put = store.put.bind(store);
          store.put = (...values) => {
            const request = put(...values);
            if (values[1] === 'note:a') request.onsuccess = () => tx.abort();
            return request;
          };
          return store;
        };
        return tx;
      };
      let rejected = false;
      try {
        await window.write([{ id: 'a', expected: 1, value: { id: 'a', content: 'Must abort' } }]);
      } catch {
        rejected = true;
      }
      window.connection.transaction = original;
      return { rejected, snapshot: await window.read() };
    });
    expect(result.rejected).toBe(true);
    expect(result.snapshot.meta.sequence).toBe(0);
    expect(result.snapshot.records[0][1].value.content).toBe('A');
  } finally {
    await context.close();
  }
});

test('note and conflict keys at the top of the string range stay inside every prefix scan', async ({ browser }) => {
  const { context, page } = await fixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const edge = '￿edge';
      const replaced = await window.write([], {
        sequence: 0,
        replacement: { notes: [{ id: edge, content: 'Top of range' }], config: {}, schemaVersion: 6 },
      });
      const afterReplace = (await window.read()).records.map(([id]) => id);
      const generation = (await window.read()).meta.generation;
      const conflict = await window.vault.commitVault(window.connection, 'kv', {
        generation,
        timestamp: window.timestamp,
        conflictId: '￿conflict',
        notes: [{ id: edge, expected: 0, value: { id: edge, content: 'Stale' } }],
      });
      const snapshot = await window.read();
      const head = await window.vault.readVaultHead(window.connection, 'kv');
      // A later replacement must delete the edge record too.
      await window.write([], {
        generation,
        sequence: snapshot.meta.sequence,
        replacement: { notes: [{ id: 'plain', content: 'Plain' }], config: {}, schemaVersion: 6 },
      });
      return {
        replaced: replaced.status,
        afterReplace,
        conflict: conflict.status,
        conflictIds: snapshot.conflicts.map((item) => item.id),
        headIds: head.conflictIds,
        afterSecond: (await window.read()).records.map(([id]) => id),
      };
    });
    expect(result).toEqual({
      replaced: 'committed',
      afterReplace: ['￿edge'],
      conflict: 'conflict',
      conflictIds: ['￿conflict'],
      headIds: ['￿conflict'],
      afterSecond: ['plain'],
    });
  } finally {
    await context.close();
  }
});
