import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { Phase5Controller } from '../src/app/phase5.js';
import { createBackup, createRestorePreview, verifyBackup } from '../src/core/backup.js';
import { Database } from '../src/core/database.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/core/migrations.js';
import { NoteDerivedIndex } from '../src/core/note-derived-index.js';
import { RevisionStore } from '../src/core/revision-store.js';
import { TaskService } from '../src/core/task-service.js';
import { consumeClipperIntake, CLIPPER_MAX_INTAKE_URL } from '../src/utils/clipper.js';
import { buildCalendarItems } from '../src/utils/calendar.js';
import { MAX_FRONTMATTER_BYTES, parseFrontmatter } from '../src/utils/frontmatter.js';
import { rankNotes } from '../src/utils/search-query.js';
import { normalizeVaultPath } from '../src/utils/vault-import.js';
import { normalizeWorkspaceState, WORKSPACE_MAX_TABS } from '../src/utils/workspace.js';

const timestamp = '2026-08-20T00:00:00.000Z';

function rawNote(index) {
  const id = `random-${String(index).padStart(4, '0')}`;
  const parentId = index > 0 && index % 7 ? `random-${String(index - 1).padStart(4, '0')}` : null;
  const image = index % 97 === 0 ? '\n\n![pixel](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==)' : '';
  const note = {
    id,
    title: index % 31 === 0 ? `${2026 + (index % 4)}-08-${String((index % 28) + 1).padStart(2, '0')}` : `Random note ${index}`,
    content: `---\nstatus: ${index % 2 ? 'open' : 'done'}\npriority: ${index % 5}\n---\n# Random ${index}\n\n- [ ] Task ${index} @due(2026-08-${String((index % 28) + 1).padStart(2, '0')})\n\n[[Random note ${(index + 1) % 1_000}|next]]${image}`,
    tags: [`tag-${index % 12}`],
    banner: index % 101 === 0 ? { type: 'gradient', value: 'linear-gradient(90deg, #123, #456)', position: 50 } : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: index % 113 === 0 ? '2026-08-20T01:00:00.000Z' : null,
    pinned: index % 89 === 0,
    parentId,
    futureMetadata: { retained: true, index },
  };
  if (index % 127 === 0) note.aliases = [`Legacy ${index}`];
  if (index % 131 === 0) note.archivedAt = '2026-08-20T02:00:00.000Z';
  return note;
}

class MemoryStorage {
  constructor(initial = {}) { this.data = new Map(Object.entries(structuredClone(initial))); }
  async ready() { return true; }
  async getStatus() {
    return { backend: 'indexeddb', capabilities: { revisionHistory: true, localSnapshots: true, atomicBatch: true }, quota: null };
  }
  async load(key, fallback = null) { return this.data.has(key) ? structuredClone(this.data.get(key)) : fallback; }
  async loadMany(keys, fallback = null) { return [...keys].map((key) => this.data.has(key) ? structuredClone(this.data.get(key)) : fallback); }
  async keys(prefix = '') { return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  async save(key, value) { this.data.set(key, structuredClone(value)); return true; }
  async saveMany(entries) {
    const next = new Map(this.data);
    for (const [key, value] of entries instanceof Map ? entries : entries) next.set(key, structuredClone(value));
    this.data = next;
    return true;
  }
  async removeMany(keys) { keys.forEach((key) => this.data.delete(key)); return true; }
  async remove(key) { this.data.delete(key); return true; }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function waitFor(predicate, timeout = 1_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error('Timed out waiting for derived index refresh.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('randomized 1,000-note schema-v3 chain preserves every authoritative byte and additive field', async () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => rawNote(index));
  const config = {
    themeMode: 'dark', editorWidth: 'wide', collapsedNoteIds: ['random-0001'],
    custom: { nested: ['keep', { exactly: true }] },
  };
  const input = { notes, config };
  const before = structuredClone(input);
  const migration = runMigrations(input, 3);
  assert.equal(migration.version, CURRENT_SCHEMA_VERSION);
  assert.equal(migration.migrated, true);
  assert.deepEqual(input, before, 'migration never mutates the schema-v3 source');
  assert.equal(new Set(migration.data.notes.map((note) => note.id)).size, 1_000);
  migration.data.notes.forEach((note, index) => {
    const original = before.notes[index];
    for (const key of Object.keys(original)) assert.deepEqual(note[key], original[key], `${note.id} preserves ${key}`);
    assert.deepEqual(note.aliases, original.aliases || []);
    assert.equal(note.archivedAt, original.archivedAt || null);
  });
  assert.deepEqual(migration.data.config.custom, config.custom);

  const envelope = await createBackup({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: migration.data.notes,
    config: migration.data.config,
  }, { createdAt: timestamp });
  const verified = await verifyBackup(envelope);
  const preview = await createRestorePreview({ schemaVersion: CURRENT_SCHEMA_VERSION, notes: [], config: {} }, verified);
  assert.deepEqual(preview.restoreState.notes, migration.data.notes);
  assert.deepEqual(preview.restoreState.config, migration.data.config);
  assert.equal(preview.summary.liveNoteCount + preview.summary.trashedNoteCount, 1_000);
});

test('schema migration leaves independently stored revision content materializable', async () => {
  const storage = new MemoryStorage();
  const revisions = new RevisionStore(storage, {
    now: () => new Date(timestamp),
    idFactory: () => 'phase7-revision',
  });
  const original = { ...rawNote(7), aliases: [], archivedAt: null };
  const captured = await revisions.capture(original, { reason: 'manual', force: true });
  assert.equal(captured.captured, true);

  const backend = new MemoryStorage({ notes: [original], config: { themeMode: 'dark' }, schemaVersion: 3, persistenceStatus: {} });
  const db = await new Database({ storageBackend: backend }).init();
  await db.flush();
  const materialized = await revisions.materialize(captured.revision.id);
  assert.equal(materialized.noteId, original.id);
  assert.equal(materialized.content, original.content);
  assert.equal(db.notes.get(original.id).toJSON().futureMetadata.index, 7);
  assert.equal(await backend.load('schemaVersion'), CURRENT_SCHEMA_VERSION);
});

test('per-note derived index reparses only invalidated sources and repairs lifecycle removal', () => {
  const notes = new Map(Array.from({ length: 1_000 }, (_, index) => {
    const note = { ...rawNote(index), isTrashed: false, isArchived: false };
    return [note.id, note];
  }));
  const listeners = new Set();
  const db = {
    getAllNotes: () => [...notes.values()],
    getNote: (id) => notes.get(id) || null,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let derived = 0;
  const index = new NoteDerivedIndex(db, (note) => { derived += 1; return [{ id: note.id, content: note.content }]; });
  assert.equal(index.list().length, 1_000);
  assert.equal(derived, 1_000);
  const untouched = index.records.get('random-0500');
  notes.get('random-0001').content = 'changed';
  listeners.forEach((listener) => listener(db, ['random-0001']));
  assert.equal(index.list().find((entry) => entry.id === 'random-0001').content, 'changed');
  assert.equal(derived, 1_001);
  assert.equal(index.records.get('random-0500'), untouched);
  notes.delete('random-0001');
  listeners.forEach((listener) => listener(db, ['random-0001']));
  assert.equal(index.list().some((entry) => entry.id === 'random-0001'), false);
  assert.equal(derived, 1_001);
  index.destroy();
});

test('full-vault replacement resets derived indexes and removes stale records', async () => {
  const first = { ...rawNote(1), aliases: [], deletedAt: null, archivedAt: null };
  const second = { ...rawNote(2), aliases: [], deletedAt: null, archivedAt: null };
  const storage = new MemoryStorage({
    notes: [first, second],
    config: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    persistenceStatus: {},
  });
  const db = await new Database({ storageBackend: storage }).init();
  const index = new NoteDerivedIndex(db, (note) => [{ id: note.id }]);
  assert.deepEqual(index.list().map((entry) => entry.id), [first.id, second.id]);

  const restored = await db.replaceVault({
    notes: [first],
    config: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });
  assert.equal(restored, true);
  assert.deepEqual(index.list().map((entry) => entry.id), [first.id]);
  index.destroy();
});

test('task, calendar, and property updates stay incremental across a 1,000-note vault', async () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => ({ ...rawNote(index), aliases: [], deletedAt: null, archivedAt: null }));
  const storage = new MemoryStorage({ notes, config: {
    frontmatterAliasMigration: { version: 1, status: 'complete', blocked: [] },
  }, schemaVersion: CURRENT_SCHEMA_VERSION, persistenceStatus: {} });
  const db = await new Database({ storageBackend: storage }).init();
  const tasks = new TaskService(db);
  const calendar = new NoteDerivedIndex(db, (note) => buildCalendarItems([note]));
  assert.equal(tasks.list().length, 1_000);
  assert.ok(calendar.list().length >= 1_000);
  const untouchedTask = tasks.index.records.get('random-0500');
  const untouchedCalendar = calendar.records.get('random-0500');

  const properties = new Phase5Controller({ db, editor: null, ensureRecovery: async () => {}, refreshSearch: () => {} });
  await properties.ready;
  const untouchedProperty = db.getNote('random-0500')._propertySearchIndex;
  const edited = db.getNote('random-0001');
  edited.update({ content: edited.content.replace('status: open', 'status: reviewed').replace('Task 1', 'Task 1 updated') });
  const started = performance.now();
  db.saveNote(edited, { captureRevision: false });
  const updatedTasks = tasks.list();
  const updatedCalendar = calendar.list();
  await waitFor(() => db.getNote('random-0001')._propertySearchIndex?.get('status')?.includes('reviewed'));
  const elapsed = performance.now() - started;
  assert.ok(updatedTasks.some((task) => task.noteId === edited.id && task.text === 'Task 1 updated'));
  assert.ok(updatedCalendar.some((item) => item.noteId === edited.id && item.type === 'task'));
  assert.equal(tasks.index.records.get('random-0500'), untouchedTask);
  assert.equal(calendar.records.get('random-0500'), untouchedCalendar);
  assert.equal(db.getNote('random-0500')._propertySearchIndex, untouchedProperty);
  assert.ok(elapsed < 150, `incremental derived updates took ${elapsed.toFixed(1)} ms`);
  tasks.destroy();
  calendar.destroy();
  properties.unsubscribe?.();
  await db.flush();
});

test('search p95 stays below 150 ms across twenty representative 1,000-note queries', () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => ({
    ...rawNote(index),
    _propertySearchIndex: new Map([['status', [index % 2 ? 'open' : 'done']], ['priority', [String(index % 5)]]]),
  }));
  const queries = [
    'Random note 99', 'Task 500', 'tag:tag-3', 'in:title Random 750', 'has:banner',
    'prop:status=open', 'property:priority=3', 'is:pinned', 'next', 'data:image',
    'Random note 1', 'Task 12', 'tag:tag-9', 'in:title 2027', 'prop:status=done',
    'property:priority=4', 'Legacy', 'due(2026-08-20)', 'Random 999', 'missing phrase',
  ];
  queries.forEach((query) => rankNotes(query, notes));
  const timings = queries.map((query) => {
    const started = performance.now();
    rankNotes(query, notes);
    return performance.now() - started;
  });
  const p95 = percentile(timings, 0.95);
  assert.ok(p95 < 150, `search p95 was ${p95.toFixed(2)} ms`);
});

test('maximum workspace restore is bounded and repairs duplicate, missing, Archive, and Trash IDs', () => {
  const notes = Array.from({ length: 25 }, (_, index) => ({ ...rawNote(index), deletedAt: index === 23 ? timestamp : null }));
  const started = performance.now();
  const state = normalizeWorkspaceState({
    activePane: 'secondary',
    panes: {
      primary: { tabs: notes.slice(0, 15).map((note) => note.id), activeNoteId: notes[0].id, scrollTop: 40 },
      secondary: { tabs: [notes[0].id, ...notes.slice(15).map((note) => note.id), 'missing'], activeNoteId: notes[20].id, scrollTop: 80 },
    },
    split: { enabled: true, ratio: 0.6 },
  }, notes);
  const elapsed = performance.now() - started;
  const all = [...state.panes.primary.tabs, ...state.panes.secondary.tabs];
  assert.ok(all.length <= WORKSPACE_MAX_TABS);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.includes('missing'), false);
  assert.equal(all.includes(notes[23].id), false);
  assert.ok(elapsed < 150, `workspace normalization took ${elapsed.toFixed(2)} ms`);
});

test('adversarial YAML, URL, path, CSP, service-worker, and prototype boundaries fail closed', async () => {
  const prototypeYaml = await parseFrontmatter('---\n__proto__: { polluted: true }\nconstructor: safe\n---\nBody');
  assert.equal(prototypeYaml.status, 'valid');
  assert.equal(prototypeYaml.properties instanceof Map, true);
  assert.equal(Object.prototype.polluted, undefined);
  const oversizedYaml = await parseFrontmatter(`---\nvalue: ${'x'.repeat(MAX_FRONTMATTER_BYTES)}\n---\nBody`);
  assert.equal(oversizedYaml.status, 'invalid');
  assert.equal(oversizedYaml.diagnostics[0].code, 'frontmatter_too_large');
  for (const path of ['../escape.md', '/absolute.md', 'C:\\escape.md', 'safe//escape.md']) {
    assert.throws(() => normalizeVaultPath(path));
  }
  assert.throws(() => consumeClipperIntake(`https://app.test/?capture=clipper&selection=${'x'.repeat(CLIPPER_MAX_INTAKE_URL)}`), /too large/);

  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(sw, /key\.startsWith\('noteforge-'\) && key !== CACHE/);
  assert.doesNotMatch(sw, /filter\(\(key\) => key !== CACHE\)/);
  const prodPolicy = vite.slice(vite.indexOf('prod: ['), vite.indexOf('].join', vite.indexOf('prod: [')));
  assert.match(prodPolicy, /"script-src 'self'"/);
  assert.doesNotMatch(prodPolicy, /script-src[^\n]*unsafe/);
  assert.match(prodPolicy, /"object-src 'none'"/);
  assert.match(prodPolicy, /"form-action 'none'"/);
});
