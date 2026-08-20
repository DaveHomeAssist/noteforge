import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Database } from '../src/core/database.js';
import { LinkOperations } from '../src/core/link-operations.js';
import { Note, normalizeAliases } from '../src/core/note.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/core/migrations.js';
import { createBackup, verifyBackup } from '../src/core/backup.js';
import { normalizeTitle } from '../src/utils/helpers.js';
import {
  parseWikilinks,
  rewriteWikilinkTargets,
} from '../src/utils/wikilinks.js';
import { findUnlinkedMentions } from '../src/utils/link-analysis.js';
import { extractHeadings, headingContextAt, resolveHeadingAnchor } from '../src/utils/headings.js';
import {
  createNavigationState,
  navigate,
  goBack,
  goForward,
  pruneNavigation,
  normalizeRecentIds,
  recordRecent,
  RECENT_LIMIT,
} from '../src/utils/navigation.js';

function memoryBackend({ failBatch = false, initial = [] } = {}) {
  const values = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  return {
    values,
    async load(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    async save(key, value) { values.set(key, structuredClone(value)); return true; },
    async saveMany(entries) {
      if (failBatch) return false;
      const next = new Map(values);
      for (const [key, value] of entries) next.set(key, structuredClone(value));
      values.clear();
      next.forEach((value, key) => values.set(key, value));
      return true;
    },
    async getStatus() { return { backend: 'indexeddb' }; },
  };
}

function rawNote(id, title, content = '', extra = {}) {
  return {
    id,
    title,
    content,
    tags: [],
    banner: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    deletedAt: null,
    pinned: false,
    parentId: null,
    aliases: [],
    archivedAt: null,
    ...extra,
  };
}

test('schema-v4 aliases normalize for comparison while preserving first stored spelling', () => {
  assert.equal(normalizeTitle('  Ｃafe\u0301\t Plan  '), 'café plan');
  assert.deepEqual(
    normalizeAliases(['  Project Home  ', 'Ｐroject Home', 'Other', ' other '], 'Project Home'),
    ['Other'],
  );
  const note = new Note(rawNote('alias-note', 'Canonical', '', {
    aliases: [' Legacy ', 'legacy', 'Canonical', 'Second'],
  }));
  assert.deepEqual(note.aliases, ['Legacy', 'Second']);
  assert.deepEqual(note.toJSON().aliases, ['Legacy', 'Second']);

  const migrated = runMigrations({ notes: [{ id: 'old', title: 'Old', content: '' }], config: {} }, 3);
  assert.equal(migrated.version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated.data.notes[0].aliases, []);
});

test('wikilink parser returns exact source ranges and rewrites only canonical target bytes', () => {
  const source = 'Before [[  Alpha #Heading |Shown ]] and ![[Beta#^block|Embedded]] after';
  const tokens = parseWikilinks(source);
  assert.equal(tokens.length, 2);
  assert.deepEqual(
    tokens.map(({ target, display, fragment, embedded }) => ({ target, display, fragment, embedded })),
    [
      { target: 'Alpha', display: 'Shown', fragment: 'Heading', embedded: false },
      { target: 'Beta', display: 'Embedded', fragment: '^block', embedded: true },
    ],
  );
  for (const token of tokens) assert.equal(source.slice(token.start, token.end), token.raw);

  const rewritten = rewriteWikilinkTargets(source, (token) => token.target === 'Alpha', 'Renamed');
  assert.equal(rewritten.edits.length, 1);
  assert.equal(rewritten.content, 'Before [[  Renamed #Heading |Shown ]] and ![[Beta#^block|Embedded]] after');
  assert.equal(rewriteWikilinkTargets(rewritten.content, () => false, 'Nope').content, rewritten.content);
});

test('wikilinks and mentions exclude escapes, code fences, inline code, URLs, links, self, and word substrings', () => {
  const markdown = [
    '\\[[Escaped]]',
    '`[[Inline]]`',
    '`multi-line',
    '[[Inline continuation]]`',
    '```',
    '[[Fence]]',
    '```',
    '~~~md',
    '[[Tilde fence]]',
    '~~~',
    'https://example.test/[[URL]]',
    '[[Broken [[Nested]]',
    '[[Broken across\n[[Nested line]]',
    '[[Visible#Part|label]]',
  ].join('\n');
  assert.deepEqual(parseWikilinks(markdown).map((token) => token.target), ['Visible']);

  const mentions = findUnlinkedMentions(
    'Alpha alphabet ALPHA `Alpha` [[Alpha]] https://example.test/Alpha\nA Project ships; A Projector does not.',
    [
      { name: 'Alpha', targetId: 'alpha', targetTitle: 'Alpha' },
      { name: 'A Project', targetId: 'project', targetTitle: 'Project' },
    ],
    { sourceId: 'source' },
  );
  assert.deepEqual(mentions.map((mention) => [mention.text, mention.targetId]), [
    ['Alpha', 'alpha'],
    ['ALPHA', 'alpha'],
    ['A Project', 'project'],
  ]);
  assert.deepEqual(
    findUnlinkedMentions('Alpha', [{ name: 'Alpha', targetId: 'self', targetTitle: 'Alpha' }], { sourceId: 'self' }),
    [],
  );
});

test('headings receive deterministic duplicate and Unicode anchors with code exclusions', () => {
  const markdown = '# Repeat\ntext\n## Repeat\n```md\n# Hidden\n```\n~~~md\n### Also hidden\n~~~\n#### Café & Résumé\n###### Final';
  const headings = extractHeadings(markdown);
  assert.deepEqual(headings.map(({ level, anchor }) => [level, anchor]), [
    [1, 'heading-repeat'],
    [2, 'heading-repeat-2'],
    [4, 'heading-café-résumé'],
    [6, 'heading-final'],
  ]);
  assert.equal(headingContextAt(headings, markdown.indexOf('###### Final') - 1).anchor, 'heading-café-résumé');
  assert.equal(resolveHeadingAnchor(headings, '#Repeat'), 'heading-repeat');
  assert.equal(resolveHeadingAnchor(headings, 'repeat-2'), 'heading-repeat-2');
});

test('canonical titles outrank imported aliases while interactive collisions reject and ambiguity reports', async () => {
  const db = new Database({ storageBackend: memoryBackend() });
  const links = new LinkOperations(db);
  const aliasOwner = db.createNote({ id: 'owner', title: 'Résumé', aliases: ['CV'] });
  assert.equal(db.resolveTitle(' cv ').id, aliasOwner.id);
  assert.throws(
    () => db.createNote({ id: 'collision', title: 'ＣＶ' }),
    (error) => error.code === 'identity_collision',
  );
  assert.equal(db.availableTitle('Résumé'), 'Résumé 2');

  const canonical = db.createNote({ id: 'canonical', title: 'CV' }, { allowIdentityConflicts: true });
  assert.equal(db.resolveTitleResult('cv').note.id, canonical.id, 'canonical target wins an imported title/alias collision');
  let report = links.linkIntegrityReport();
  assert.equal(report.healthy, false);
  assert.ok(report.ambiguities.some((entry) => entry.kind === 'title_alias_collision'));

  db.createNote({ id: 'shared-a', title: 'One', aliases: ['Shared'] }, { allowIdentityConflicts: true });
  db.createNote({ id: 'shared-b', title: 'Two', aliases: ['shared'] }, { allowIdentityConflicts: true });
  assert.equal(db.resolveTitleResult('Shared').status, 'ambiguous');
  report = links.linkIntegrityReport();
  assert.ok(report.ambiguities.some((entry) => entry.kind === 'duplicate_alias' && entry.name === 'shared'));

  db.deleteNote(canonical.id);
  assert.equal(db.resolveTitle('CV').id, aliasOwner.id, 'Trash is excluded from normal resolution');
  await db.flush();
});

test('rename preview applies one atomic rewrite with aliases, exact exclusions, and pre-change revisions', async () => {
  const backend = memoryBackend();
  const boundaries = [];
  const db = new Database({
    storageBackend: backend,
    onNotesPersisted: async (captures) => boundaries.push(structuredClone(captures)),
  });
  const target = db.createNote({
    id: 'target',
    title: 'Project',
    aliases: ['Legacy'],
    content: 'Self [[Project]]',
  });
  const source = db.createNote({
    id: 'source',
    title: 'Source',
    content: [
      '# Context',
      '[[Project]] [[Project|shown]] [[Project#Section]] ![[Project#^block|embed]]',
      '\\[[Project]] `[[Project]]` https://example.test/[[Project]] [[Legacy]]',
    ].join('\n'),
  });
  await db.flush();
  await db.initializeKnowledgeIndex();
  const links = new LinkOperations(db);

  const plan = links.planRename(target.id, 'Project Atlas');
  assert.equal(plan.valid, true);
  assert.equal(plan.linkCount, 5);
  assert.equal(plan.affected.length, 2);
  assert.equal(db.getNote(target.id).title, 'Project', 'preview is non-mutating');

  const result = await links.applyRenamePlan(plan);
  assert.deepEqual(boundaries.flat().map((capture) => capture.reason), ['pre_rename', 'pre_rename']);
  assert.equal(result.linkCount, 5);
  assert.equal(db.getNote(target.id).title, 'Project Atlas');
  assert.deepEqual(db.getNote(target.id).aliases, ['Legacy', 'Project']);
  assert.match(db.getNote(target.id).content, /Self \[\[Project Atlas\]\]/);
  assert.equal(db.resolveTitle('Project').id, target.id);
  assert.equal(db.resolveTitle('Legacy').id, target.id);
  assert.equal(
    db.getNote(source.id).content,
    [
      '# Context',
      '[[Project Atlas]] [[Project Atlas|shown]] [[Project Atlas#Section]] ![[Project Atlas#^block|embed]]',
      '\\[[Project]] `[[Project]]` https://example.test/[[Project]] [[Legacy]]',
    ].join('\n'),
  );
  assert.deepEqual(db.graph().edges, [{ source: 'source', target: 'target' }]);
  assert.equal(db.backlinkOccurrencesFor(target.id).length, 5);
  assert.equal(backend.values.get('notes').find((note) => note.id === target.id).title, 'Project Atlas');
});

test('failed or stale rename transactions leave every note unchanged', async () => {
  const backend = memoryBackend({ failBatch: true });
  const db = new Database({ storageBackend: backend, onNotesPersisted: async () => {} });
  const target = db.createNote({ id: 'rollback-target', title: 'Before' });
  const source = db.createNote({ id: 'rollback-source', title: 'Source', content: '[[Before]]' });
  await db.flush();
  const links = new LinkOperations(db);
  const plan = links.planRename(target.id, 'After');
  await assert.rejects(links.applyRenamePlan(plan), /could not be saved/);
  assert.equal(db.getNote(target.id).title, 'Before');
  assert.equal(db.getNote(source.id).content, '[[Before]]');

  backend.saveMany = async (entries) => {
    for (const [key, value] of entries) backend.values.set(key, structuredClone(value));
    return true;
  };
  const stale = links.planRename(target.id, 'After');
  source.update({ content: 'changed after preview [[Before]]' });
  db.saveNote(source, { captureRevision: false });
  await db.flush();
  await assert.rejects(links.applyRenamePlan(stale), /changed after this rename preview/);
  assert.equal(db.getNote(target.id).title, 'Before');
});

test('explicit repair plans resolve imported duplicate titles and aliases without guessing old targets', async () => {
  const captures = [];
  const db = new Database({
    storageBackend: memoryBackend(),
    onNotesPersisted: async (batch) => captures.push(...structuredClone(batch)),
  });
  db.createNote({ id: 'duplicate-a', title: 'Duplicated' }, { allowIdentityConflicts: true });
  db.createNote({ id: 'duplicate-b', title: 'Duplicated', aliases: ['Shared alias'] }, { allowIdentityConflicts: true });
  const source = db.createNote({ id: 'ambiguous-source', title: 'Source', content: '[[Duplicated]]' });
  await db.flush();
  const links = new LinkOperations(db);

  const rename = links.planRename('duplicate-a', 'Repaired title');
  assert.equal(rename.valid, true);
  assert.equal(rename.repairMode, true);
  assert.equal(rename.linkCount, 0);
  assert.equal(rename.aliases.includes('Duplicated'), false);
  await links.applyRenamePlan(rename);
  assert.equal(db.getNote('duplicate-a').title, 'Repaired title');
  assert.equal(db.getNote(source.id).content, '[[Duplicated]]', 'ambiguous old links are never assigned during repair');
  assert.equal(db.resolveTitle('Duplicated').id, 'duplicate-b');

  db.createNote({ id: 'alias-conflict', title: 'Alias owner', aliases: ['Shared alias'] }, { allowIdentityConflicts: true });
  const removal = links.planAliasRemoval('duplicate-b', 'shared alias');
  assert.equal(removal.valid, true);
  assert.deepEqual(db.getNote('duplicate-b').aliases, ['Shared alias'], 'alias-removal preview is non-mutating');
  await links.applyAliasRemovalPlan(removal);
  assert.deepEqual(db.getNote('duplicate-b').aliases, []);
  assert.equal(db.resolveTitle('Shared alias').id, 'alias-conflict');
  assert.ok(captures.some((capture) => capture.reason === 'pre_alias_repair'));
  assert.equal(links.linkIntegrityReport().healthy, true);
});

test('contextual backlinks and previewed mention conversion share the live identity index', async () => {
  const captures = [];
  const db = new Database({
    storageBackend: memoryBackend(),
    onNotesPersisted: async (batch) => captures.push(...structuredClone(batch)),
  });
  const target = db.createNote({ id: 'mention-target', title: 'Alpha', aliases: ['A Project'] });
  const source = db.createNote({
    id: 'mention-source',
    title: 'Source',
    content: '# Ref <script>alert(1)</script>\nSee [[A Project|linked]] here.\n## Plain\nAlpha is plain; `Alpha` is code.',
  });
  await db.flush();
  await db.initializeKnowledgeIndex();
  const links = new LinkOperations(db);

  const backlinks = db.backlinkOccurrencesFor(target.id);
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0].via, 'alias');
  assert.equal(backlinks[0].headingAnchor, 'heading-ref-script-alert-1-script');
  assert.equal(db.graph().edges[0].target, target.id);

  const mentions = db.unlinkedMentionsFor(target.id);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].heading, 'Plain');
  const plan = links.planMentionConversion(mentions[0]);
  assert.equal(plan.valid, true);
  assert.equal(db.getNote(source.id).content.includes('Alpha is plain'), true, 'preview is non-mutating');
  await links.applyMentionPlan(plan);
  assert.match(db.getNote(source.id).content, /\[\[Alpha\]\] is plain/);
  assert.equal(captures.at(-1).reason, 'pre_link_conversion');
});

test('session history is bounded and recents persist as 50 unique live note IDs', () => {
  let state = createNavigationState();
  state = navigate(state, 'a');
  state = navigate(state, 'b');
  state = navigate(state, 'b');
  state = navigate(state, 'c');
  const back = goBack(state, (id) => id !== 'b');
  assert.equal(back.current, 'a');
  assert.equal(goForward(back).current, 'c');
  const forward = goForward(back);
  assert.equal(navigate(forward, 'c'), forward, 'same-note opens do not duplicate history');
  assert.deepEqual(pruneNavigation(state, (id) => id !== 'b'), { back: ['a'], current: 'c', forward: [] });

  let recent = [];
  for (let index = 0; index < 75; index += 1) recent = recordRecent(recent, `note-${index}`);
  recent = recordRecent(recent, 'note-50');
  assert.equal(recent.length, RECENT_LIMIT);
  assert.equal(recent[0], 'note-50');
  assert.equal(new Set(recent).size, RECENT_LIMIT);
  assert.deepEqual(normalizeRecentIds(['missing', 'note-50', 'note-50'], (id) => id !== 'missing'), ['note-50']);
});

test('aliases survive a deterministic schema-v4 portable backup', async () => {
  const state = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    notes: [rawNote('portable-alias', 'Canonical', '# Body', { aliases: ['Old name', 'Short'] })],
    config: { showGraph: false },
  };
  const envelope = await createBackup(state, { createdAt: '2026-08-20T00:00:00.000Z' });
  const verified = await verifyBackup(envelope);
  assert.deepEqual(verified.notes[0].aliases, ['Old name', 'Short']);
});

test('a 1,000-note alias index keeps an incremental mention save under the interaction budget', async () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => rawNote(`n-${index}`, `Knowledge note ${index}`));
  const backend = memoryBackend({ initial: [
    ['schemaVersion', CURRENT_SCHEMA_VERSION],
    ['notes', notes],
    ['config', {}],
    ['persistenceStatus', {}],
  ] });
  const db = new Database({ storageBackend: backend });
  await db.init();
  await db.initializeKnowledgeIndex();
  const edited = db.getNote('n-0');
  edited.update({ content: 'Connect Knowledge note 999.' });
  const started = performance.now();
  db.saveNote(edited, { captureRevision: false });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 150, `incremental link/mention indexing took ${elapsed.toFixed(1)} ms`);
  assert.equal(db.unlinkedMentionsFor('n-999')[0].sourceId, 'n-0');
  await db.flush();
});
