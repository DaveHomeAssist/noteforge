import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, createRestorePreview, verifyBackup } from '../src/core/backup.js';
import { BulkOperations } from '../src/core/bulk-operations.js';
import { Database } from '../src/core/database.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/core/migrations.js';
import { Note } from '../src/core/note.js';
import { findLiteralMatches, replaceLiteral } from '../src/utils/find-replace.js';
import {
  createSavedSearch,
  moveSavedSearch,
  normalizeSavedSearches,
  removeSavedSearch,
  updateSavedSearch,
} from '../src/utils/saved-searches.js';
import { createSelection, pruneSelection, toggleSelection } from '../src/utils/selection.js';
import { buildForest, flattenForest } from '../src/utils/tree.js';

const WHEN = '2026-08-20T12:00:00.000Z';

function memoryBackend({ failBatch = false } = {}) {
  const values = new Map();
  return {
    values,
    async load(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    async save(key, value) { values.set(key, structuredClone(value)); return true; },
    async saveMany(entries) {
      if (failBatch) return false;
      const next = new Map(values);
      entries.forEach(([key, value]) => next.set(key, structuredClone(value)));
      values.clear();
      next.forEach((value, key) => values.set(key, value));
      return true;
    },
    async getStatus() { return { backend: 'indexeddb' }; },
  };
}

async function database(options = {}) {
  const backend = options.backend || memoryBackend();
  const captures = [];
  const db = new Database({
    storageBackend: backend,
    onNotesPersisted: async (batch) => captures.push(...structuredClone(batch)),
  });
  await db.init();
  return { db, backend, captures };
}

test('schema v5 Archive and v6 frontmatter marker migrate without mutating schema-v3 input', () => {
  const input = { notes: [{ id: 'legacy', title: 'Legacy', content: '', parentId: null }], config: { custom: true } };
  const before = structuredClone(input);
  const migrated = runMigrations(input, 3);
  assert.equal(CURRENT_SCHEMA_VERSION, 6);
  assert.equal(migrated.version, 6);
  assert.deepEqual(migrated.data.notes[0].aliases, []);
  assert.equal(migrated.data.notes[0].archivedAt, null);
  assert.deepEqual(migrated.data.config.frontmatterAliasMigration, { version: 0, status: 'pending', blocked: [] });
  assert.deepEqual(input, before);
});

test('Archive excludes notes from active identity and promotes visible children without losing hierarchy', async () => {
  const { db } = await database();
  const parent = db.createNote({ id: 'parent', title: 'Parent', content: '' });
  const child = db.createNote({ id: 'child', title: 'Child', content: '', parentId: parent.id });
  await db.flush();
  assert.equal(db.archiveNote(parent.id), true);
  assert.equal(db.getNote(parent.id), null);
  assert.equal(db.getArchivedNote(parent.id)?.title, 'Parent');
  assert.equal(db.resolveTitle('Parent'), null);
  assert.deepEqual(flattenForest(buildForest(db.getAllNotes())).map((row) => [row.note.id, row.depth]), [['child', 0]]);
  assert.equal(db.getNote(child.id)?.parentId, parent.id, 'the stored relationship survives filtering');
  assert.equal(db.unarchiveNote(parent.id), true);
  assert.deepEqual(flattenForest(buildForest(db.getAllNotes())).map((row) => [row.note.id, row.depth]), [['parent', 0], ['child', 1]]);
});

test('unarchiving fails closed when an active title now owns the archived identity', async () => {
  const { db } = await database();
  db.createNote({ id: 'archived', title: 'Shared title', archivedAt: WHEN });
  db.createNote({ id: 'active', title: 'Shared title' }, { allowIdentityConflicts: true });
  assert.throws(() => db.unarchiveNote('archived'), (error) => error.code === 'identity_collision');
  assert.equal(db.getArchivedNote('archived')?.archivedAt, WHEN);
});

test('saved searches normalize malformed records and preserve stable CRUD ordering', () => {
  const normalized = normalizeSavedSearches([
    { id: 'b', name: 'Second', icon: '2️⃣', query: 'tag:work', sortMode: 'title', activeTag: 'work', order: 1 },
    null,
    { id: 'a', name: 'First', icon: '1️⃣', query: 'is:archived', sortMode: 'updated', activeTag: null, order: 0 },
    { id: 'a', name: 'Duplicate', icon: 'x', query: '', sortMode: 'updated', activeTag: null, order: 2 },
    { id: 'bad', name: '', icon: 'x', query: 7, sortMode: 'nope', activeTag: null, order: 3 },
  ]);
  assert.deepEqual(normalized.records.map((record) => record.id), ['a', 'b']);
  assert.deepEqual(normalized.rejected.map((entry) => entry.reason), ['malformed', 'duplicate_id', 'malformed']);
  let records = createSavedSearch(normalized.records, { name: 'Third', query: 'in:title plan', sortMode: 'created' }, { createId: () => 'stable-c' });
  records = updateSavedSearch(records, 'stable-c', { name: 'Renamed' });
  records = moveSavedSearch(records, 'stable-c', -1);
  assert.deepEqual(records.map(({ id, name, order }) => ({ id, name, order })), [
    { id: 'a', name: 'First', order: 0 },
    { id: 'stable-c', name: 'Renamed', order: 1 },
    { id: 'b', name: 'Second', order: 2 },
  ]);
  assert.deepEqual(removeSavedSearch(records, 'a').map((record) => [record.id, record.order]), [['stable-c', 0], ['b', 1]]);
});

test('literal find and replace handles case, Unicode word edges, dollars, backslashes, and Markdown bytes', () => {
  const source = 'Café Cafés CAFÉ\n`$&` and [link](\\path)';
  assert.deepEqual(findLiteralMatches(source, 'café', { wholeWord: true }).map((match) => match.text), ['Café', 'CAFÉ']);
  assert.equal(findLiteralMatches(source, 'café', { wholeWord: true, caseSensitive: true }).length, 0);
  assert.equal(findLiteralMatches('𐐀alpha alpha𐐀 alpha', 'alpha', { wholeWord: true }).length, 1);
  const replaced = replaceLiteral('alpha $& alpha \\ alpha', 'alpha', '$&\\done');
  assert.equal(replaced.count, 3);
  assert.equal(replaced.result, '$&\\done $& $&\\done \\ $&\\done');
  assert.equal(replaceLiteral('**bold** and `code`', '**', '_').result, '_bold_ and `code`');
});

test('selection ranges remain ID-based across a virtualized-size list and prune hidden scope', () => {
  const ordered = Array.from({ length: 120 }, (_, index) => `note-${index}`);
  let selection = toggleSelection(createSelection(), ordered[5], ordered);
  selection = toggleSelection(selection, ordered[105], ordered, { range: true });
  assert.equal(selection.ids.size, 101);
  assert.equal(selection.anchorId, 'note-5');
  selection = pruneSelection(selection, (id) => Number(id.slice(5)) < 80);
  assert.equal(selection.ids.size, 75);
  assert.equal(selection.ids.has('note-79'), true);
  assert.equal(selection.ids.has('note-80'), false);
});

test('batch planners classify no-ops, reject cycles, and atomically archive with safety revisions', async () => {
  const { db, captures, backend } = await database();
  const parent = db.createNote({ id: 'p', title: 'Parent', tags: ['kept'] });
  const child = db.createNote({ id: 'c', title: 'Child', parentId: parent.id });
  await db.flush();
  captures.length = 0;
  const bulk = new BulkOperations(db);
  const tags = bulk.planNoteBatch([parent.id, child.id], 'tag', { tag: 'kept' });
  assert.deepEqual(tags.changed.map((entry) => entry.id), ['c']);
  assert.deepEqual(tags.unchanged.map((entry) => entry.id), ['p']);
  await bulk.applyNoteBatch(tags);
  assert.deepEqual(captures.map((capture) => capture.note.id), ['c'], 'unchanged notes do not receive misleading safety revisions');
  captures.length = 0;
  assert.equal(bulk.planNoteBatch([parent.id], 'reparent', { parentId: child.id }).code, 'parent_cycle');
  const plan = bulk.planNoteBatch([parent.id, child.id], 'archive');
  const report = await bulk.applyNoteBatch(plan);
  assert.equal(report.changed.length, 2);
  assert.equal(captures.filter((capture) => capture.reason === 'pre_bulk_action').length, 2);
  assert.equal(db.getAllNotes().length, 0);
  assert.equal(db.getArchived().length, 2);
  assert.equal(backend.values.get('notes').every((note) => typeof note.archivedAt === 'string'), true);

  const live = db.createNote({ id: 'already-live', title: 'Already live' });
  const mixedUnarchive = bulk.planNoteBatch([parent.id, live.id], 'unarchive');
  assert.equal(mixedUnarchive.valid, true, 'an already-live note is a no-op, not an identity collision');
  assert.deepEqual(mixedUnarchive.changed.map((entry) => entry.id), [parent.id]);
  assert.deepEqual(mixedUnarchive.unchanged.map((entry) => entry.id), [live.id]);

  const stale = bulk.planNoteBatch([parent.id], 'unarchive');
  db.createNote({ id: 'unrelated', title: 'Unrelated vault change' });
  await assert.rejects(bulk.applyNoteBatch(stale), /changed after this batch preview/);
});

test('vault replacement previews explicit scopes, applies source Markdown atomically, and rejects stale plans', async () => {
  const { db, captures } = await database();
  const active = db.createNote({ id: 'active', title: 'Active', content: 'needle $& needle' });
  db.createNote({ id: 'unchanged', title: 'Unchanged', content: 'other' });
  db.createNote({ id: 'archived', title: 'Archived', content: 'needle', archivedAt: WHEN });
  const trash = db.createNote({ id: 'trash', title: 'Trash', content: 'needle' });
  db.deleteNote(trash.id);
  await db.flush();
  captures.length = 0;
  const bulk = new BulkOperations(db);
  const preview = bulk.planVaultReplace({ query: 'needle', replacement: '$&\\literal' });
  assert.deepEqual(preview.changed.map((entry) => entry.id), ['active']);
  assert.deepEqual(preview.unchanged.map((entry) => entry.id), ['unchanged']);
  assert.deepEqual(preview.skipped.map((entry) => [entry.id, entry.reason]), [['archived', 'archive'], ['trash', 'trash']]);
  const report = await bulk.applyVaultReplace(preview);
  assert.equal(report.failed.length, 0);
  assert.equal(db.getNote(active.id).content, '$&\\literal $& $&\\literal');
  assert.equal(captures.at(-1).reason, 'pre_bulk_replace');

  const stale = bulk.planVaultReplace({ query: 'other', replacement: 'changed' });
  const note = db.getNote('unchanged');
  note.update({ content: 'newer other' });
  db.saveNote(note, { captureRevision: false });
  await assert.rejects(bulk.applyVaultReplace(stale), /changed after this preview/);
});

test('a failed atomic batch reports every planned note failed and changes no in-memory note', async () => {
  const backend = memoryBackend();
  const { db } = await database({ backend });
  db.createNote({ id: 'one', title: 'One' });
  db.createNote({ id: 'two', title: 'Two' });
  await db.flush();
  const bulk = new BulkOperations(db);
  const plan = bulk.planNoteBatch(['one', 'two'], 'tag', { tag: 'blocked' });
  backend.saveMany = async () => false;
  await assert.rejects(
    bulk.applyNoteBatch(plan),
    (error) => error.report.failed.length === 2 && error.report.changed.length === 0,
  );
  assert.equal(db.getAllNotes().every((note) => !note.tags.includes('blocked')), true);
});

test('portable backup and restore preview preserve active, Archive, and Trash lifecycle states', async () => {
  const notes = [
    new Note({ id: 'active', title: 'Active' }).toJSON(),
    new Note({ id: 'archive', title: 'Archive', archivedAt: WHEN }).toJSON(),
    new Note({ id: 'trash', title: 'Trash', deletedAt: WHEN }).toJSON(),
  ];
  const state = { schemaVersion: CURRENT_SCHEMA_VERSION, notes, config: { savedSearches: [] } };
  const backup = await createBackup(state, { createdAt: WHEN });
  const verified = await verifyBackup(backup);
  const preview = await createRestorePreview({ schemaVersion: CURRENT_SCHEMA_VERSION, notes: [], config: {} }, verified);
  assert.equal(preview.restoreState.notes.find((note) => note.id === 'archive').archivedAt, WHEN);
  assert.equal(preview.notes.added.find((note) => note.id === 'archive').state, 'archived');
  assert.equal(preview.restoreState.notes.find((note) => note.id === 'trash').deletedAt, WHEN);
  assert.equal(preview.summary.addCount, 3);
});
