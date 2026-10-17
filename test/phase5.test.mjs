import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/core/database.js';
import { Note } from '../src/core/note.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../src/core/migrations.js';
import { REVISION_REASONS } from '../src/core/revision-store.js';
import { Phase5Controller, canonicalAliasesFor } from '../src/app/phase5.js';
import { LinkOperations } from '../src/core/link-operations.js';
import { createBackup, serializeBackup, verifyBackup } from '../src/core/backup.js';
import {
  FrontmatterError,
  aliasesFromProperties,
  inferPropertyType,
  isIsoDate,
  isSafeHttpUrl,
  normalizePropertyValue,
  parseFrontmatter,
  propertySearchIndex,
  removeFrontmatterProperty,
  setFrontmatterProperty,
  splitFrontmatterSource,
} from '../src/utils/frontmatter.js';
import { parse, serialize } from '../src/utils/blocks.js';
import { blockToMarkdown, inspectBlockIds, resolveBlockId } from '../src/utils/block-links.js';
import { parseWikilinks, rewriteWikilinkTargets } from '../src/utils/wikilinks.js';
import { extractHeadings } from '../src/utils/headings.js';
import { parseQuery, rankNotes } from '../src/utils/search-query.js';
import { writeVaultToDir } from '../src/utils/vault.js';

function backend(initial = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  return {
    values,
    async load(key, fallback) {
      return values.has(key) ? structuredClone(values.get(key)) : fallback;
    },
    async save(key, value) {
      values.set(key, structuredClone(value));
      return true;
    },
    async saveMany(entries) {
      entries.forEach(([key, value]) => values.set(key, structuredClone(value)));
      return true;
    },
    async getStatus() {
      return { backend: 'indexeddb', available: true };
    },
  };
}

async function rejectsCode(run, code) {
  await assert.rejects(run, (error) => error instanceof FrontmatterError && error.code === code);
}

for (const change of ['metadata', 'source']) {
  test(`targeted property refresh leaves unrelated source and indexes alone (${change})`, async () => {
    const notes = ['a', 'b'].map((id) => new Note({ id, title: id, content: '---\npriority: 1\n---\nBody' }).toJSON());
    const db = await new Database({
      storageBackend: backend({ notes, schemaVersion: CURRENT_SCHEMA_VERSION, config: {} }),
    }).init();
    let refreshes = 0;
    const controller = new Phase5Controller({
      db,
      editor: null,
      ensureRecovery: async () => {},
      refreshSearch: () => refreshes++,
    });
    await controller.ready;
    controller.unsubscribe();
    clearTimeout(controller.refreshTimer);
    refreshes = 0;
    const a = db.getNote('a');
    const b = db.getNote('b');
    const originalIndex = a._propertySearchIndex;
    const unrelatedIndex = b._propertySearchIndex;
    const originalToJSON = b.toJSON;
    let unrelatedReads = 0;
    b.toJSON = function () {
      unrelatedReads++;
      return originalToJSON.call(this);
    };
    if (change === 'metadata') a.setPinned(true);
    else a.update({ content: '---\npriority: 2\n---\nBody' });
    await controller.reconcileAliases({ changedOnly: true, noteIds: ['a'] });
    assert.equal(unrelatedReads, 0, 'one changed ID must not serialize the rest of the vault');
    assert.equal(b._propertySearchIndex, unrelatedIndex);
    if (change === 'metadata') {
      assert.equal(a._propertySearchIndex, originalIndex);
      assert.equal(refreshes, 0, 'unchanged source must not request another sidebar redraw');
    } else {
      assert.notEqual(a._propertySearchIndex, originalIndex);
      assert.deepEqual(a._propertySearchIndex, propertySearchIndex((await parseFrontmatter(a.content)).properties));
      // A storage refresh may replace a Note object without changing its source.
      db.notes.set('a', Note.fromJSON(a.toJSON()));
      await controller.reconcileAliases({ changedOnly: true, noteIds: ['a'] });
      assert.deepEqual(db.getNote('a')._propertySearchIndex, a._propertySearchIndex);
    }
    await db.flush();
  });
}

test('leading frontmatter recognition is byte-zero, closing-delimiter exact, and lossless', () => {
  const source = '---\r\n# keep\r\ntitle: "Quoted"\r\nfuture: { nested: true }\r\n...\r\nBody  \r\n\r\n';
  const split = splitFrontmatterSource(source);
  assert.equal(split.hasFrontmatter, true);
  assert.equal(split.raw + split.separator + split.body, source);
  assert.equal(split.body, 'Body  \r\n\r\n');
  assert.equal(split.newline, '\r\n');
  assert.equal(splitFrontmatterSource(' ---\na: 1\n---\nbody').hasFrontmatter, false);
  assert.equal(splitFrontmatterSource('---\nA leading Markdown divider').hasFrontmatter, false);
  assert.equal(splitFrontmatterSource('\ufeff---\na: 1\n---\nbody').hasFrontmatter, false);
});

test('YAML adapter preserves unknown mappings and rejects malformed, duplicate, tagged, and non-map data', async () => {
  const valid = await parseFrontmatter('---\nknown: yes\nfuture:\n  nested: [1, 2]\n"__proto__": safe\n---\nbody');
  assert.equal(valid.status, 'valid');
  assert.deepEqual(valid.properties.get('future'), new Map([['nested', [1, 2]]]));
  assert.equal(valid.properties.get('__proto__'), 'safe');
  assert.equal(Object.prototype.safe, undefined);
  for (const source of [
    '---\na: [\n---\nbody',
    '---\na: 1\na: 2\n---\nbody',
    '---\n!unknown value\n---\nbody',
    '---\n- not\n- a mapping\n---\nbody',
  ])
    assert.equal((await parseFrontmatter(source)).status, 'invalid');
});

test('targeted property edits preserve body bytes, comments/order, types, and immutable identity', async () => {
  const source = '---\n# retained\nalpha: one\nnoteforge_id: stable-1\nunknown:\n  keep: true\n---\r\nBody bytes  \r\n';
  let next = await setFrontmatterProperty(source, 'count', '3.5', { type: 'number' });
  next = await setFrontmatterProperty(next, 'ready', 'true', { type: 'boolean' });
  next = await setFrontmatterProperty(next, 'due', '2026-08-20', { type: 'date' });
  next = await setFrontmatterProperty(next, 'site', 'https://example.com/a', { type: 'url' });
  next = await setFrontmatterProperty(next, 'labels', 'one, two, one', { type: 'multi-select' });
  const parsed = await parseFrontmatter(next);
  assert.equal(splitFrontmatterSource(next).body, splitFrontmatterSource(source).body);
  assert.match(next, /# retained/);
  assert.ok(next.indexOf('alpha:') < next.indexOf('unknown:'));
  assert.equal(parsed.properties.get('count'), 3.5);
  assert.equal(parsed.properties.get('ready'), true);
  assert.deepEqual(parsed.properties.get('labels'), ['one', 'two']);
  await rejectsCode(() => setFrontmatterProperty(next, 'site', 'javascript:alert(1)', { type: 'url' }), 'unsafe_url');
  await rejectsCode(
    () => setFrontmatterProperty(next, 'noteforge_id', 'changed', { type: 'text' }),
    'immutable_property',
  );
  await rejectsCode(() => removeFrontmatterProperty(next, 'noteforge_id'), 'immutable_property');
  const removed = await removeFrontmatterProperty(next, 'ready');
  assert.equal((await parseFrontmatter(removed)).properties.has('ready'), false);
});

test('property validation and inference cover every supported UI type', () => {
  assert.equal(isIsoDate('2024-02-29'), true);
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isSafeHttpUrl('https://example.com'), true);
  assert.equal(isSafeHttpUrl('data:text/html,x'), false);
  assert.equal(normalizePropertyValue('select', 'Active'), 'Active');
  assert.equal(inferPropertyType(false), 'boolean');
  assert.equal(inferPropertyType(4), 'number');
  assert.equal(inferPropertyType('2026-08-20'), 'date');
  assert.equal(inferPropertyType('https://example.com'), 'url');
  assert.equal(inferPropertyType(['a']), 'multi-select');
});

test('schema v6 marks and Phase5Controller completes revision-protected alias migration', async () => {
  assert.ok(REVISION_REASONS.includes('pre_frontmatter_alias_migration'));
  assert.ok(REVISION_REASONS.includes('pre_frontmatter_source_edit'));
  assert.ok(REVISION_REASONS.includes('pre_property_edit'));
  const content = '---\n# unknown survives\naliases: [Existing]\nfuture: { preserve: true }\n---\nBody';
  const store = backend({
    schemaVersion: 5,
    notes: [
      {
        id: 'valid',
        title: 'Current',
        content,
        aliases: ['Legacy'],
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        pinned: false,
        parentId: null,
        archivedAt: null,
        banner: null,
      },
      {
        id: 'broken',
        title: 'Broken',
        content: '---\naliases: [oops\n---\nBody exact',
        aliases: ['Keep Metadata'],
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        pinned: false,
        parentId: null,
        archivedAt: null,
        banner: null,
      },
    ],
    config: {},
  });
  const captures = [];
  const db = await new Database({
    storageBackend: store,
    onNotesPersisted: async (batch) => captures.push(...structuredClone(batch)),
  }).init();
  const controller = new Phase5Controller({
    db,
    editor: { flushPending() {}, currentId: null },
    ensureRecovery: async () => {},
    refreshSearch() {},
  });
  const result = await controller.ready;
  await db.flush();
  const migrated = db.getNote('valid');
  const parsed = await parseFrontmatter(migrated.content);
  assert.deepEqual(aliasesFromProperties(parsed.properties).aliases, ['Existing', 'Legacy']);
  assert.deepEqual(migrated.aliases, ['Existing', 'Legacy']);
  assert.equal(parsed.properties.get('future').get('preserve'), true);
  assert.match(migrated.content, /# unknown survives/);
  assert.equal(db.getNote('broken').content, '---\naliases: [oops\n---\nBody exact');
  assert.equal(result.blocked.length, 1);
  assert.equal(db.config.frontmatterAliasMigration.status, 'repair_required');
  await controller.reconcileAliases({ changedOnly: true });
  assert.equal(
    db.config.frontmatterAliasMigration.status,
    'repair_required',
    'unchanged blocked notes remain in the repair report',
  );
  assert.ok(
    captures.some((capture) => capture.reason === 'pre_frontmatter_alias_migration' && capture.note.id === 'valid'),
  );
  controller.unsubscribe();
});

test('frontmatter aliases stay the single source of truth: removing an alias from either store is not resurrected', async () => {
  const meta = {
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    pinned: false,
    parentId: null,
    archivedAt: null,
    banner: null,
  };
  const migrated = {
    id: 'n1',
    title: 'Current',
    content: '---\naliases: [Old Name]\nkeep: yes\n---\nBody',
    aliases: ['Old Name'],
    ...meta,
  };
  const frontmatterAliases = async (note) => aliasesFromProperties((await parseFrontmatter(note.content)).properties);
  const boot = async () => {
    const db = await new Database({
      storageBackend: backend({
        schemaVersion: 6,
        notes: [migrated],
        config: { frontmatterAliasMigration: { version: 1, status: 'complete', blocked: [] } },
      }),
      onNotesPersisted: async () => {},
    }).init();
    const controller = new Phase5Controller({
      db,
      editor: { flushPending() {}, currentId: null },
      ensureRecovery: async () => {},
      refreshSearch() {},
    });
    await controller.ready;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await controller.reconcileAliases({ changedOnly: true, noteIds: ['n1'] });
      await db.flush();
    };
    return { db, controller, settle };
  };

  // Link tools alias repair edits metadata only; the removal must reach frontmatter.
  let { db, controller, settle } = await boot();
  const links = new LinkOperations(db);
  await links.applyAliasRemovalPlan(links.planAliasRemoval('n1', 'Old Name'));
  await settle();
  assert.deepEqual(db.getNote('n1').aliases, []);
  assert.equal(
    (await frontmatterAliases(db.getNote('n1'))).present,
    false,
    'the emptied aliases key is removed from YAML',
  );
  assert.match(db.getNote('n1').content, /keep: yes/, 'other frontmatter keys survive');
  assert.equal(db.resolveTitle('Old Name'), null);
  controller.unsubscribe();

  // Editing the YAML itself (Markdown is the source of truth) must update metadata, not be overwritten by it.
  ({ db, controller, settle } = await boot());
  let note = db.getNote('n1');
  note.update({ content: '---\naliases: [Fresh]\nkeep: yes\n---\nBody' });
  db.saveNote(note);
  await settle();
  assert.deepEqual(db.getNote('n1').aliases, ['Fresh']);
  assert.equal(db.resolveTitle('Old Name'), null);
  assert.equal(db.resolveTitle('Fresh')?.id, 'n1');
  note = db.getNote('n1');
  note.update({ content: 'Body' });
  db.saveNote(note);
  await settle();
  assert.deepEqual(db.getNote('n1').aliases, [], 'deleting the frontmatter block clears alias metadata');
  assert.equal(db.getNote('n1').content, 'Body', 'no frontmatter is reinserted');
  controller.unsubscribe();

  // A metadata-only write (rename adds the previous title) is mirrored into frontmatter.
  ({ db, controller, settle } = await boot());
  const renamer = new LinkOperations(db);
  await renamer.applyRenamePlan(renamer.planRename('n1', 'Renamed'));
  await settle();
  assert.deepEqual(db.getNote('n1').aliases, ['Old Name', 'Current']);
  assert.deepEqual((await frontmatterAliases(db.getNote('n1'))).aliases, ['Old Name', 'Current']);
  controller.unsubscribe();

  // Pure decision table.
  const property = { valid: true, present: true, aliases: ['A'] };
  assert.deepEqual(
    canonicalAliasesFor({ title: 'T', content: 'x', aliases: ['B'] }, property, null),
    ['A', 'B'],
    'first sight merges legacy metadata',
  );
  assert.deepEqual(
    canonicalAliasesFor({ title: 'T', content: 'x', aliases: ['B'] }, property, { content: 'old', aliases: ['B'] }),
    ['A'],
    'Markdown edit wins',
  );
  assert.deepEqual(
    canonicalAliasesFor({ title: 'T', content: 'x', aliases: ['B'] }, property, { content: 'x', aliases: ['A'] }),
    ['B'],
    'metadata edit wins',
  );
  assert.deepEqual(
    canonicalAliasesFor({ title: 'T', content: 'x', aliases: ['B'] }, property, { content: 'old', aliases: ['A'] }),
    ['A', 'B'],
    'a coordinated write merges',
  );
});

test('derived property filters are normalized, exact, non-authoritative, and searchable', async () => {
  const parsed = await parseFrontmatter('---\nstatus: Active\nscore: 7\nlabels: [One, Two]\n---\nBody');
  const note = {
    title: 'Record',
    content: 'Body',
    tags: [],
    updatedAt: '2026-01-01',
    banner: null,
    pinned: false,
    archivedAt: null,
  };
  Object.defineProperty(note, '_propertySearchIndex', {
    value: propertySearchIndex(parsed.properties),
    enumerable: false,
  });
  assert.deepEqual(parseQuery('property:status=active').filters.properties, [{ key: 'status', value: 'active' }]);
  assert.equal(rankNotes('property:labels=two', [note]).length, 1);
  assert.equal(rankNotes('prop:score=8', [note]).length, 0);
  assert.equal(rankNotes('active', [note]).length, 1);
  assert.equal(JSON.stringify(note).includes('_propertySearchIndex'), false);
});

test('stable block IDs round-trip, survive reorder/edit, resolve uniquely, and diagnose duplicates', () => {
  const blocks = parse('First ^alpha\n\n- [ ] Task ^task-1\n\n## Heading ^section');
  blocks[0].text = 'First edited';
  blocks.unshift(blocks.pop());
  const markdown = serialize(blocks);
  assert.match(markdown, /First edited \^alpha/);
  assert.equal(resolveBlockId(markdown, '^task-1').status, 'resolved');
  assert.equal(blockToMarkdown(resolveBlockId(markdown, 'task-1').block, { includeBlockId: false }), '- [ ] Task');
  assert.equal(inspectBlockIds(`${markdown}\n\nDuplicate ^alpha`).duplicates[0].id, 'alpha');
  assert.equal(resolveBlockId(`${markdown}\n\nDuplicate ^alpha`, 'alpha').status, 'duplicate');
});

test('heading and block fragments survive wikilink parsing and canonical-title rewrites', () => {
  const source = '[[Old#Heading|Shown]] [[Old#^alpha]] ![[Old#^alpha]]';
  const tokens = parseWikilinks(source);
  assert.deepEqual(
    tokens.map(({ fragment, embedded }) => [fragment, embedded]),
    [
      ['Heading', false],
      ['^alpha', false],
      ['^alpha', true],
    ],
  );
  const rewritten = rewriteWikilinkTargets(source, (token) => token.target === 'Old', 'New').content;
  assert.equal(rewritten, '[[New#Heading|Shown]] [[New#^alpha]] ![[New#^alpha]]');
  assert.equal(extractHeadings('# Visible ^anchor')[0].text, 'Visible');
});

test('frontmatter and block markers survive portable backup and Markdown export exactly', async () => {
  const content = '---\naliases: [Legacy]\nunknown: { future: true }\n---\nBody ^stable';
  const state = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: { frontmatterAliasMigration: { version: 1, status: 'complete', blocked: [] } },
    notes: [
      {
        id: 'n',
        title: 'Note',
        content,
        aliases: ['Legacy'],
        tags: [],
        banner: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        pinned: false,
        parentId: null,
        archivedAt: null,
      },
    ],
  };
  const verified = await verifyBackup(
    serializeBackup(await createBackup(state, { createdAt: '2026-08-20T00:00:00.000Z' })),
  );
  assert.equal(verified.notes[0].content, content);
  assert.deepEqual(runMigrations(verified, CURRENT_SCHEMA_VERSION).data.config, state.config);
  const files = new Map();
  const directory = {
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            async write(value) {
              files.set(name, value);
            },
            async close() {},
          };
        },
      };
    },
  };
  assert.equal(await writeVaultToDir(directory, state.notes), 1);
  assert.equal(files.get('Note.md'), content);
});

test('raw property save stays bound to the source reviewed when the dialog loaded', async () => {
  const db = await new Database({
    storageBackend: backend({ schemaVersion: 6, notes: [], config: {} }),
    onNotesPersisted: async () => {},
  }).init();
  const note = db.createNote({ id: 'reviewed-property', title: 'Properties', content: '---\nvalue: old\n---\nBody' });
  await db.flush();
  const controller = new Phase5Controller({
    db,
    editor: { flushPending() {}, currentId: null },
    ensureRecovery: async () => {},
  });
  await controller.ready;
  const parsed = await controller.read(note.id);
  const current = db.getNote(note.id);
  current.update({ content: '---\nvalue: acknowledged\n---\nBody' });
  db.saveNote(current);
  assert.equal(await db.flushCurrentWrites(), true);
  await assert.rejects(
    () => controller.replaceRaw(note.id, '---\nvalue: proposed\n---', parsed.review),
    (error) => ['stale_note', 'stale_plan'].includes(error.code),
  );
  assert.equal(db.getNote(note.id).content, '---\nvalue: acknowledged\n---\nBody');
});
