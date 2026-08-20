// Direct tests for the pure portable-backup boundary.
// Run with: node test/backup.test.mjs

import { readFileSync } from 'node:fs';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  canonicalStringify,
  createBackup,
  createRestorePreview,
  parseBackup,
  serializeBackup,
  verifyBackup,
} from '../src/core/backup.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/schema-v3-comprehensive.json', import.meta.url), 'utf8'));
const CREATED_AT = '2026-08-19T20:00:00.000Z';
let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error?.stack || error);
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message = 'values differ') {
  const left = canonicalStringify(actual);
  const right = canonicalStringify(expected);
  assert(left === right, `${message}\nactual:   ${left}\nexpected: ${right}`);
}

async function rejectsCode(run, code) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof BackupError, `expected BackupError, got ${error?.constructor?.name}`);
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    return error;
  }
  throw new Error(`expected ${code} rejection`);
}

const makeBackup = (state = fixture, options = {}) => createBackup(state, { createdAt: CREATED_AT, ...options });

await test('creates a versioned NoteForge portable-backup envelope', async () => {
  const backup = await makeBackup();
  assert(backup.format === BACKUP_FORMAT);
  assert(backup.formatVersion === BACKUP_FORMAT_VERSION);
  assert(backup.schemaVersion === 3);
  assert(backup.createdAt === CREATED_AT);
  assert(backup.integrity.algorithm === 'SHA-256');
  assert(/^[a-f0-9]{64}$/.test(backup.integrity.digest));
});

await test('manifest lists every live and trashed id in vault order', async () => {
  const backup = await makeBackup();
  equal(backup.manifest, {
    noteCount: fixture.notes.length,
    liveNoteIds: fixture.notes.filter((note) => note.deletedAt === null).map((note) => note.id),
    trashedNoteIds: fixture.notes.filter((note) => note.deletedAt !== null).map((note) => note.id),
  });
});

await test('preserves every schema-v3 note field, Markdown byte, and raw config value', async () => {
  const state = structuredClone(fixture);
  state.notes[0].futureMetadata = { order: ['z', 'a'], enabled: false };
  state.config.futureSetting = { nested: ['kept', 7] };
  const backup = await makeBackup(state);
  equal(backup.notes, state.notes);
  equal(backup.config, state.config);
});

await test('serialize/parse/verify is an exact round trip', async () => {
  const backup = await makeBackup();
  const text = serializeBackup(backup);
  assert(text.endsWith('\n'));
  equal(parseBackup(text), backup);
  equal(await verifyBackup(text), backup);
});

await test('serialization is deterministic across object insertion order', async () => {
  const stateA = structuredClone(fixture);
  const stateB = structuredClone(fixture);
  stateB.config = Object.fromEntries(Object.entries(stateB.config).reverse());
  stateB.notes = stateB.notes.map((note) => Object.fromEntries(Object.entries(note).reverse()));
  const [a, b] = await Promise.all([makeBackup(stateA), makeBackup(stateB)]);
  assert(serializeBackup(a) === serializeBackup(b));
});

await test('createBackup does not mutate or retain caller-owned objects', async () => {
  const state = structuredClone(fixture);
  const before = structuredClone(state);
  const backup = await makeBackup(state);
  backup.notes[0].content = 'changed in returned backup';
  backup.config.showGraph = false;
  equal(state, before);
});

await test('verifyBackup returns a detached trusted envelope', async () => {
  const backup = await makeBackup();
  const verified = await verifyBackup(backup);
  verified.notes[0].title = 'mutated verified copy';
  assert(backup.notes[0].title === fixture.notes[0].title);
});

await test('rejects a content hash mismatch', async () => {
  const backup = await makeBackup();
  backup.notes[0].content += '\ncorruption';
  await rejectsCode(() => verifyBackup(backup), 'INTEGRITY_MISMATCH');
});

await test('rejects a raw-config hash mismatch', async () => {
  const backup = await makeBackup();
  backup.config.showGraph = !backup.config.showGraph;
  await rejectsCode(() => verifyBackup(backup), 'INTEGRITY_MISMATCH');
});

await test('rejects a manifest that disagrees with note Trash state', async () => {
  const backup = await makeBackup();
  backup.manifest.trashedNoteIds = [];
  await rejectsCode(() => Promise.resolve(parseBackup(JSON.stringify(backup))), 'MANIFEST_MISMATCH');
});

await test('rejects malformed JSON before any restore state exists', async () => {
  await rejectsCode(() => Promise.resolve(parseBackup('{"notes":')), 'INVALID_JSON');
});

await test('rejects non-object JSON', async () => {
  await rejectsCode(() => Promise.resolve(parseBackup('[]')), 'INVALID_BACKUP');
});

await test('rejects future vault schemas without downgrading them', async () => {
  const backup = await makeBackup();
  backup.schemaVersion = 999;
  await rejectsCode(() => Promise.resolve(parseBackup(JSON.stringify(backup))), 'FUTURE_SCHEMA');
});

await test('rejects future backup format versions', async () => {
  const backup = await makeBackup();
  backup.formatVersion = BACKUP_FORMAT_VERSION + 1;
  await rejectsCode(() => Promise.resolve(parseBackup(JSON.stringify(backup))), 'FUTURE_FORMAT');
});

await test('rejects duplicate note ids', async () => {
  const backup = await makeBackup();
  backup.notes.push(structuredClone(backup.notes[0]));
  await rejectsCode(() => Promise.resolve(parseBackup(JSON.stringify(backup))), 'DUPLICATE_NOTE_ID');
});

await test('rejects incomplete note records', async () => {
  const backup = await makeBackup();
  delete backup.notes[0].content;
  await rejectsCode(() => Promise.resolve(parseBackup(JSON.stringify(backup))), 'INCOMPLETE_NOTE');
});

await test('rejects non-object config and non-JSON config values', async () => {
  await rejectsCode(() => makeBackup({ ...fixture, config: [] }), 'INVALID_CONFIG');
  await rejectsCode(() => makeBackup({ ...fixture, config: { zoom: Number.POSITIVE_INFINITY } }), 'NON_JSON_VALUE');
});

await test('reports unavailable and failing SHA-256 providers explicitly', async () => {
  await rejectsCode(() => makeBackup(fixture, { cryptoProvider: null }), 'CRYPTO_UNAVAILABLE');
  const failingProvider = { subtle: { async digest() { throw new Error('provider failed'); } } };
  const error = await rejectsCode(() => makeBackup(fixture, { cryptoProvider: failingProvider }), 'CRYPTO_FAILED');
  assert(error.cause?.message === 'provider failed');
});

await test('large data-image Markdown survives create, serialize, parse, and verify', async () => {
  const state = structuredClone(fixture);
  const image = `data:image/png;base64,${'A'.repeat(512 * 1024)}`;
  state.notes[0].content = `# Large image\n\n![large](${image})`;
  const verified = await verifyBackup(serializeBackup(await makeBackup(state)));
  assert(verified.notes[0].content === state.notes[0].content);
});

await test('restore preview identifies add, update, remove, unchanged, Trash, and config changes', async () => {
  const desired = {
    schemaVersion: 3,
    notes: [fixture.notes[0], fixture.notes[1], fixture.notes.find((note) => note.id === 'v3-trash')],
    config: { showGraph: true, themeMode: 'dark' },
  };
  const current = structuredClone({
    schemaVersion: 3,
    notes: [
      desired.notes[0],
      { ...desired.notes[1], content: 'current edit' },
      { ...desired.notes[0], id: 'current-only', title: 'Current only' },
    ],
    config: { showGraph: false, oldSetting: true },
  });
  const backup = await makeBackup(desired);
  const preview = await createRestorePreview(current, backup);
  equal(preview.summary, {
    addCount: 1,
    updateCount: 1,
    removeCount: 1,
    unchangedCount: 1,
    liveNoteCount: 2,
    trashedNoteCount: 1,
    addedIds: ['v3-trash'],
    updatedIds: ['v3-child'],
    removedIds: ['current-only'],
    unchangedIds: ['v3-root'],
    configChanged: true,
    schemaChanged: false,
  });
  assert(preview.notes.added[0].id === 'v3-trash' && preview.notes.added[0].state === 'trashed');
  assert(preview.notes.updated[0].id === 'v3-child');
  equal(preview.notes.updated[0].fields, ['content']);
  assert(preview.notes.removed[0].id === 'current-only');
  assert(preview.notes.unchanged[0].id === 'v3-root');
  equal(preview.config.fields, ['oldSetting', 'showGraph', 'themeMode']);
});

await test('restore preview contains an exact detached restore payload and mutates neither side', async () => {
  const desired = structuredClone(fixture);
  const current = structuredClone(fixture);
  current.notes[0].content = 'newer local text';
  const desiredBefore = structuredClone(desired);
  const currentBefore = structuredClone(current);
  const backup = await makeBackup(desired);
  const preview = await createRestorePreview(current, serializeBackup(backup));
  equal(preview.restoreState, desired);
  preview.restoreState.notes[0].content = 'preview mutation';
  equal(desired, desiredBefore);
  equal(current, currentBefore);
  assert(backup.notes[0].content === desired.notes[0].content);
});

await test('restore preview rejects a damaged backup instead of presenting it', async () => {
  const backup = await makeBackup();
  backup.notes[0].title = 'tampered';
  await rejectsCode(() => createRestorePreview(fixture, backup), 'INTEGRITY_MISMATCH');
});

await test('restore preview rejects note metadata the application cannot apply exactly', async () => {
  const unsafe = structuredClone(fixture);
  unsafe.notes[0].banner = { type: 'image', value: 'javascript:alert(1)', position: 50 };
  const backup = await makeBackup(unsafe);
  await rejectsCode(() => createRestorePreview(fixture, backup), 'INVALID_RESTORE_NOTE');
});

await test('prototype-shaped config keys remain data and do not pollute prototypes', async () => {
  const config = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"kept":"yes"}}');
  const state = { ...fixture, config };
  const backup = await makeBackup(state);
  const verified = await verifyBackup(serializeBackup(backup));
  assert(Object.hasOwn(verified.config, '__proto__'));
  assert(verified.config.__proto__.polluted === true);
  assert(Object.prototype.polluted === undefined);
  equal(verified.config.constructor, { kept: 'yes' });
});

console.log(`\nBackup tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
