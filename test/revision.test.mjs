import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVISION_STORAGE_PREFIXES,
  RevisionStore,
  RevisionStoreError,
  canonicalJson,
  createRestoreCopyPayload,
  normalizeRetention,
  sha256,
} from '../src/core/revision-store.js';

class MemoryStorage {
  constructor({ backend = 'indexeddb', quota = null, writeError = null } = {}) {
    this.data = new Map();
    this.backend = backend;
    this.quota = quota;
    this.writeError = writeError;
    this.batches = [];
  }

  async ready() {
    return this.backend === 'indexeddb';
  }

  async getStatus() {
    const available = this.backend === 'indexeddb';
    return {
      backend: this.backend,
      capabilities: { revisionHistory: available, localSnapshots: available, atomicBatch: available },
      quota: this.quota,
    };
  }

  async load(key, fallback = null) {
    return this.data.has(key) ? this.data.get(key) : fallback;
  }

  async loadMany(keys, fallback = null) {
    return [...keys].map((key) => this.data.has(key) ? this.data.get(key) : fallback);
  }

  async keys(prefix = '') {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async saveMany(entries) {
    if (this.writeError) throw this.writeError;
    const batch = entries instanceof Map ? [...entries] : Array.isArray(entries) ? entries : Object.entries(entries);
    this.batches.push(batch.map(([key]) => key));
    const next = new Map(this.data);
    batch.forEach(([key, value]) => next.set(key, value));
    this.data = next;
    return true;
  }

  async removeMany(keys) {
    const next = new Map(this.data);
    [...keys].forEach((key) => next.delete(key));
    this.data = next;
    return true;
  }

  async remove(key) {
    this.data.delete(key);
  }
}

class SharedLockStorage extends MemoryStorage {
  constructor(options) {
    super(options);
    this.lockQueue = Promise.resolve();
  }

  withLock(_name, operation) {
    const result = this.lockQueue.then(operation, operation);
    this.lockQueue = result.catch(() => {});
    return result;
  }
}

function ids(prefix = 'id') {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function note(id, content, overrides = {}) {
  return {
    id,
    title: `Note ${id}`,
    content,
    tags: [],
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function vault(notes, config = { themeMode: 'dark' }, schemaVersion = 3) {
  return { notes, config, schemaVersion };
}

function countKeys(storage, prefix) {
  return [...storage.data.keys()].filter((key) => key.startsWith(prefix)).length;
}

test('canonical JSON and Web Crypto hashing are deterministic', async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: [3, 1] } }), '{"a":{"x":[3,1],"y":2},"z":1}');
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => canonicalJson({ value: undefined }), (error) => error.code === 'malformed_metadata');
});

test('retention settings enforce documented safe ranges', () => {
  assert.deepEqual(normalizeRetention({ count: 10, days: 7 }), { count: 10, days: 7 });
  assert.deepEqual(normalizeRetention({ count: 201, days: 6 }), { count: 50, days: 90 });
  assert.deepEqual(normalizeRetention({ maxRevisions: 200, maxAgeDays: 365 }), { count: 200, days: 365 });
});

test('storage fallback batches logical namespaced keys but reports history unavailable', async () => {
  const originalIndexedDB = globalThis.indexedDB;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map([
    ['my-notes-app:notes', JSON.stringify([{ id: 'legacy' }])],
    ['unrelated:key', JSON.stringify('leave me')],
  ]);
  let failOnKey = null;
  let quotaLimit = Infinity;
  globalThis.indexedDB = undefined;
  globalThis.localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (key === failOnKey) {
        failOnKey = null;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      const nextSize = [...values].reduce((total, [storedKey, storedValue]) => (
        total + (storedKey === key ? 0 : storedValue.length)
      ), value.length);
      if (nextSize > quotaLimit) throw new DOMException('quota', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); },
  };
  try {
    const { storage } = await import(`../src/core/storage.js?fallback-test=${Date.now()}`);
    assert.deepEqual(await storage.keys(), ['notes']);
    assert.equal(await storage.saveMany([['revision:test:a', 1], ['revision:test:b', 2]]), true);
    assert.deepEqual(await storage.keys('revision:'), ['revision:test:a', 'revision:test:b']);
    assert.deepEqual(await storage.loadMany(['revision:test:b', 'missing'], 'fallback'), [2, 'fallback']);
    const originalNotes = values.get('my-notes-app:notes');
    failOnKey = 'my-notes-app:config';
    assert.equal(await storage.saveMany([['notes', [{ id: 'replacement' }]], ['config', { changed: true }]]), false);
    assert.equal(values.get('my-notes-app:notes'), originalNotes, 'failed fallback batch rolls back an earlier note write');
    assert.equal(values.has('my-notes-app:config'), false, 'failed fallback batch leaves absent keys absent');

    const largeOldNotes = JSON.stringify([{ id: 'legacy', body: 'x'.repeat(120) }]);
    const smallOldConfig = JSON.stringify({ old: true });
    const oldSchema = JSON.stringify(3);
    values.set('my-notes-app:notes', largeOldNotes);
    values.set('my-notes-app:config', smallOldConfig);
    values.set('my-notes-app:schemaVersion', oldSchema);
    const fixedSize = [...values.values()].reduce((total, value) => total + value.length, 0);
    quotaLimit = fixedSize;
    failOnKey = 'my-notes-app:schemaVersion';
    const largeNewConfig = { pad: 'y'.repeat(Math.max(1, largeOldNotes.length - 30)) };
    assert.equal(await storage.saveMany([
      ['notes', [{ id: 'small-new' }]],
      ['config', largeNewConfig],
      ['schemaVersion', 3],
    ]), false);
    assert.equal(values.get('my-notes-app:notes'), largeOldNotes, 'late fallback failure restores the original large notes');
    assert.equal(values.get('my-notes-app:config'), smallOldConfig, 'late fallback failure restores the original config');
    assert.equal(values.get('my-notes-app:schemaVersion'), oldSchema, 'late fallback failure restores the original schema');
    quotaLimit = Infinity;
    failOnKey = null;
    assert.equal(await storage.saveMany([['revision:test:c', 3]], { allowFallback: false }), false);
    assert.equal(await storage.removeMany(['revision:test:a', 'revision:test:b']), true);
    assert.deepEqual(await storage.keys('revision:'), []);
    const status = await storage.getStatus();
    assert.equal(status.backend, 'localstorage');
    assert.equal(status.capabilities.revisionHistory, false);
    assert.equal(status.capabilities.atomicBatch, false);
    assert.deepEqual(JSON.parse(values.get('my-notes-app:notes')), JSON.parse(largeOldNotes));
    assert.equal(values.get('unrelated:key'), JSON.stringify('leave me'));
  } finally {
    if (originalIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDB;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test('capture stores immutable records and deduplicates exact content and metadata across notes', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids(), now: () => new Date('2026-08-19T12:00:00.000Z') });
  const first = await revisions.capture(note('a', '# Shared'), { reason: 'autosave' });
  const duplicate = await revisions.capture(note('a', '# Shared'), { reason: 'manual' });
  const acrossNotes = await revisions.capture(note('b', '# Shared', { title: 'Note a' }), { reason: 'manual' });

  assert.equal(first.captured, true);
  assert.equal(duplicate.captured, false);
  assert.equal(duplicate.revision.id, first.revision.id);
  assert.equal(acrossNotes.revision.contentHash, first.revision.contentHash);
  assert.notEqual(acrossNotes.revision.metadataHash, first.revision.metadataHash, 'authoritative metadata includes each note ID');
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 1);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 2);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.record), 2);

  const materialized = await revisions.materialize(first.revision.id);
  assert.equal(materialized.content, '# Shared');
  assert.equal(materialized.metadata.id, 'a');
  assert.equal(Object.isFrozen(materialized), true);
  await assert.rejects(
    revisions.capture(note('a', '# Changed'), { reason: 'not_a_boundary' }),
    (error) => error.code === 'invalid_capture_reason',
  );
});

test('healthy per-note indexes keep revision reads bounded to the selected note', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('indexed') });
  await revisions.capture(note('target', 'one'));
  await revisions.capture(note('target', 'two'));
  for (let index = 0; index < 5_000; index += 1) {
    storage.data.set(`${REVISION_STORAGE_PREFIXES.record}unrelated-${index}`, { malformed: true });
  }
  const originalKeys = storage.keys.bind(storage);
  const originalLoadMany = storage.loadMany.bind(storage);
  let vaultWideRecordScans = 0;
  let largestRead = 0;
  storage.keys = async (prefix = '') => {
    if (prefix === REVISION_STORAGE_PREFIXES.record) vaultWideRecordScans += 1;
    return originalKeys(prefix);
  };
  storage.loadMany = async (keys, fallback) => {
    largestRead = Math.max(largestRead, [...keys].length);
    return originalLoadMany(keys, fallback);
  };

  const listed = await revisions.list('target');
  assert.equal(listed.length, 2);
  assert.equal(vaultWideRecordScans, 0);
  assert.equal(largestRead, 2);
});

test('capture enforces count retention and collects only unreferenced blobs', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, {
    idFactory: ids('count'),
    retention: { count: 10, days: 365 },
    now: () => new Date('2026-08-19T12:00:00.000Z'),
    gcBatchSize: 100,
  });
  for (let index = 0; index < 12; index += 1) {
    await revisions.capture(note('counted', `version ${index}`, { updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` }), {
      createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  const records = await revisions.list('counted');
  assert.equal(records.length, 10);
  assert.equal((await revisions.materialize(records[0])).content, 'version 11');
  assert.equal((await revisions.materialize(records.at(-1))).content, 'version 2');
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 10);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 10);
});

test('concurrent capture requests serialize parent ordering', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('queued') });
  const [first, second] = await Promise.all([
    revisions.capture(note('queued', 'first'), { createdAt: '2026-08-19T10:00:00.000Z' }),
    revisions.capture(note('queued', 'second'), { createdAt: '2026-08-19T10:01:00.000Z' }),
  ]);
  assert.equal(second.revision.parentRevisionId, first.revision.id);
  assert.deepEqual((await revisions.list('queued')).map((record) => record.id), [second.revision.id, first.revision.id]);
});

test('per-note index preserves parent order when revisions share a timestamp', async () => {
  const storage = new MemoryStorage();
  const idValues = ['z-old', 'a-new'];
  const revisions = new RevisionStore(storage, { idFactory: () => idValues.shift() });
  const createdAt = '2026-08-20T00:00:00.000Z';
  await revisions.capture(note('same-time', 'old'), { createdAt });
  await revisions.capture(note('same-time', 'new'), { createdAt });
  const listed = await revisions.list('same-time', { materialize: true });
  assert.deepEqual(listed.map((entry) => entry.id), ['a-new', 'z-old']);
  assert.deepEqual(listed.map((entry) => entry.content), ['new', 'old']);
  assert.equal(listed[0].parentRevisionId, 'z-old');
});

test('age retention runs before count retention and always keeps the newest revision', async () => {
  let now = new Date('2026-07-01T12:00:00.000Z');
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, {
    idFactory: ids('age'),
    retention: { count: 50, days: 7 },
    now: () => now,
    gcBatchSize: 100,
  });
  await revisions.capture(note('aged', 'old 1'), { createdAt: '2026-07-01T12:00:00.000Z' });
  now = new Date('2026-07-02T12:00:00.000Z');
  await revisions.capture(note('aged', 'old 2'), { createdAt: '2026-07-02T12:00:00.000Z' });
  now = new Date('2026-08-19T12:00:00.000Z');
  await revisions.capture(note('aged', 'new'), { createdAt: '2026-08-19T12:00:00.000Z' });
  const records = await revisions.list('aged', { materialize: true });
  assert.deepEqual(records.map((entry) => entry.content), ['new']);
});

test('an unchanged durable save still removes expired older revisions', async () => {
  const storage = new MemoryStorage();
  let now = new Date('2026-01-02T00:00:00.000Z');
  const revisions = new RevisionStore(storage, {
    idFactory: ids('unchanged-age'),
    retention: { count: 50, days: 7 },
    now: () => new Date(now),
  });
  await revisions.capture(note('dormant', 'old'), { createdAt: '2026-01-01T00:00:00.000Z' });
  await revisions.capture(note('dormant', 'latest'), { createdAt: '2026-01-02T00:00:00.000Z' });
  now = new Date('2026-02-01T00:00:00.000Z');
  const unchanged = await revisions.capture(note('dormant', 'latest'), { createdAt: now.toISOString() });
  assert.equal(unchanged.captured, false);
  assert.equal(unchanged.pruned, 1);
  assert.deepEqual((await revisions.list('dormant')).map((record) => record.id), ['unchanged-age-2']);
});

test('failed revision pruning remains discoverable and is completed after reload', async () => {
  const storage = new MemoryStorage();
  const originalRemoveMany = storage.removeMany.bind(storage);
  const revisions = new RevisionStore(storage, {
    idFactory: ids('retry-prune'),
    retention: { count: 10, days: 7 },
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });
  await revisions.capture(note('retry-note', 'old'), { createdAt: '2026-08-01T00:00:00.000Z' });
  let failOnce = true;
  storage.removeMany = async (keys) => {
    if (failOnce) {
      failOnce = false;
      return false;
    }
    return originalRemoveMany(keys);
  };
  await assert.rejects(
    revisions.capture(note('retry-note', 'new'), { createdAt: '2026-08-20T00:00:00.000Z' }),
    (error) => error.code === 'revision_remove_failed',
  );
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.record), 2, 'failed removal leaves both authoritative records reachable');

  const reloaded = new RevisionStore(storage, {
    retention: { count: 10, days: 7 },
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });
  const reconciled = await reloaded.reconcileVaultNoteIds(['retry-note']);
  assert.equal(reconciled.pruned, 1);
  assert.deepEqual((await reloaded.list('retry-note', { materialize: true })).map((entry) => entry.content), ['new']);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.record), 1);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 1, 'startup retry also collects the pruned content blob');
});

test('quota pressure pauses optional history before a write', async () => {
  const storage = new MemoryStorage({ quota: { usage: 990, quota: 1000 } });
  const revisions = new RevisionStore(storage, { idFactory: ids('quota') });
  await assert.rejects(
    revisions.capture(note('quota', 'large enough to exceed the remaining quota')),
    (error) => error.code === 'quota_exceeded',
  );
  const status = await revisions.getStatus();
  assert.equal(status.paused, true);
  assert.equal(status.reason, 'quota');
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.record), 0);
});

test('runtime quota failures are classified and pause later captures', async () => {
  const quotaError = new DOMException('No space remains', 'QuotaExceededError');
  const storage = new MemoryStorage({ writeError: quotaError });
  const revisions = new RevisionStore(storage, { idFactory: ids('quota-write') });
  await assert.rejects(revisions.capture(note('q', 'one')), (error) => error.code === 'quota_exceeded');
  await assert.rejects(revisions.capture(note('q', 'two')), (error) => error.code === 'history_paused');
});

test('fallback storage refuses both revisions and local snapshots', async () => {
  const storage = new MemoryStorage({ backend: 'localstorage' });
  const revisions = new RevisionStore(storage, { idFactory: ids('fallback') });
  await assert.rejects(revisions.capture(note('a', 'x')), (error) => error.code === 'history_unavailable');
  await assert.rejects(revisions.createSnapshot([note('a', 'x')]), (error) => error.code === 'history_unavailable');
  assert.equal(storage.data.size, 0);
  assert.equal((await revisions.getStatus()).available, false);
});

test('malformed, incomplete, future, and tampered revisions are rejected', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('bad') });
  const captured = await revisions.capture(note('bad-note', 'good'));
  storage.data.delete(`${REVISION_STORAGE_PREFIXES.content}${captured.revision.contentHash}`);
  await assert.rejects(revisions.materialize(captured.revision.id), (error) => error.code === 'incomplete_revision');

  storage.data.set(`${REVISION_STORAGE_PREFIXES.record}future`, {
    ...captured.revision,
    id: 'future',
    schemaVersion: 2,
  });
  await assert.rejects(revisions.get('future'), (error) => error.code === 'future_revision_schema');
  storage.data.delete(`${REVISION_STORAGE_PREFIXES.record}future`);

  storage.data.set(`${REVISION_STORAGE_PREFIXES.record}malformed`, {
    ...captured.revision,
    id: 'malformed',
    reason: 'mystery',
  });
  const badIndexKey = `${REVISION_STORAGE_PREFIXES.index}${encodeURIComponent('bad-note')}`;
  storage.data.set(badIndexKey, [...storage.data.get(badIndexKey), 'malformed']);
  await assert.rejects(revisions.list('bad-note'), (error) => error.code === 'malformed_revision');
});

test('restore preparation validates first, captures safety state, and preserves identity/lifecycle fields', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('restore') });
  const original = note('restore-note', 'old', {
    title: 'Original',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  });
  const target = await revisions.capture(original, { reason: 'manual', createdAt: '2025-01-02T00:00:00.000Z' });
  const current = note('restore-note', 'current', {
    title: 'Current title',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    deletedAt: '2026-08-19T11:00:00.000Z',
    archivedAt: '2026-08-18T11:00:00.000Z',
  });
  const plan = await revisions.prepareRestore(current, target.revision.id, {
    restoredAt: '2026-08-19T12:30:00.000Z',
  });
  assert.equal(plan.safetyCapture.captured, true);
  assert.equal(plan.safetyCapture.revision.reason, 'pre_restore');
  assert.equal(plan.payload.id, 'restore-note');
  assert.equal(plan.payload.createdAt, current.createdAt);
  assert.equal(plan.payload.updatedAt, '2026-08-19T12:30:00.000Z');
  assert.equal(plan.payload.content, 'old');
  assert.equal(plan.payload.title, 'Original');
  assert.equal(plan.payload.deletedAt, current.deletedAt);
  assert.equal(plan.payload.archivedAt, current.archivedAt);
  assert.ok(await storage.load(`${REVISION_STORAGE_PREFIXES.record}${plan.safetyCapture.revision.id}`, null));

  const copy = createRestoreCopyPayload(plan.selectedRevision, {
    id: 'copy-id',
    createdAt: '2026-08-19T13:00:00.000Z',
    existingTitles: ['Original (restored copy)'],
  });
  assert.equal(copy.id, 'copy-id');
  assert.equal(copy.title, 'Original 2 (restored copy)');
  assert.equal(copy.parentId, null);
  assert.equal(copy.deletedAt, null);
  assert.equal(copy.archivedAt, null);
  assert.equal(copy.createdAt, copy.updatedAt);
});

test('daily and weekly snapshots reuse blobs, materialize, retain 7/4, and delete safely', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('snapshot'), gcBatchSize: 100 });
  const sourceVault = vault([note('one', 'shared'), note('two', 'shared', { title: 'Note one' })]);
  for (let index = 0; index < 8; index += 1) {
    await revisions.createSnapshot(sourceVault, { kind: 'daily', createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` });
  }
  for (let index = 0; index < 5; index += 1) {
    const day = String(index * 7 + 1).padStart(2, '0');
    await revisions.createSnapshot(sourceVault, { kind: 'weekly', createdAt: `2026-07-${day}T00:00:00.000Z` });
  }
  const daily = await revisions.listSnapshots({ kind: 'daily' });
  const weekly = await revisions.listSnapshots({ kind: 'weekly' });
  assert.equal(daily.length, 7);
  assert.equal(weekly.length, 4);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 1);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 3);
  const materialized = await revisions.materializeSnapshot(daily[0]);
  assert.deepEqual(materialized.notes.map((entry) => [entry.id, entry.content]), [['one', 'shared'], ['two', 'shared']]);
  assert.deepEqual(materialized.config, { themeMode: 'dark' });
  assert.equal(materialized.vaultSchemaVersion, 3);

  await revisions.deleteSnapshot(daily[0].id);
  assert.equal((await revisions.listSnapshots({ kind: 'daily' })).length, 6);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 1, 'weekly snapshots still reference the blob');
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 3, 'weekly snapshots still reference note metadata and config');
});

test('snapshot creation is idempotent within each UTC daily or weekly period', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('period') });
  const sourceVault = vault([note('period-note', 'one')]);
  const daily = await revisions.createSnapshot(sourceVault, { kind: 'daily', createdAt: '2026-08-19T01:00:00.000Z' });
  const repeatedDaily = await revisions.createSnapshot(vault([note('period-note', 'changed')]), {
    kind: 'daily',
    createdAt: '2026-08-19T23:00:00.000Z',
  });
  const weekly = await revisions.createSnapshot(sourceVault, { kind: 'weekly', createdAt: '2026-08-17T01:00:00.000Z' });
  const repeatedWeekly = await revisions.createSnapshot(sourceVault, { kind: 'weekly', createdAt: '2026-08-23T23:00:00.000Z' });
  assert.equal(daily.created, true);
  assert.equal(repeatedDaily.created, false);
  assert.equal(repeatedDaily.snapshot.id, daily.snapshot.id);
  assert.equal(weekly.created, true);
  assert.equal(repeatedWeekly.created, false);
  assert.equal(repeatedWeekly.snapshot.id, weekly.snapshot.id);
  assert.equal((await revisions.listSnapshots()).length, 2);
});

test('same-period retry and startup reconciliation repair interrupted snapshot retention', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('snapshot-retry'), gcBatchSize: 100 });
  const sourceVault = vault([note('retained-note', 'snapshot bytes')]);
  for (let day = 1; day <= 7; day += 1) {
    await revisions.createSnapshot(sourceVault, {
      kind: 'daily',
      createdAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  const originalRemoveMany = storage.removeMany.bind(storage);
  let failOnce = true;
  storage.removeMany = async (keys) => {
    if (failOnce && [...keys].some((key) => key.startsWith(REVISION_STORAGE_PREFIXES.snapshotRecord))) {
      failOnce = false;
      return false;
    }
    return originalRemoveMany(keys);
  };
  await assert.rejects(
    revisions.createSnapshot(sourceVault, { kind: 'daily', createdAt: '2026-08-08T00:00:00.000Z' }),
    (error) => error.code === 'revision_remove_failed',
  );
  assert.equal((await revisions.listSnapshots({ kind: 'daily' })).length, 8);

  const reloaded = new RevisionStore(storage, { gcBatchSize: 100 });
  const samePeriod = await reloaded.createSnapshot(sourceVault, {
    kind: 'daily',
    createdAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(samePeriod.created, false);
  assert.equal(samePeriod.pruned, 1);
  assert.equal((await reloaded.listSnapshots({ kind: 'daily' })).length, 7);

  const oldest = (await reloaded.listSnapshots({ kind: 'daily' })).at(-1);
  storage.data.set(`${REVISION_STORAGE_PREFIXES.snapshotRecord}startup-overflow`, {
    ...oldest,
    id: 'startup-overflow',
    createdAt: '2026-07-01T00:00:00.000Z',
    period: '2026-07-01',
  });
  const restarted = new RevisionStore(storage, { gcBatchSize: 100 });
  const reconciled = await restarted.reconcileVaultNoteIds(['retained-note']);
  assert.equal(reconciled.snapshotsPruned, 1);
  assert.equal((await restarted.listSnapshots({ kind: 'daily' })).length, 7);
});

test('revision and snapshot health timestamps survive a store reload', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('status') });
  await revisions.capture(note('status-note', 'captured'), { createdAt: '2026-08-19T10:00:00.000Z' });
  await revisions.createSnapshot(vault([note('status-note', 'captured')]), {
    kind: 'daily',
    createdAt: '2026-08-20T11:00:00.000Z',
  });
  const reloaded = new RevisionStore(storage);
  const status = await reloaded.getStatus();
  assert.equal(status.lastRevisionAt, '2026-08-19T10:00:00.000Z');
  assert.equal(status.lastLocalSnapshotAt, '2026-08-20T11:00:00.000Z');
});

test('snapshot pruning drains every orphan through bounded garbage-collection batches', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('drain'), gcBatchSize: 25 });
  let lastResult;
  for (let day = 1; day <= 8; day += 1) {
    const notes = Array.from({ length: 30 }, (_, index) => note(
      `day-${day}-note-${index}`,
      `unique content ${day}:${index}`,
    ));
    lastResult = await revisions.createSnapshot(vault(notes), {
      kind: 'daily',
      createdAt: `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    });
  }

  assert.equal(lastResult.pruned, 1);
  assert.equal(lastResult.garbageCollected, 60, '30 content and 30 metadata blobs exceed one 25-key batch');
  assert.equal((await revisions.listSnapshots({ kind: 'daily' })).length, 7);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 210);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 211, '210 note metadata blobs plus shared config');
  assert.equal([...storage.data.values()].some((value) => typeof value === 'string' && value.includes('day-1-note')), false);
});

test('snapshot config and vault schema are required and hash-verified', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('config') });
  await assert.rejects(
    revisions.createSnapshot({ notes: [note('one', 'x')], schemaVersion: 3 }),
    (error) => error.code === 'malformed_snapshot',
  );
  await assert.rejects(
    revisions.createSnapshot({ notes: [note('one', 'x')], config: {} }),
    (error) => error.code === 'malformed_snapshot',
  );
  const created = await revisions.createSnapshot(vault([note('one', 'x')], { themeMode: 'dark', showGraph: true }));
  storage.data.set(`${REVISION_STORAGE_PREFIXES.metadata}${created.snapshot.configHash}`, canonicalJson({ themeMode: 'light' }));
  await assert.rejects(
    revisions.materializeSnapshot(created.snapshot.id),
    (error) => error.code === 'snapshot_integrity_failed',
  );
});

test('garbage collection never removes blobs still referenced by a snapshot', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('shared'), gcBatchSize: 100 });
  const captured = await revisions.capture(note('shared', 'same bytes'));
  const created = await revisions.createSnapshot(vault([note('shared', 'same bytes')]), { kind: 'daily' });
  await storage.removeMany([`${REVISION_STORAGE_PREFIXES.record}${captured.revision.id}`]);
  await revisions.garbageCollect();
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 1);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 2, 'snapshot retains note metadata and config');
  await revisions.deleteSnapshot(created.snapshot.id);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 0);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 0);
});

test('startup reconciliation retries orphan cleanup interrupted after record deletion', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('retry-gc'), gcBatchSize: 100 });
  await revisions.capture(note('deleted-before-gc', 'private bytes'));
  const originalRemoveMany = storage.removeMany.bind(storage);
  let failBlobSweepOnce = true;
  storage.removeMany = async (keys) => {
    const isBlobSweep = [...keys].some((key) => (
      key.startsWith(REVISION_STORAGE_PREFIXES.content)
      || key.startsWith(REVISION_STORAGE_PREFIXES.metadata)
    ));
    if (isBlobSweep && failBlobSweepOnce) {
      failBlobSweepOnce = false;
      return false;
    }
    return originalRemoveMany(keys);
  };
  await assert.rejects(
    revisions.deleteNoteHistory('deleted-before-gc'),
    (error) => error.code === 'revision_remove_failed',
  );
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.record), 0, 'history record deletion committed before the interrupted blob sweep');
  assert.ok(countKeys(storage, REVISION_STORAGE_PREFIXES.content) > 0, 'orphaned content remains for startup retry');

  const reloaded = new RevisionStore(storage, { gcBatchSize: 100 });
  const reconciled = await reloaded.reconcileVaultNoteIds([]);
  assert.ok(reconciled.garbageCollected >= 2);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 0);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 0);
});

test('garbage collection is bounded and aborts when a record is malformed', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { idFactory: ids('gc'), gcBatchSize: 1 });
  storage.data.set(`${REVISION_STORAGE_PREFIXES.content}${'a'.repeat(64)}`, 'orphan one');
  storage.data.set(`${REVISION_STORAGE_PREFIXES.metadata}${'b'.repeat(64)}`, '{}');
  const first = await revisions.garbageCollect();
  assert.deepEqual(first, { removed: 1, remaining: 1 });
  storage.data.set(`${REVISION_STORAGE_PREFIXES.snapshotRecord}bad`, { id: 'bad', schemaVersion: 1 });
  await assert.rejects(revisions.garbageCollect(), (error) => error instanceof RevisionStoreError && error.code === 'malformed_snapshot');
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.metadata), 1);
});

test('draining a large orphan backlog scans references once while keeping delete batches bounded', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, { gcBatchSize: 25 });
  for (let index = 0; index < 100; index += 1) {
    storage.data.set(`${REVISION_STORAGE_PREFIXES.content}${String(index).padStart(64, '0')}`, `orphan-${index}`);
  }
  const originalKeys = storage.keys.bind(storage);
  const scans = new Map();
  storage.keys = async (prefix = '') => {
    scans.set(prefix, (scans.get(prefix) ?? 0) + 1);
    return originalKeys(prefix);
  };

  const result = await revisions.garbageCollectAll();
  assert.deepEqual(result, { removed: 100, remaining: 0, batches: 4 });
  assert.equal(scans.get(REVISION_STORAGE_PREFIXES.record), 1);
  assert.equal(scans.get(REVISION_STORAGE_PREFIXES.snapshotRecord), 1);
  assert.equal(scans.get(REVISION_STORAGE_PREFIXES.content), 1);
  assert.equal(scans.get(REVISION_STORAGE_PREFIXES.metadata), 1);
  assert.equal(countKeys(storage, REVISION_STORAGE_PREFIXES.content), 0);
});

test('origin-wide mutation locking prevents cross-instance capture and GC interleaving', async () => {
  const storage = new SharedLockStorage();
  const first = new RevisionStore(storage, { idFactory: ids('first'), gcBatchSize: 100 });
  const second = new RevisionStore(storage, { idFactory: ids('second'), gcBatchSize: 100 });
  storage.data.set(`${REVISION_STORAGE_PREFIXES.content}${'a'.repeat(64)}`, 'old orphan');
  const originalKeys = storage.keys.bind(storage);
  let releaseScan;
  let reachedBlobScan;
  const atBlobScan = new Promise((resolve) => { reachedBlobScan = resolve; });
  const continueScan = new Promise((resolve) => { releaseScan = resolve; });
  let blockOnce = true;
  storage.keys = async (prefix = '') => {
    if (blockOnce && prefix === REVISION_STORAGE_PREFIXES.content) {
      blockOnce = false;
      reachedBlobScan();
      await continueScan;
    }
    return originalKeys(prefix);
  };

  const collecting = first.garbageCollect();
  await atBlobScan;
  let captureFinished = false;
  const capturing = second.capture(note('concurrent', 'new durable bytes'))
    .then((result) => { captureFinished = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captureFinished, false, 'the second store waits for the origin-wide lock');
  releaseScan();
  const [, captured] = await Promise.all([collecting, capturing]);
  const restored = await second.materialize(captured.revision.id);
  assert.equal(restored.content, 'new durable bytes');
});

test('startup reconciliation does not perform per-note reads for a large vault without history', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage);
  const originalLoad = storage.load.bind(storage);
  const originalKeys = storage.keys.bind(storage);
  let indexLoads = 0;
  let recordScans = 0;
  storage.load = async (key, fallback) => {
    if (key.startsWith(REVISION_STORAGE_PREFIXES.index)) indexLoads += 1;
    return originalLoad(key, fallback);
  };
  storage.keys = async (prefix = '') => {
    if (prefix === REVISION_STORAGE_PREFIXES.record) recordScans += 1;
    return originalKeys(prefix);
  };
  await revisions.reconcileVaultNoteIds(Array.from({ length: 1_000 }, (_, index) => `note-${index}`));
  assert.equal(recordScans, 2, 'one reconciliation scan plus one unconditional orphan-GC scan');
  assert.equal(indexLoads, 0);
});
