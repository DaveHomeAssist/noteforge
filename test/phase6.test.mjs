import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/core/database.js';
import { ReconciliationService } from '../src/core/reconciliation-service.js';
import {
  WORKSPACE_MAX_RECENTLY_CLOSED,
  WORKSPACE_MAX_TABS,
  closeWorkspaceTab,
  emptyWorkspaceState,
  moveWorkspaceTab,
  normalizeWorkspaceState,
  openWorkspaceNote,
  reopenWorkspaceTab,
  reorderWorkspaceTab,
  setWorkspaceRatio,
} from '../src/utils/workspace.js';
import {
  CLIPPER_MAX_ARTICLE,
  CLIPPER_MAX_SELECTION,
  buildClipperBookmarklet,
  consumeClipperIntake,
  normalizeClipperPayload,
} from '../src/utils/clipper.js';
import {
  VAULT_IMPORT_MAX_FILE_BYTES,
  normalizeVaultPath,
  planVaultImport,
  readVaultFileList,
} from '../src/utils/vault-import.js';
import { debounce } from '../src/utils/helpers.js';

const note = (id, title = id, content = `# ${title}`, extra = {}) => ({
  id, title, content, aliases: [], tags: [], createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z', deletedAt: null, archivedAt: null,
  pinned: false, parentId: null, banner: null, ...extra,
});

function backend(initial = {}, { failBatch = false } = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  return {
    values,
    async load(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    async save(key, value) { values.set(key, structuredClone(value)); return true; },
    async saveMany(entries) {
      if (failBatch) return false;
      entries.forEach(([key, value]) => values.set(key, structuredClone(value)));
      return true;
    },
    async getStatus() { return { backend: 'indexeddb', available: true }; },
  };
}

test('debounced persistence flush runs only when work is pending', () => {
  let calls = 0;
  const pending = debounce(() => { calls += 1; }, 60_000);
  assert.equal(pending.flush(), false);
  assert.equal(calls, 0);
  pending();
  assert.equal(pending.flush(), true);
  assert.equal(calls, 1);
  assert.equal(pending.flush(), false);
  assert.equal(calls, 1, 'a pagehide-style second flush cannot replay stale editor state');
  pending();
  pending.cancel();
  assert.equal(pending.flush(), false);
  assert.equal(calls, 1);
});

test('workspace normalization repairs corrupt state, duplicate ownership, bounds, and stale Trash IDs', () => {
  const notes = Array.from({ length: 24 }, (_, index) => note(`n${index}`));
  notes[19].archivedAt = '2026-08-20T01:00:00.000Z';
  notes[20].deletedAt = '2026-08-20T01:00:00.000Z';
  const state = normalizeWorkspaceState({
    version: 1,
    activePane: 'secondary',
    panes: {
      primary: { tabs: ['n0', 'n0', ...notes.slice(1, 18).map(({ id }) => id)], activeNoteId: 'missing', scrollTop: -5 },
      secondary: { tabs: ['n0', ...notes.slice(18).map(({ id }) => id), 'missing'], activeNoteId: 'n19', scrollTop: '12.5' },
    },
    split: { enabled: true, ratio: 100 },
    recentlyClosed: ['n21', 'n21', 'n22', 'missing', ...notes.slice(1, 16).map(({ id }) => id)],
  }, notes);
  assert.equal(new Set([...state.panes.primary.tabs, ...state.panes.secondary.tabs]).size, WORKSPACE_MAX_TABS);
  assert.equal(state.panes.secondary.tabs.includes('n20'), false);
  assert.equal(state.panes.secondary.tabs.includes('n19'), true, 'archived notes remain when explicitly open');
  assert.equal(state.panes.primary.activeNoteId, 'n0');
  assert.equal(state.panes.primary.scrollTop, 0);
  assert.equal(state.panes.secondary.scrollTop, 12.5);
  assert.equal(state.split.ratio, 0.75);
  assert.ok(state.recentlyClosed.length <= WORKSPACE_MAX_RECENTLY_CLOSED);
  assert.equal(state.recentlyClosed.some((id) => state.panes.primary.tabs.includes(id) || state.panes.secondary.tabs.includes(id)), false);
});

test('workspace open, close, reopen, reorder, and move preserve one editable owner', () => {
  let state = emptyWorkspaceState();
  state = openWorkspaceNote(state, 'one');
  state = openWorkspaceNote(state, 'two');
  state = openWorkspaceNote(state, 'one', 'secondary');
  assert.deepEqual(state.panes.primary.tabs, ['one', 'two']);
  assert.deepEqual(state.panes.secondary.tabs, []);
  state = reorderWorkspaceTab(state, 'primary', 'two', 0);
  assert.deepEqual(state.panes.primary.tabs, ['two', 'one']);
  state = moveWorkspaceTab(state, 'one', 'secondary');
  assert.deepEqual(state.panes.primary.tabs, ['two']);
  assert.deepEqual(state.panes.secondary.tabs, ['one']);
  assert.equal(state.split.enabled, true);
  state = closeWorkspaceTab(state, 'one');
  assert.equal(state.recentlyClosed[0], 'one');
  state = reopenWorkspaceTab(state, 'secondary');
  assert.deepEqual(state.panes.secondary.tabs, ['one']);
});

test('workspace clamps ratios and rejects a twenty-first globally unique tab', () => {
  let state = setWorkspaceRatio(emptyWorkspaceState(), -1);
  assert.equal(state.split.ratio, 0.25);
  for (let index = 0; index < WORKSPACE_MAX_TABS; index += 1) state = openWorkspaceNote(state, `n${index}`);
  assert.throws(() => openWorkspaceNote(state, 'overflow'), (error) => error.code === 'workspace_tab_limit');
});

test('clipper normalizes text, bounds payloads, and rejects unsafe source URLs', () => {
  const payload = normalizeClipperPayload({
    title: ' Title\0 ', url: 'https://example.com/path',
    selection: `A\r\n${'s'.repeat(CLIPPER_MAX_SELECTION + 20)}`,
    article: 'x'.repeat(CLIPPER_MAX_ARTICLE + 20),
  });
  assert.equal(payload.title, 'Title');
  assert.equal(payload.url, 'https://example.com/path');
  assert.ok(payload.selection.length <= CLIPPER_MAX_SELECTION);
  assert.ok(payload.article.length <= CLIPPER_MAX_ARTICLE);
  assert.throws(() => normalizeClipperPayload({ url: 'javascript:alert(1)' }), /http and https/);
});

test('clipper intake is explicit, one-shot, decoded, and preserves malicious markup only as text', () => {
  const input = consumeClipperIntake('https://app.test/noteforge/?capture=clipper&title=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&url=https%3A%2F%2Fexample.com&selection=%3Cscript%3Ebad()%3C%2Fscript%3E#frag');
  assert.equal(input.matched, true);
  assert.equal(input.cleanUrl, '/noteforge/#frag');
  assert.equal(input.payload.title, '<img src=x onerror=alert(1)>');
  assert.equal(input.payload.text, '<script>bad()</script>');
  assert.equal(consumeClipperIntake('https://app.test/noteforge/').matched, false);
  assert.equal(consumeClipperIntake('https://app.test/noteforge/?capture=clipboard').clipboardFallback, true);
});

test('bookmarklet is bounded, targets an http(s) app, and has a no-clipboard fallback', () => {
  const result = buildClipperBookmarklet('https://systembydave.com/noteforge/?old=1');
  assert.match(result, /^javascript:/);
  assert.match(result, /navigator\.clipboard\?\.writeText\?/);
  assert.match(result, /prompt\('Copy this clip/);
  assert.doesNotMatch(result, /old=1/);
  assert.throws(() => buildClipperBookmarklet('file:///tmp/app'), /http or https/);
});

test('vault paths allow nested Markdown and reject traversal, absolute, drive, NUL, and empty segments', () => {
  assert.equal(normalizeVaultPath('Research\\Topic.md'), 'Research/Topic.md');
  for (const path of ['../secret.md', '/root.md', 'C:\\root.md', 'a//b.md', 'a/./b.md', 'a\0b.md']) {
    assert.throws(() => normalizeVaultPath(path));
  }
});

test('vault planner matches stable IDs before title and preserves unknown frontmatter source', async () => {
  const source = '---\nnoteforge_id: stable\nfuture: { keep: true }\n---\nExternal bytes';
  const plan = await planVaultImport([{ relativePath: 'nested/Renamed.md', text: source }], [note('stable', 'Different', '# Old')]);
  assert.equal(plan.items[0].status, 'Update');
  assert.equal(plan.items[0].destinationNoteId, 'stable');
  assert.equal(plan.items[0].source, source);
});

test('vault planner marks both duplicate IDs, ambiguous titles, Trash targets, and invalid YAML as conflicts', async () => {
  const files = [
    { relativePath: 'a.md', text: '---\nnoteforge_id: duplicate\n---\nA' },
    { relativePath: 'b.md', text: '---\nnoteforge_id: duplicate\n---\nB' },
    { relativePath: 'Same.md', text: 'No ID' },
    { relativePath: 'trash.md', text: '---\nnoteforge_id: trash\n---\nChanged' },
    { relativePath: 'broken.md', text: '---\na: [\n---\nBroken' },
  ];
  const plan = await planVaultImport(files, [note('same', 'Same'), note('trash', 'Trash', '# Old', { deletedAt: '2026-08-20T01:00:00.000Z' })]);
  assert.deepEqual(plan.counts, { Add: 0, Update: 0, Conflict: 5, Unchanged: 0 });
  assert.equal(plan.items.filter((item) => item.externalId === 'duplicate').length, 2);
  assert.ok(plan.items.filter((item) => item.externalId === 'duplicate').every((item) => item.status === 'Conflict'));
});

test('vault planner marks both duplicate normalized paths as conflicts', async () => {
  const plan = await planVaultImport([
    { relativePath: 'nested\\same.md', text: '# First' },
    { relativePath: 'nested/same.md', text: '# Second' },
  ], []);
  assert.deepEqual(plan.counts, { Add: 0, Update: 0, Conflict: 2, Unchanged: 0 });
});

test('vault planner refuses ambiguous, missing, and title-divergent prior mappings', async () => {
  const entry = [{ relativePath: 'Mapped.md', text: '# External' }];
  const ambiguous = await planVaultImport(entry, [note('one', 'Mapped'), note('two', 'Mapped two')], {
    mappings: {
      one: { noteId: 'one', relativePath: 'Mapped.md', title: 'Mapped' },
      two: { noteId: 'two', relativePath: 'Mapped.md', title: 'Mapped' },
    },
  });
  assert.equal(ambiguous.items[0].status, 'Conflict');
  assert.match(ambiguous.items[0].reasons[0], /More than one prior/);
  const missing = await planVaultImport(entry, [], {
    mappings: { missing: { noteId: 'missing', relativePath: 'Mapped.md', title: 'Mapped' } },
  });
  assert.match(missing.items[0].reasons[0], /no longer in the vault/);
  const renamed = await planVaultImport(entry, [note('mapped', 'Renamed')], {
    mappings: { mapped: { noteId: 'mapped', relativePath: 'Mapped.md', title: 'Old title' } },
  });
  assert.match(renamed.items[0].reasons[0], /different title/);
});

test('vault planner requires path and title continuity, detects two-sided edits, and protects internal-only changes', async () => {
  const destination = note('mapped', 'Mapped', '# Internal current');
  const mappings = {
    mapped: { noteId: 'mapped', relativePath: 'nested/Mapped.md', title: 'Mapped', sourceHash: await (await import('../src/utils/vault-import.js')).hashVaultSource('# Old external'), destinationHash: await (await import('../src/utils/vault-import.js')).hashVaultSource('# Old internal') },
  };
  const conflict = await planVaultImport([{ relativePath: 'nested/Mapped.md', text: '# New external' }], [destination], { mappings });
  assert.equal(conflict.items[0].status, 'Conflict');
  const internalOnly = await planVaultImport([{ relativePath: 'nested/Mapped.md', text: '# Old external' }], [destination], { mappings });
  assert.equal(internalOnly.items[0].status, 'Unchanged');
  const renamed = await planVaultImport([{ relativePath: 'nested/Mapped.md', text: '# New external' }], [note('mapped', 'Renamed', '# Old internal')], { mappings });
  assert.equal(renamed.items[0].status, 'Conflict', 'simultaneous file and internal-title changes require a decision');
});

test('vault plans are stable, sorted, collision-safe, and become unchanged after an applied add', async () => {
  const entries = [{ relativePath: 'z.md', text: '# Z' }, { relativePath: 'a.md', text: '# A' }];
  const first = await planVaultImport(entries, []);
  const second = await planVaultImport(entries, []);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.items.map((item) => item.relativePath), ['a.md', 'z.md']);
  const added = first.items.map((item) => note(item.proposedNoteId, item.title, item.source));
  const mappings = Object.fromEntries(first.items.map((item) => [item.proposedNoteId, {
    noteId: item.proposedNoteId, relativePath: item.relativePath, title: item.title,
    sourceHash: item.sourceHash, destinationHash: item.sourceHash,
  }]));
  const rerun = await planVaultImport(entries, added, { mappings });
  assert.deepEqual(rerun.counts, { Add: 0, Update: 0, Conflict: 0, Unchanged: 2 });
});

test('deterministic add IDs include the safe path and actual byte limits cannot be spoofed', async () => {
  const sameBytes = await planVaultImport([
    { relativePath: 'a.md', text: '# Same' },
    { relativePath: 'b.md', text: '# Same' },
  ], []);
  assert.equal(new Set(sameBytes.items.map((item) => item.proposedNoteId)).size, 2);
  const oversized = await planVaultImport([{
    relativePath: 'large.md',
    size: 0,
    text: 'x'.repeat(VAULT_IMPORT_MAX_FILE_BYTES + 1),
  }], []);
  assert.equal(oversized.items[0].status, 'Conflict');
  assert.equal(oversized.items[0].source, '', 'oversized source is not retained in a rendered plan');
});

test('file-list fallback filters non-Markdown and rejects invalid UTF-8 and oversized files', async () => {
  const textFile = (name, bytes, webkitRelativePath = '') => ({
    name, webkitRelativePath, size: bytes.byteLength, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  });
  const entries = await readVaultFileList([
    textFile('note.md', new TextEncoder().encode('# Note'), 'nested/note.md'),
    textFile('skip.txt', new TextEncoder().encode('skip')),
  ]);
  assert.deepEqual(entries.map(({ relativePath, text }) => [relativePath, text]), [['nested/note.md', '# Note']]);
  await assert.rejects(() => readVaultFileList([textFile('bad.md', new Uint8Array([0xff]))]), /encoded as UTF-8/);
  await assert.rejects(() => readVaultFileList([textFile('huge.md', new Uint8Array(2 * 1024 * 1024 + 1))]), /exceeds/);
});

test('reconciliation backs up, captures update revisions, atomically adds/updates, preserves other notes, and reports no deletions', async () => {
  const events = [];
  const store = backend({ schemaVersion: 6, config: {}, notes: [note('existing', 'Existing', '# Old'), note('keep', 'Keep', '# Untouched')] });
  const db = await new Database({
    storageBackend: store,
    onNotesPersisted: async (captures) => events.push(`revision:${captures.map(({ note: value }) => value.id).join(',')}`),
  }).init();
  const recovery = { async downloadBackup() { events.push('backup'); return { message: 'verified' }; } };
  const service = new ReconciliationService({ db, recovery, now: () => new Date('2026-08-20T12:00:00.000Z') });
  const entries = [
    { relativePath: 'Existing.md', text: '---\nnoteforge_id: existing\nfuture: keep\n---\n# New' },
    { relativePath: 'nested/Added.md', text: '# Added bytes' },
  ];
  const plan = await service.plan(entries);
  assert.deepEqual(plan.counts, { Add: 1, Update: 1, Conflict: 0, Unchanged: 0 });
  const decisions = Object.fromEntries(plan.items.map((item) => [item.key, 'apply']));
  const report = await service.apply({ plan, decisions, confirmed: true });
  assert.equal(events[0], 'backup');
  assert.equal(events[1], 'revision:existing');
  assert.match(db.getNote('existing').content, /future: keep/);
  assert.equal(db.getNote('existing').title, 'Existing', 'file reconciliation does not silently rename stable identities');
  assert.equal(db.getNote('keep').content, '# Untouched');
  const added = plan.items.find((item) => item.status === 'Add');
  assert.equal(db.getNote(added.proposedNoteId).content, '# Added bytes');
  assert.deepEqual(report.summary, { added: 1, updated: 1, unchanged: 0, skipped: 0, conflicted: 0, failed: 0, deleted: 0 });
  assert.equal(JSON.stringify(report).includes('# Added bytes'), false, 'completion reports omit note content');
  assert.equal(db.config.folderMappings[added.proposedNoteId].relativePath, 'nested/Added.md');
  const rerun = await service.plan(entries);
  assert.deepEqual(rerun.counts, { Add: 0, Update: 0, Conflict: 0, Unchanged: 2 });
});

test('reconciliation requires an explicit decision for every mutable item and never backs up a no-op', async () => {
  const db = await new Database({ storageBackend: backend({ schemaVersion: 6, config: {}, notes: [] }) }).init();
  let backups = 0;
  const service = new ReconciliationService({ db, recovery: { async downloadBackup() { backups += 1; } } });
  const plan = await service.plan([{ relativePath: 'Add.md', text: '# Add' }]);
  await assert.rejects(() => service.apply({ plan, decisions: {}, confirmed: true }), /Choose Apply or Skip/);
  await assert.rejects(() => service.apply({
    plan: { ...plan, version: 99 },
    decisions: { [plan.items[0].key]: 'skip' },
    confirmed: true,
  }), /not the latest/);
  const report = await service.apply({ plan, decisions: { [plan.items[0].key]: 'skip' }, confirmed: true });
  assert.equal(backups, 0);
  assert.equal(report.summary.skipped, 1);
  assert.equal(db.getAllNotes().length, 0);
});

test('newer concurrent scans supersede older results without replacing service state', async () => {
  const db = await new Database({ storageBackend: backend({ schemaVersion: 6, config: {}, notes: [] }) }).init();
  const pending = [];
  const planner = (entries) => new Promise((resolve) => pending.push({ entries, resolve }));
  const service = new ReconciliationService({ db, planner, recovery: { async downloadBackup() {} } });
  const first = service.plan([{ relativePath: 'first.md', text: '# First' }]);
  const second = service.plan([{ relativePath: 'second.md', text: '# Second' }]);
  const result = (name) => ({ version: 1, items: [], counts: { Add: 0, Update: 0, Conflict: 0, Unchanged: 0 }, name });
  pending[1].resolve(result('second'));
  assert.equal((await second).name, 'second');
  pending[0].resolve(result('first'));
  await assert.rejects(first, (error) => error.code === 'reconciliation_scan_superseded');
  assert.equal(service.entries[0].relativePath, 'second.md');
  assert.equal(service.planResult.name, 'second');
});

test('prototype-shaped stable note IDs remain own mapping data after apply', async () => {
  const db = await new Database({
    storageBackend: backend({ schemaVersion: 6, config: {}, notes: [note('__proto__', 'Prototype', '# Old')] }),
    onNotesPersisted: async () => {},
  }).init();
  const service = new ReconciliationService({ db, recovery: { async downloadBackup() {} } });
  const plan = await service.plan([{
    relativePath: 'Prototype.md',
    text: '---\nnoteforge_id: __proto__\n---\n# New',
  }]);
  await service.apply({ plan, decisions: { [plan.items[0].key]: 'apply' }, confirmed: true });
  assert.equal(Object.hasOwn(db.config.folderMappings, '__proto__'), true);
  assert.equal(db.config.folderMappings.__proto__.noteId, '__proto__');
  assert.equal({}.noteId, undefined);
});

test('reconciliation rejects stale source after safety backup and before revision or vault mutation', async () => {
  const events = [];
  const db = await new Database({
    storageBackend: backend({ schemaVersion: 6, config: {}, notes: [note('existing', 'Existing', '# Old')] }),
    onNotesPersisted: async () => events.push('revision'),
  }).init();
  let source = '---\nnoteforge_id: existing\n---\n# Previewed';
  const service = new ReconciliationService({ db, recovery: { async downloadBackup() { events.push('backup'); } } });
  const plan = await service.plan([{ relativePath: 'Existing.md', text: source, read: async () => source }]);
  source = '---\nnoteforge_id: existing\n---\n# Changed after preview';
  await assert.rejects(() => service.apply({ plan, decisions: { [plan.items[0].key]: 'apply' }, confirmed: true }), /changed after preview/);
  assert.deepEqual(events, ['backup']);
  assert.equal(db.getNote('existing').content, '# Old');
});

test('reconciliation fails closed when portable backup or atomic replacement fails', async () => {
  const initial = { schemaVersion: 6, config: {}, notes: [note('existing', 'Existing', '# Old')] };
  const deniedDb = await new Database({ storageBackend: backend(initial) }).init();
  const denied = new ReconciliationService({ deniedDb, db: deniedDb, recovery: { async downloadBackup() { throw new Error('download denied'); } } });
  const deniedPlan = await denied.plan([{ relativePath: 'Existing.md', text: '---\nnoteforge_id: existing\n---\n# New' }]);
  await assert.rejects(() => denied.apply({ plan: deniedPlan, decisions: { [deniedPlan.items[0].key]: 'apply' }, confirmed: true }), /download denied/);
  assert.equal(deniedDb.getNote('existing').content, '# Old');

  const failedDb = await new Database({ storageBackend: backend(initial, { failBatch: true }), onNotesPersisted: async () => {} }).init();
  const failed = new ReconciliationService({ db: failedDb, recovery: { async downloadBackup() {} } });
  const failedPlan = await failed.plan([{ relativePath: 'Existing.md', text: '---\nnoteforge_id: existing\n---\n# New' }]);
  await assert.rejects(() => failed.apply({ plan: failedPlan, decisions: { [failedPlan.items[0].key]: 'apply' }, confirmed: true }), /not saved/);
  assert.equal(failedDb.getNote('existing').content, '# Old');
});
