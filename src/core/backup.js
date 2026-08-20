// Portable, versioned NoteForge backups.
//
// This is deliberately separate from the existing JSON merge import. A backup
// preserves the complete authoritative vault (including note ids, Trash state,
// unknown future metadata, and raw config) and carries an integrity digest. All
// operations in this module are pure except for the injected SHA-256 provider.

import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations.js';
import { Note } from './note.js';

export const BACKUP_FORMAT = 'noteforge-portable-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MIN_BACKUP_SCHEMA_VERSION = 3;

const REQUIRED_NOTE_FIELDS = [
  'id',
  'title',
  'content',
  'tags',
  'banner',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'parentId',
];

export class BackupError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'BackupError';
    this.code = code;
  }
}

function reject(code, message, cause) {
  throw new BackupError(code, message, cause ? { cause } : undefined);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('NON_JSON_VALUE', `${path} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object') {
    reject('NON_JSON_VALUE', `${path} contains a value that JSON cannot preserve.`);
  }
  if (seen.has(value)) reject('CYCLIC_VALUE', `${path} contains a circular reference.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen));
    }
    if (!isRecord(value)) reject('NON_JSON_VALUE', `${path} must contain only plain JSON objects.`);
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Stable JSON for hashes and repeatable downloads. Object keys are sorted; arrays retain user order. */
export function canonicalStringify(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

function detachedCanonicalCopy(value) {
  return JSON.parse(canonicalStringify(value));
}

function assertSchemaVersion(schemaVersion) {
  if (!Number.isInteger(schemaVersion)) {
    reject('INVALID_SCHEMA', 'Backup schemaVersion must be an integer.');
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    reject(
      'FUTURE_SCHEMA',
      `This backup uses schema ${schemaVersion}; this NoteForge build supports through schema ${CURRENT_SCHEMA_VERSION}.`
    );
  }
  if (schemaVersion < MIN_BACKUP_SCHEMA_VERSION) {
    reject(
      'UNSUPPORTED_SCHEMA',
      `Portable backups require schema ${MIN_BACKUP_SCHEMA_VERSION} or newer.`
    );
  }
}

function assertIsoTimestamp(value, path) {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) {
    reject('INVALID_TIMESTAMP', `${path} must be an ISO-compatible timestamp.`);
  }
}

function assertNote(note, index, schemaVersion) {
  const path = `notes[${index}]`;
  if (!isRecord(note)) reject('INVALID_NOTE', `${path} must be an object.`);
  for (const field of REQUIRED_NOTE_FIELDS) {
    if (!Object.hasOwn(note, field)) reject('INCOMPLETE_NOTE', `${path} is missing ${field}.`);
  }
  if (typeof note.id !== 'string' || !note.id) reject('INVALID_NOTE_ID', `${path}.id must be a non-empty string.`);
  if (typeof note.title !== 'string') reject('INVALID_NOTE', `${path}.title must be a string.`);
  if (typeof note.content !== 'string') reject('INVALID_NOTE', `${path}.content must be a string.`);
  if (!Array.isArray(note.tags) || note.tags.some((tag) => typeof tag !== 'string')) {
    reject('INVALID_NOTE', `${path}.tags must be an array of strings.`);
  }
  if (note.banner !== null && !isRecord(note.banner)) {
    reject('INVALID_NOTE', `${path}.banner must be an object or null.`);
  }
  assertIsoTimestamp(note.createdAt, `${path}.createdAt`);
  assertIsoTimestamp(note.updatedAt, `${path}.updatedAt`);
  if (note.deletedAt !== null) assertIsoTimestamp(note.deletedAt, `${path}.deletedAt`);
  if (typeof note.pinned !== 'boolean') reject('INVALID_NOTE', `${path}.pinned must be a boolean.`);
  if (note.parentId !== null && typeof note.parentId !== 'string') {
    reject('INVALID_NOTE', `${path}.parentId must be a string or null.`);
  }
  if (schemaVersion >= 4) {
    if (!Object.hasOwn(note, 'aliases')) reject('INCOMPLETE_NOTE', `${path} is missing aliases.`);
    if (!Array.isArray(note.aliases) || note.aliases.some((alias) => typeof alias !== 'string')) {
      reject('INVALID_NOTE', `${path}.aliases must be an array of strings.`);
    }
  }
  if (schemaVersion >= 5) {
    if (!Object.hasOwn(note, 'archivedAt')) reject('INCOMPLETE_NOTE', `${path} is missing archivedAt.`);
    if (note.archivedAt !== null) assertIsoTimestamp(note.archivedAt, `${path}.archivedAt`);
  }
}

function validateVaultState(state) {
  if (!isRecord(state)) reject('INVALID_BACKUP', 'Backup state must be an object.');
  assertSchemaVersion(state.schemaVersion);
  if (!Array.isArray(state.notes)) reject('INVALID_NOTES', 'Backup notes must be an array.');
  if (!isRecord(state.config)) reject('INVALID_CONFIG', 'Backup config must be a JSON object.');

  const ids = new Set();
  state.notes.forEach((note, index) => {
    assertNote(note, index, state.schemaVersion);
    if (ids.has(note.id)) reject('DUPLICATE_NOTE_ID', `Backup contains duplicate note id "${note.id}".`);
    ids.add(note.id);
  });

  // Validates unknown note fields and raw config as losslessly JSON-safe too.
  canonicalStringify({ notes: state.notes, config: state.config });
}

function validateApplicableNotes(notes) {
  notes.forEach((note, index) => {
    let normalized;
    try {
      normalized = Note.fromJSON(note).toJSON();
    } catch (error) {
      reject('INVALID_RESTORE_NOTE', `notes[${index}] cannot be applied by this NoteForge build.`, error);
    }
    if (canonicalStringify(normalized) !== canonicalStringify(note)) {
      reject('INVALID_RESTORE_NOTE', `notes[${index}] contains metadata that cannot be applied exactly.`);
    }
  });
}

function expectedManifest(notes) {
  const liveNoteIds = [];
  const trashedNoteIds = [];
  for (const note of notes) {
    (note.deletedAt === null ? liveNoteIds : trashedNoteIds).push(note.id);
  }
  return { noteCount: notes.length, liveNoteIds, trashedNoteIds };
}

function validateManifest(manifest, notes) {
  if (!isRecord(manifest)) reject('INVALID_MANIFEST', 'Backup manifest must be an object.');
  if (!Number.isInteger(manifest.noteCount) || manifest.noteCount < 0) {
    reject('INVALID_MANIFEST', 'Backup manifest noteCount must be a non-negative integer.');
  }
  for (const field of ['liveNoteIds', 'trashedNoteIds']) {
    if (!Array.isArray(manifest[field]) || manifest[field].some((id) => typeof id !== 'string')) {
      reject('INVALID_MANIFEST', `Backup manifest ${field} must be an array of note ids.`);
    }
    if (new Set(manifest[field]).size !== manifest[field].length) {
      reject('INVALID_MANIFEST', `Backup manifest ${field} contains duplicate ids.`);
    }
  }
  const expected = expectedManifest(notes);
  if (canonicalStringify(manifest) !== canonicalStringify(expected)) {
    reject('MANIFEST_MISMATCH', 'Backup manifest does not match its live and trashed notes.');
  }
}

function validateEnvelope(envelope) {
  if (!isRecord(envelope)) reject('INVALID_BACKUP', 'Backup must be a JSON object.');
  if (envelope.format !== BACKUP_FORMAT) reject('INVALID_FORMAT', 'File is not a NoteForge portable backup.');
  if (envelope.formatVersion !== BACKUP_FORMAT_VERSION) {
    const code = Number.isInteger(envelope.formatVersion) && envelope.formatVersion > BACKUP_FORMAT_VERSION
      ? 'FUTURE_FORMAT'
      : 'INVALID_FORMAT_VERSION';
    reject(code, `Unsupported NoteForge backup format version: ${String(envelope.formatVersion)}.`);
  }
  assertIsoTimestamp(envelope.createdAt, 'createdAt');
  validateVaultState(envelope);
  validateManifest(envelope.manifest, envelope.notes);
  if (!isRecord(envelope.integrity) || envelope.integrity.algorithm !== 'SHA-256') {
    reject('INVALID_INTEGRITY', 'Backup integrity must use SHA-256.');
  }
  if (typeof envelope.integrity.digest !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.integrity.digest)) {
    reject('INVALID_INTEGRITY', 'Backup integrity digest must be 64 lowercase hexadecimal characters.');
  }
  canonicalStringify(envelope);
}

function withoutIntegrity(envelope) {
  const payload = Object.create(null);
  for (const key of Object.keys(envelope)) {
    if (key !== 'integrity') payload[key] = envelope[key];
  }
  return payload;
}

async function sha256Hex(text, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle || typeof cryptoProvider.subtle.digest !== 'function') {
    reject('CRYPTO_UNAVAILABLE', 'SHA-256 is unavailable; NoteForge cannot create or verify this backup.');
  }
  let result;
  try {
    result = await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(text));
  } catch (cause) {
    reject('CRYPTO_FAILED', 'SHA-256 failed while processing the backup.', cause);
  }
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Create a complete portable backup without mutating or retaining references to the supplied state. */
export async function createBackup(
  { schemaVersion = CURRENT_SCHEMA_VERSION, notes, config },
  { createdAt = new Date().toISOString(), cryptoProvider = globalThis.crypto } = {}
) {
  const state = detachedCanonicalCopy({ schemaVersion, notes, config });
  validateVaultState(state);
  assertIsoTimestamp(createdAt, 'createdAt');

  const unsigned = detachedCanonicalCopy({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    schemaVersion: state.schemaVersion,
    manifest: expectedManifest(state.notes),
    notes: state.notes,
    config: state.config,
  });
  const digest = await sha256Hex(canonicalStringify(unsigned), cryptoProvider);
  return detachedCanonicalCopy({
    ...unsigned,
    integrity: { algorithm: 'SHA-256', digest },
  });
}

/** Deterministic, human-readable bytes for download. Integrity is verified separately. */
export function serializeBackup(envelope) {
  validateEnvelope(envelope);
  return `${canonicalStringify(envelope, 2)}\n`;
}

/** Parse and structurally validate untrusted JSON. Use verifyBackup before restore. */
export function parseBackup(text) {
  if (typeof text !== 'string') reject('INVALID_JSON', 'Backup input must be JSON text.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    reject('INVALID_JSON', 'Backup is not valid JSON.', cause);
  }
  validateEnvelope(parsed);
  return detachedCanonicalCopy(parsed);
}

/** Verify an envelope or serialized backup and return a detached, trusted envelope. */
export async function verifyBackup(input, { cryptoProvider = globalThis.crypto } = {}) {
  const backup = typeof input === 'string'
    ? parseBackup(input)
    : detachedCanonicalCopy(input);
  if (typeof input !== 'string') validateEnvelope(backup);
  const actualDigest = await sha256Hex(canonicalStringify(withoutIntegrity(backup)), cryptoProvider);
  if (actualDigest !== backup.integrity.digest) {
    reject('INTEGRITY_MISMATCH', 'Backup integrity check failed. The file may be damaged or modified.');
  }
  return backup;
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys)
    .sort()
    .filter((key) => {
      if (Object.hasOwn(before, key) !== Object.hasOwn(after, key)) return true;
      return canonicalStringify(before[key]) !== canonicalStringify(after[key]);
    });
}

function notePreview(note, fields) {
  return {
    id: note.id,
    title: note.title,
    state: note.deletedAt !== null ? 'trashed' : note.archivedAt !== null ? 'archived' : 'live',
    ...(fields ? { fields } : {}),
  };
}

/**
 * Verify a backup and build the exact add/update/remove/config preview for a
 * full-vault restore. No caller-owned object is changed.
 */
export async function createRestorePreview(currentState, input, options = {}) {
  const current = detachedCanonicalCopy(currentState);
  validateVaultState(current);
  const backup = await verifyBackup(input, options);
  // A portable backup can outlive several app schemas. Verify its original
  // bytes first, then migrate a detached restore payload forward. Never apply
  // an older schema version and accidentally downgrade the current database.
  const migrated = runMigrations({ notes: backup.notes, config: backup.config }, backup.schemaVersion);
  const desired = detachedCanonicalCopy({
    schemaVersion: migrated.version,
    notes: migrated.data.notes,
    config: migrated.data.config,
  });
  validateVaultState(desired);
  validateApplicableNotes(desired.notes);
  const currentById = new Map(current.notes.map((note) => [note.id, note]));
  const backupById = new Map(desired.notes.map((note) => [note.id, note]));
  const added = [];
  const updated = [];
  const removed = [];
  const unchanged = [];

  for (const note of desired.notes) {
    const before = currentById.get(note.id);
    if (!before) {
      added.push(notePreview(note));
      continue;
    }
    const fields = changedFields(before, note);
    (fields.length ? updated : unchanged).push(notePreview(note, fields.length ? fields : undefined));
  }
  for (const note of current.notes) {
    if (!backupById.has(note.id)) removed.push(notePreview(note));
  }
  for (const entries of [added, updated, removed, unchanged]) {
    entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  const configFields = changedFields(current.config, desired.config);
  const schemaChanged = current.schemaVersion !== desired.schemaVersion;
  return detachedCanonicalCopy({
    schema: {
      before: current.schemaVersion,
      backup: backup.schemaVersion,
      after: desired.schemaVersion,
      changed: schemaChanged,
      migrationRequired: backup.schemaVersion !== desired.schemaVersion,
    },
    notes: { added, updated, removed, unchanged },
    config: {
      changed: configFields.length > 0,
      fields: configFields,
      before: current.config,
      after: desired.config,
    },
    summary: {
      addCount: added.length,
      updateCount: updated.length,
      removeCount: removed.length,
      unchangedCount: unchanged.length,
      liveNoteCount: backup.manifest.liveNoteIds.length,
      trashedNoteCount: backup.manifest.trashedNoteIds.length,
      addedIds: added.map((note) => note.id),
      updatedIds: updated.map((note) => note.id),
      removedIds: removed.map((note) => note.id),
      unchangedIds: unchanged.map((note) => note.id),
      configChanged: configFields.length > 0,
      schemaChanged,
    },
    restoreState: {
      schemaVersion: desired.schemaVersion,
      notes: desired.notes,
      config: desired.config,
    },
  });
}
