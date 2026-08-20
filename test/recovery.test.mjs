import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/database.js';
import { RecoveryService } from '../src/core/recovery-service.js';
import { REVISION_STORAGE_PREFIXES, RevisionStore } from '../src/core/revision-store.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async ready() { return true; },
    async getStatus() {
      return {
        backend: 'indexeddb',
        degraded: false,
        historyAvailable: true,
        capabilities: { revisionHistory: true, localSnapshots: true, atomicBatch: true },
        quota: { usage: 1000, quota: 10_000_000 },
      };
    },
    async load(key, fallback = null) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    async save(key, value) { values.set(key, structuredClone(value)); return true; },
    async remove(key) { values.delete(key); },
    async keys(prefix = '') { return [...values.keys()].filter((key) => key.startsWith(prefix)).sort(); },
    async loadMany(keys, fallback = null) {
      return keys.map((key) => values.has(key) ? structuredClone(values.get(key)) : fallback);
    },
    async saveMany(entries) {
      const next = new Map(values);
      entries.forEach(([key, value]) => next.set(key, structuredClone(value)));
      values.clear();
      next.forEach((value, key) => values.set(key, value));
      return true;
    },
    async removeMany(keys) { keys.forEach((key) => values.delete(key)); return true; },
  };
}

function harness() {
  const storage = memoryStorage();
  let sequence = 0;
  let now = new Date('2026-08-19T12:00:00.000Z');
  const revisionStore = new RevisionStore(storage, {
    idFactory: () => `recovery-${++sequence}`,
    now: () => new Date(now),
  });
  const db = new Database({ storageBackend: storage });
  const downloads = [];
  const recovery = new RecoveryService({
    db,
    revisionStore,
    storage,
    now: () => new Date(now),
    download: (text, filename, type) => downloads.push({ text, filename, type }),
  });
  return {
    db,
    recovery,
    revisionStore,
    storage,
    downloads,
    advance(hours = 1) { now = new Date(now.getTime() + hours * 60 * 60 * 1000); },
  };
}

test('durable edits capture revisions and restore creates a safety revision first', async () => {
  const h = harness();
  const note = h.db.createNote({
    id: 'note-1',
    title: 'Recovery note',
    content: 'initial',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  await h.db.flush();

  note.update({ content: 'first durable edit' });
  h.db.saveNote(note);
  await h.db.flush();
  h.advance();
  note.update({ content: 'second durable edit' });
  h.db.saveNote(note);
  await h.db.flush();

  const beforeRestore = await h.recovery.listRevisions(note.id);
  assert.equal(beforeRestore.length, 2);
  const selected = beforeRestore.find((revision) => revision.parentRevisionId === null);
  const restored = await h.recovery.restore({ noteId: note.id, revisionId: selected.id });

  assert.equal(restored.note.id, note.id);
  assert.equal(restored.note.createdAt, '2026-08-01T00:00:00.000Z');
  assert.equal(restored.note.content, 'first durable edit');
  assert.equal(h.db.getNote(note.id).content, 'first durable edit');
  const afterRestore = await h.recovery.listRevisions(note.id);
  assert.equal(afterRestore.length, 3);
  assert.equal(afterRestore[0].reason, 'pre_restore');
  assert.equal((await h.revisionStore.materialize(afterRestore[0])).content, 'second durable edit');
});

test('restore as copy leaves the original untouched and uses a non-colliding top-level identity', async () => {
  const h = harness();
  const original = h.db.createNote({ id: 'original', title: 'Same title', content: 'version one', parentId: 'parent' });
  await h.db.flush();
  original.update({ content: 'version two' });
  h.db.saveNote(original);
  await h.db.flush();
  h.db.createNote({ id: 'collision', title: 'Same title (restored copy)', content: '' });
  await h.db.flush();
  const revision = (await h.recovery.listRevisions(original.id))[0];

  const result = await h.recovery.restoreAsCopy({ noteId: original.id, revisionId: revision.id });
  assert.notEqual(result.note.id, original.id);
  assert.equal(result.note.title, 'Same title 2 (restored copy)');
  assert.equal(result.note.parentId, null);
  assert.equal(result.note.deletedAt, null);
  assert.equal(result.note.content, 'version two');
  assert.equal(h.db.getNote(original.id).content, 'version two');
});

test('rolling local snapshots preserve notes, Trash, config, and are period-idempotent', async () => {
  const h = harness();
  const live = h.db.createNote({ id: 'live', title: 'Live', content: 'markdown' });
  const trashed = h.db.createNote({ id: 'trash', title: 'Trash', content: 'recover me' });
  h.db.deleteNote(trashed.id);
  h.db.setConfig({ themeMode: 'dark', unknownSetting: { kept: true } });
  await h.db.flush();

  const first = await h.recovery.ensureRollingSnapshots();
  const second = await h.recovery.ensureRollingSnapshots();
  assert.equal(first.daily.snapshot.id, second.daily.snapshot.id);
  assert.equal(first.weekly.snapshot.id, second.weekly.snapshot.id);
  assert.equal((await h.recovery.listLocalSnapshots()).length, 2);
  const materialized = await h.revisionStore.materializeSnapshot(first.daily.snapshot.id);
  assert.deepEqual(materialized.notes.map((note) => note.id), [live.id, trashed.id]);
  assert.equal(materialized.notes.find((note) => note.id === trashed.id).deletedAt !== null, true);
  assert.deepEqual(materialized.config.unknownSetting, { kept: true });
  assert.equal(materialized.vaultSchemaVersion, 3);
});

test('storage health reports queued failed current-note writes even when the backend otherwise looks healthy', async () => {
  const h = harness();
  const originalSave = h.storage.save.bind(h.storage);
  h.storage.save = async (key, value) => (key === 'notes' ? false : originalSave(key, value));
  h.db.createNote({ id: 'unsaved-health', title: 'Unsaved', content: 'not durable yet' });
  await h.db.flushCurrentWrites();

  const health = await h.recovery.getStorageHealth();
  assert.equal(health.backend, 'indexeddb');
  assert.equal(health.pendingWrites, 1);
  assert.equal(health.degraded, true);
  assert.match(health.error, /not yet durably saved/i);
});

test('portable backup verifies, previews exact replacement, downloads safety, and restores atomically', async () => {
  const h = harness();
  h.db.createNote({
    id: 'keep',
    title: 'Keep',
    content: 'portable',
    futureMetadata: { kept: true, nested: { order: ['z', 'a'] } },
  });
  const trashed = h.db.createNote({ id: 'trashed', title: 'Trashed', content: 'also portable' });
  h.db.deleteNote(trashed.id);
  h.db.setConfig({ custom: 'preserved' });
  await h.db.flush();

  const backup = await h.recovery.createBackup();
  const verified = await h.recovery.verifyBackup(backup.text);
  h.db.createNote({ id: 'remove-on-restore', title: 'Later', content: 'temporary' });
  await h.db.flush();
  const plan = await h.recovery.previewRestore({ verified });
  assert.deepEqual(plan.summary.removedIds, ['remove-on-restore']);
  assert.equal(plan.summary.trashedNoteCount, 1);

  await assert.rejects(() => h.recovery.restoreBackup({ confirmed: false, plan }), /explicit confirmation/);
  plan.restoreState.notes.find((note) => note.id === 'keep').content = 'tampered preview';
  const result = await h.recovery.restoreBackup({ confirmed: true, plan, type: 'portable', verified });
  assert.equal(result.restored, true);
  assert.equal(h.db.getNote('keep').content, 'portable');
  assert.deepEqual(h.db.getNote('keep').toJSON().futureMetadata, { kept: true, nested: { order: ['z', 'a'] } });
  assert.deepEqual(h.storage.values.get('notes').find((note) => note.id === 'keep').futureMetadata,
    { kept: true, nested: { order: ['z', 'a'] } });
  assert.equal(h.db.getNote('remove-on-restore'), null);
  assert.equal(h.db.getTrash()[0].id, 'trashed');
  assert.equal(h.db.config.custom, 'preserved');
  assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0].filename, /^noteforge-pre-restore-/);
});

test('permanent purge removes single-note and empty-Trash revision history after persistence', async () => {
  const h = harness();
  const first = h.db.createNote({ id: 'purge-one', title: 'One', content: 'initial' });
  const second = h.db.createNote({ id: 'purge-two', title: 'Two', content: 'initial' });
  await h.db.flush();
  first.update({ content: 'captured one' });
  second.update({ content: 'captured two' });
  h.db.saveNote(first);
  h.db.saveNote(second);
  await h.db.flush();
  assert.equal((await h.revisionStore.list(first.id)).length, 1);
  assert.equal((await h.revisionStore.list(second.id)).length, 1);
  await h.revisionStore.createSnapshot(h.recovery.vaultState(), {
    kind: 'daily',
    createdAt: '2026-08-19T12:00:00.000Z',
  });
  assert.equal((await h.revisionStore.listSnapshots()).length, 1);

  h.db.deleteNote(first.id);
  h.db.deleteNote(second.id);
  await h.db.flush();
  h.db.purgeNote(first.id);
  await h.db.flush();
  assert.equal((await h.revisionStore.list(first.id)).length, 0);
  assert.equal((await h.revisionStore.list(second.id)).length, 1);
  assert.equal((await h.revisionStore.listSnapshots()).length, 0, 'snapshots containing a permanently purged note are removed');

  assert.equal(h.db.emptyTrash(), 1);
  await h.db.flush();
  assert.equal((await h.revisionStore.list(second.id)).length, 0);
  assert.equal((await h.storage.keys(REVISION_STORAGE_PREFIXES.record)).length, 0);
  assert.equal((await h.storage.keys(REVISION_STORAGE_PREFIXES.content)).length, 0);
  assert.equal((await h.storage.keys(REVISION_STORAGE_PREFIXES.metadata)).length, 0);
});

test('startup reconciliation finishes interrupted permanent-purge cleanup', async () => {
  const h = harness();
  const note = h.db.createNote({ id: 'interrupted-purge', title: 'Interrupted', content: 'initial' });
  await h.db.flush();
  note.update({ content: 'retained history' });
  h.db.saveNote(note);
  await h.db.flush();
  await h.revisionStore.createSnapshot(h.recovery.vaultState(), {
    kind: 'daily',
    createdAt: '2026-08-19T12:00:00.000Z',
  });
  h.db.onNotesPurged = async () => { throw new Error('simulated cleanup interruption'); };
  h.db.deleteNote(note.id);
  await h.db.flush();
  h.db.purgeNote(note.id);
  await h.db.flush();
  assert.equal((await h.revisionStore.list(note.id)).length, 1);
  assert.equal((await h.revisionStore.listSnapshots()).length, 1);

  const reloadedDb = new Database({ storageBackend: h.storage });
  await reloadedDb.init();
  let reconcileSequence = 0;
  const reloadedRevisions = new RevisionStore(h.storage, { idFactory: () => `reconcile-${++reconcileSequence}` });
  const reloadedRecovery = new RecoveryService({
    db: reloadedDb,
    revisionStore: reloadedRevisions,
    storage: h.storage,
    download: () => {},
  });
  await reloadedRecovery.ready;
  assert.equal((await reloadedRevisions.list(note.id)).length, 0);
  assert.equal((await reloadedRevisions.listSnapshots()).length, 0);
});
