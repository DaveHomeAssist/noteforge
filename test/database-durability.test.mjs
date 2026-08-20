import { Database } from '../src/core/database.js';
import { CURRENT_SCHEMA_VERSION } from '../src/core/migrations.js';

let assertions = 0;
function ok(name, condition) {
  assertions += 1;
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`ok ${assertions} - ${name}`);
}

function memoryBackend({ failNotes = false } = {}) {
  const values = new Map();
  return {
    values,
    async load(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async save(key, value) {
      if (failNotes && key === 'notes') return false;
      values.set(key, structuredClone(value));
      return true;
    },
  };
}

{
  const originalIndexedDB = globalThis.indexedDB;
  const originalLocalStorage = globalThis.localStorage;
  const staleFallback = new Map([
    ['my-notes-app:notes', JSON.stringify([{ id: 'stale', title: 'Stale fallback', content: 'old' }])],
    ['my-notes-app:schemaVersion', JSON.stringify(3)],
  ]);
  let transactionCalls = 0;
  globalThis.localStorage = {
    get length() { return staleFallback.size; },
    key(index) { return [...staleFallback.keys()][index] ?? null; },
    getItem(key) { return staleFallback.get(key) ?? null; },
    setItem(key, value) { staleFallback.set(key, value); },
    removeItem(key) { staleFallback.delete(key); },
  };
  globalThis.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          // This represents an already-open authoritative database containing
          // newer data; a transient transaction failure must not expose the
          // older migration source as if it were current.
          authoritativeValues: new Map([
            ['notes', [{ id: 'newer', title: 'Newer IndexedDB note', content: 'current' }]],
            ['schemaVersion', 3],
          ]),
          objectStoreNames: { contains: () => true },
          transaction() {
            transactionCalls += 1;
            throw new DOMException('simulated IndexedDB read failure', 'UnknownError');
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  try {
    const { storage } = await import(`../src/core/storage.js?read-failure=${Date.now()}`);
    const db = new Database({ storageBackend: storage });
    let initError = null;
    try { await db.init(); } catch (error) { initError = error; }
    ok('an authoritative IndexedDB read failure rejects initialization instead of hydrating stale fallback notes',
      initError?.name === 'UnknownError' && transactionCalls === 1 && db.getNote('stale') === null);

    let batchRejected = false;
    try { await storage.loadMany(['notes', 'config'], null); } catch { batchRejected = true; }
    ok('an authoritative IndexedDB batch-read failure rejects instead of returning stale fallback values', batchRejected);

    let enumerationRejected = false;
    try { await storage.keys(); } catch { enumerationRejected = true; }
    ok('an authoritative IndexedDB enumeration failure rejects instead of returning stale fallback keys', enumerationRejected);
  } finally {
    if (originalIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDB;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
}

{
  const backend = memoryBackend();
  const captures = [];
  const db = new Database({
    storageBackend: backend,
    onNotesPersisted(batch) {
      const stored = backend.values.get('notes');
      captures.push({ batch, stored });
    },
  });
  const note = db.createNote({ id: 'durable', title: 'Draft', content: '' });
  await db.flush();
  note.update({ content: 'Committed Markdown' });
  db.saveNote(note);
  await db.flush();

  ok('revision capture runs once for the first durable edit', captures.length === 1);
  ok('revision capture runs after the matching note snapshot is durable',
    captures[0].stored.find((item) => item.id === note.id)?.content === 'Committed Markdown');
  ok('revision capture receives an immutable JSON-shaped note snapshot',
    captures[0].batch[0].note !== note && captures[0].batch[0].note.content === 'Committed Markdown');
  ok('revision capture receives the durable-boundary reason', captures[0].batch[0].reason === 'autosave');
}

{
  const backend = memoryBackend();
  const db = new Database({ storageBackend: backend });
  const note = db.createNote({ id: 'lazy-history', title: 'Lazy history' });
  await db.flush();
  note.update({ content: 'committed before recovery loaded' });
  db.saveNote(note);
  await db.flush();
  const buffered = [];
  await db.connectHistoryHandlers({
    onNotesPersisted: (captures) => buffered.push(...captures),
    onNotesPurged: () => {},
  });
  ok('durable revisions buffered before lazy recovery initialization are drained exactly once',
    buffered.length === 1 && buffered[0].note.content === 'committed before recovery loaded');
}

{
  const backend = memoryBackend({ failNotes: true });
  let captured = false;
  let persistError = null;
  const db = new Database({ storageBackend: backend, onNotesPersisted() { captured = true; } });
  db.onPersistError = (key) => { persistError = key; };
  db.createNote({ id: 'failed', title: 'Failed write' });
  await db.flushCurrentWrites();

  ok('a failed current-note write reports the authoritative key', persistError === 'notes');
  ok('a failed current-note write never creates revision history', captured === false);
}

{
  const backend = memoryBackend();
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const db = new Database({ storageBackend: backend, onNotesPersisted: () => historyGate });
  const note = db.createNote({ id: 'priority', title: 'Priority' });
  await db.flushCurrentWrites();
  note.update({ content: 'Saved before optional history' });
  db.saveNote(note);
  const result = await Promise.race([
    db.flushCurrentWrites().then(() => 'saved'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ]);

  ok('optional history never blocks current-note durability', result === 'saved');
  releaseHistory();
  await db.flush();
}

{
  const backend = memoryBackend();
  let degraded = false;
  const db = new Database({
    storageBackend: backend,
    onNotesPersisted() { throw new Error('history quota'); },
  });
  db.onHistoryError = () => { degraded = true; };
  const note = db.createNote({ id: 'degraded', title: 'Still durable' });
  await db.flushCurrentWrites();
  note.update({ content: 'authoritative content' });
  db.saveNote(note);
  await db.flush();

  ok('revision failure is reported separately', degraded === true);
  ok('revision failure does not roll back the durable current note',
    backend.values.get('notes')?.find((item) => item.id === note.id)?.content === 'authoritative content');
}

{
  const backend = memoryBackend();
  const boundaries = [];
  const db = new Database({
    storageBackend: backend,
    onNotesPersisted(batch) { boundaries.push(batch); },
  });
  const note = db.createNote({ id: 'restore-target', title: 'Before restore', content: 'safe state' });
  await db.flush();
  const available = await db.captureRevisionBoundary([note], 'pre_restore');

  ok('explicit destructive boundary reports available history', available === true);
  ok('explicit destructive boundary captures the requested reason and exact state',
    boundaries.length === 1
      && boundaries[0][0].reason === 'pre_restore'
      && boundaries[0][0].note.content === 'safe state');
  note.content = 'mutated after boundary';
  ok('explicit destructive boundary detaches its safety snapshot', boundaries[0][0].note.content === 'safe state');
}

{
  const db = new Database({ storageBackend: memoryBackend() });
  const note = db.createNote({ id: 'fallback', title: 'No history' });
  await db.flush();
  ok('explicit destructive boundary reports unavailable history without a capture service',
    await db.captureRevisionBoundary([note], 'pre_restore') === false);
}

{
  const backend = memoryBackend();
  backend.saveMany = async (entries) => {
    const next = new Map(backend.values);
    entries.forEach(([key, value]) => next.set(key, structuredClone(value)));
    backend.values.clear();
    next.forEach((value, key) => backend.values.set(key, value));
    return true;
  };
  const db = new Database({ storageBackend: backend });
  db.createNote({ id: 'old', title: 'Old vault' });
  await db.flush();
  let emitted = 0;
  db.subscribe(() => { emitted += 1; });
  const restored = await db.replaceVault({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: [{
      id: 'restored', title: 'Restored', content: 'exact', tags: [],
      banner: { position: 25, type: 'gradient', value: 'linear-gradient(90deg, #111, #222)' },
      createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T11:00:00.000Z',
      deletedAt: null, pinned: false, parentId: null, aliases: ['Previous restored title'], archivedAt: null,
      futureMetadata: { kept: true, order: ['z', 'a'] },
      ...JSON.parse('{"__proto__":{"polluted":true}}'),
    }],
    config: { showGraph: true, custom: 'kept' },
  });

  ok('verified vault replacement commits the complete batch', restored === true
    && backend.values.get('notes')[0].id === 'restored'
    && backend.values.get('config').custom === 'kept'
    && backend.values.get('schemaVersion') === CURRENT_SCHEMA_VERSION);
  ok('verified vault replacement updates memory only after persistence', db.getNote('restored')?.content === 'exact' && db.getNote('old') === null);
  ok('verified vault replacement preserves additive note metadata without prototype pollution',
    db.getNote('restored').toJSON().futureMetadata.kept === true
      && Object.hasOwn(db.getNote('restored').toJSON(), '__proto__')
      && backend.values.get('notes')[0].__proto__.polluted === true
      && Object.prototype.polluted === undefined);
  ok('verified vault replacement compares valid banner JSON independent of object key order',
    db.getNote('restored').banner.type === 'gradient' && db.getNote('restored').banner.position === 25);
  ok('verified vault replacement emits one coherent store update', emitted === 1);
}

{
  const backend = memoryBackend();
  backend.getStatus = async () => ({ backend: 'indexeddb' });
  let fallbackOption = null;
  backend.saveMany = async (_entries, options) => {
    fallbackOption = options.allowFallback;
    return false;
  };
  const db = new Database({ storageBackend: backend });
  db.createNote({ id: 'preserved', title: 'Preserved' });
  await db.flush();
  const result = await db.replaceVault({ schemaVersion: CURRENT_SCHEMA_VERSION, notes: [], config: {} });
  ok('failed IndexedDB vault replacement forbids fallback and leaves memory untouched',
    result === false && fallbackOption === false && db.getNote('preserved') !== null);
}

{
  const db = new Database({ storageBackend: memoryBackend() });
  const malformed = {
    id: 'unsafe', title: 'Unsafe', content: '', tags: [],
    banner: { type: 'image', value: 'javascript:alert(1)', position: 50 },
    createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z',
    deletedAt: null, pinned: false, parentId: null, aliases: [], archivedAt: null,
  };
  let rejected = false;
  try {
    await db.replaceVault({ schemaVersion: CURRENT_SCHEMA_VERSION, notes: [malformed], config: {} });
  } catch (error) {
    rejected = /cannot be applied exactly/.test(error.message);
  }
  ok('vault replacement rejects metadata the Note model would silently normalize', rejected === true);
}

{
  const backend = memoryBackend();
  const purged = [];
  const db = new Database({ storageBackend: backend, onNotesPurged: (ids) => purged.push(...ids) });
  db.createNote({ id: 'coalesced-purge', title: 'Delete me' });
  await db.flush();
  const originalSave = backend.save.bind(backend);
  let releaseConfig;
  const configGate = new Promise((resolve) => { releaseConfig = resolve; });
  let blockConfig = true;
  backend.save = async (key, value) => {
    if (key === 'config' && blockConfig) {
      blockConfig = false;
      await configGate;
    }
    return originalSave(key, value);
  };
  db.setConfig({ queued: true });
  db.purgeNote('coalesced-purge');
  db.createNote({ id: 'later-write', title: 'Later write' });
  releaseConfig();
  await db.flush();
  ok('coalesced note writes retain post-commit purge cleanup metadata',
    purged.length === 1 && purged[0] === 'coalesced-purge');
}

{
  const backend = memoryBackend();
  const purged = [];
  const db = new Database({ storageBackend: backend, onNotesPurged: (ids) => purged.push(...ids) });
  db.createNote({ id: 'failed-in-flight-purge', title: 'Delete after failure' });
  await db.flush();
  const originalSave = backend.save.bind(backend);
  let releaseFailure;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  let failNextNotes = true;
  backend.save = async (key, value) => {
    if (key === 'notes' && failNextNotes) {
      failNextNotes = false;
      await failureGate;
      return false;
    }
    return originalSave(key, value);
  };
  db.purgeNote('failed-in-flight-purge');
  db.createNote({ id: 'successor', title: 'Successor write' });
  releaseFailure();
  await db.flush();
  await db.flush();
  ok('failed in-flight note writes hand purge cleanup metadata to the durable successor',
    purged.includes('failed-in-flight-purge')
      && backend.values.get('notes').map((note) => note.id).join(',') === 'successor');
}

{
  const db = new Database({ storageBackend: memoryBackend() });
  await db.flush();
  await db.flushCurrentWrites();
  ok('empty and consecutive database flushes settle without spinning', db.getPersistenceStatus().pendingWrites === 0);
}

{
  const backend = memoryBackend();
  const db = new Database({ storageBackend: backend });
  db.createNote({ id: 'timestamped', title: 'Timestamped' });
  await db.flush();
  const persistedAt = db.getPersistenceStatus().lastPersistedAt;
  const reloaded = new Database({ storageBackend: backend });
  await reloaded.init();
  ok('last current-note persistence timestamp survives a database reload',
    Number.isFinite(Date.parse(persistedAt)) && reloaded.getPersistenceStatus().lastPersistedAt === persistedAt);
}

{
  const backend = memoryBackend();
  let failNotes = false;
  const originalSave = backend.save.bind(backend);
  backend.save = async (key, value) => (failNotes && key === 'notes' ? false : originalSave(key, value));
  backend.saveMany = async (entries) => {
    const next = new Map(backend.values);
    entries.forEach(([key, value]) => next.set(key, structuredClone(value)));
    backend.values.clear();
    next.forEach((value, key) => backend.values.set(key, value));
    return true;
  };
  const db = new Database({ storageBackend: backend });
  const old = db.createNote({ id: 'old-vault', title: 'Old vault', content: 'queued old state' });
  await db.flush();
  failNotes = true;
  old.update({ content: 'failed queued state' });
  db.saveNote(old);
  await db.flush();
  const blocked = await db.replaceVault({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: [{
      id: 'new-vault', title: 'New vault', content: 'restored', tags: [], banner: null,
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      deletedAt: null, pinned: false, parentId: null, aliases: [], archivedAt: null,
    }],
    config: {},
  });
  ok('vault replacement fails closed while a stale authoritative note write remains queued',
    blocked === false && db.getNote('old-vault') !== null && backend.values.get('notes')[0].id === 'old-vault');
  failNotes = false;
  await db.flush();
}

console.log(`\n${assertions} database durability assertions passed.`);
