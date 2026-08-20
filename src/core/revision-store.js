const REVISION_SCHEMA_VERSION = 1;
const DEFAULT_MAX_REVISIONS = 50;
const DEFAULT_MAX_AGE_DAYS = 90;
const MIN_REVISIONS = 10;
const MAX_REVISIONS = 200;
const MIN_AGE_DAYS = 7;
const MAX_AGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const ROOT_PREFIX = 'revision:';
const RECORD_PREFIX = `${ROOT_PREFIX}record:`;
const INDEX_PREFIX = `${ROOT_PREFIX}index:`;
const CONTENT_PREFIX = `${ROOT_PREFIX}blob:content:`;
const METADATA_PREFIX = `${ROOT_PREFIX}blob:metadata:`;
const SNAPSHOT_RECORD_PREFIX = `${ROOT_PREFIX}snapshot:record:`;
const STATUS_KEY = `${ROOT_PREFIX}status`;
const SNAPSHOT_LIMITS = Object.freeze({ daily: 7, weekly: 4 });

export const REVISION_REASONS = Object.freeze([
  'autosave',
  'pre_import',
  'pre_reconcile',
  'pre_bulk_replace',
  'pre_rename',
  'pre_restore',
  'manual',
]);

export const REVISION_STORAGE_PREFIXES = Object.freeze({
  root: ROOT_PREFIX,
  record: RECORD_PREFIX,
  index: INDEX_PREFIX,
  content: CONTENT_PREFIX,
  metadata: METADATA_PREFIX,
  snapshotRecord: SNAPSHOT_RECORD_PREFIX,
  status: STATUS_KEY,
});

export class RevisionStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RevisionStoreError';
    this.code = code;
    this.details = options.details ?? null;
  }
}

function normalizeBoundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function normalizeRetention(settings = {}) {
  const count = settings.count ?? settings.maxRevisions;
  const days = settings.days ?? settings.maxAgeDays;
  return Object.freeze({
    count: normalizeBoundedInteger(count, MIN_REVISIONS, MAX_REVISIONS, DEFAULT_MAX_REVISIONS),
    days: normalizeBoundedInteger(days, MIN_AGE_DAYS, MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS),
  });
}

function canonicalValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RevisionStoreError('malformed_metadata', 'Revision metadata contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new RevisionStoreError('malformed_metadata', `Revision metadata contains unsupported ${typeof value} data`);
  }
  if (ancestors.has(value)) throw new RevisionStoreError('malformed_metadata', 'Revision metadata contains a cycle');

  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => canonicalValue(entry, ancestors)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(value);
      throw new RevisionStoreError('malformed_metadata', 'Revision metadata must contain plain JSON objects');
    }
    serialized = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], ancestors)}`
    )).join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}

/** Canonical JSON sorts object keys at every depth while retaining array order. */
export function canonicalJson(value) {
  return canonicalValue(value, new Set());
}

export async function sha256(value) {
  if (typeof value !== 'string') throw new TypeError('SHA-256 input must be a string');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new RevisionStoreError('crypto_unavailable', 'Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function recordKey(id) {
  return `${RECORD_PREFIX}${id}`;
}

function indexKey(noteId) {
  return `${INDEX_PREFIX}${encodeURIComponent(noteId)}`;
}

function contentKey(hash) {
  return `${CONTENT_PREFIX}${hash}`;
}

function metadataKey(hash) {
  return `${METADATA_PREFIX}${hash}`;
}

function snapshotRecordKey(id) {
  return `${SNAPSHOT_RECORD_PREFIX}${id}`;
}

function snapshotPeriod(kind, timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || !(kind in SNAPSHOT_LIMITS)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot period cannot be derived');
  }
  if (kind === 'daily') return date.toISOString().slice(0, 10);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysAfterMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysAfterMonday);
  return monday.toISOString().slice(0, 10);
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function isHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isMissing(value) {
  return value === undefined || value === null;
}

function validStoredTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RevisionStoreError('malformed_revision', `Revision ${field} must be a non-empty string`);
  }
}

function validateRecord(raw, expectedId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RevisionStoreError('malformed_revision', 'Revision record is missing or malformed');
  }
  if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > REVISION_SCHEMA_VERSION) {
    throw new RevisionStoreError('future_revision_schema', `Revision schema ${raw.schemaVersion} is newer than supported schema ${REVISION_SCHEMA_VERSION}`);
  }
  if (raw.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new RevisionStoreError('malformed_revision', 'Revision schema version is missing or invalid');
  }
  assertString(raw.id, 'id');
  assertString(raw.noteId, 'noteId');
  if (expectedId && raw.id !== expectedId) {
    throw new RevisionStoreError('malformed_revision', 'Revision key does not match its immutable record ID');
  }
  if (!Number.isFinite(Date.parse(raw.createdAt))) {
    throw new RevisionStoreError('malformed_revision', 'Revision createdAt is invalid');
  }
  if (!REVISION_REASONS.includes(raw.reason)) {
    throw new RevisionStoreError('malformed_revision', 'Revision capture reason is invalid');
  }
  if (!isHash(raw.contentHash) || !isHash(raw.metadataHash)) {
    throw new RevisionStoreError('malformed_revision', 'Revision content hashes are invalid');
  }
  if (raw.parentRevisionId !== null && (typeof raw.parentRevisionId !== 'string' || raw.parentRevisionId.length === 0)) {
    throw new RevisionStoreError('malformed_revision', 'Revision parentRevisionId is invalid');
  }
  return Object.freeze({
    id: raw.id,
    noteId: raw.noteId,
    createdAt: raw.createdAt,
    reason: raw.reason,
    contentHash: raw.contentHash,
    metadataHash: raw.metadataHash,
    parentRevisionId: raw.parentRevisionId,
    schemaVersion: raw.schemaVersion,
  });
}

function newestFirstByChain(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const referencedParents = new Set(records.map((record) => record.parentRevisionId).filter((id) => byId.has(id)));
  const compare = (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id);
  const heads = records.filter((record) => !referencedParents.has(record.id)).sort(compare);
  const ordered = [];
  const seen = new Set();
  for (const head of heads) {
    let current = head;
    while (current && !seen.has(current.id)) {
      ordered.push(current);
      seen.add(current.id);
      current = current.parentRevisionId ? byId.get(current.parentRevisionId) : null;
    }
  }
  ordered.push(...records.filter((record) => !seen.has(record.id)).sort(compare));
  return ordered;
}

function validateSnapshotRecord(raw, expectedId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot record is missing or malformed');
  }
  if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > REVISION_SCHEMA_VERSION) {
    throw new RevisionStoreError('future_revision_schema', `Snapshot schema ${raw.schemaVersion} is newer than supported schema ${REVISION_SCHEMA_VERSION}`);
  }
  if (raw.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot schema version is missing or invalid');
  }
  assertString(raw.id, 'snapshot id');
  if (expectedId && raw.id !== expectedId) {
    throw new RevisionStoreError('malformed_snapshot', 'Snapshot key does not match its immutable record ID');
  }
  if (!Number.isFinite(Date.parse(raw.createdAt))) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot createdAt is invalid');
  }
  if (!(raw.kind in SNAPSHOT_LIMITS)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot kind must be daily or weekly');
  }
  if (raw.period !== snapshotPeriod(raw.kind, raw.createdAt)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot period is missing or invalid');
  }
  if (!Number.isInteger(raw.vaultSchemaVersion) || raw.vaultSchemaVersion < 0) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot vault schema version is missing or invalid');
  }
  if (!isHash(raw.configHash)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot config hash is missing or invalid');
  }
  if (!Array.isArray(raw.notes)) {
    throw new RevisionStoreError('malformed_snapshot', 'Local snapshot note references are missing');
  }
  const seen = new Set();
  const notes = raw.notes.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RevisionStoreError('malformed_snapshot', 'Local snapshot contains a malformed note reference');
    }
    assertString(entry.noteId, 'snapshot noteId');
    if (seen.has(entry.noteId)) throw new RevisionStoreError('malformed_snapshot', 'Local snapshot contains duplicate note IDs');
    seen.add(entry.noteId);
    if (!isHash(entry.contentHash) || !isHash(entry.metadataHash)) {
      throw new RevisionStoreError('malformed_snapshot', 'Local snapshot contains invalid content hashes');
    }
    return Object.freeze({
      noteId: entry.noteId,
      contentHash: entry.contentHash,
      metadataHash: entry.metadataHash,
    });
  });
  return Object.freeze({
    id: raw.id,
    createdAt: raw.createdAt,
    kind: raw.kind,
    period: raw.period,
    notes: Object.freeze(notes),
    noteCount: notes.length,
    configHash: raw.configHash,
    vaultSchemaVersion: raw.vaultSchemaVersion,
    schemaVersion: raw.schemaVersion,
  });
}

function normalizeNoteInput(note, options) {
  const source = typeof note?.toJSON === 'function' ? note.toJSON() : note;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new RevisionStoreError('malformed_note', 'A note object is required for revision capture');
  }
  const noteId = options.noteId ?? source.noteId ?? source.id;
  assertString(noteId, 'noteId');
  const content = options.content ?? source.content;
  if (typeof content !== 'string') throw new RevisionStoreError('malformed_note', 'Revision content must be a string');

  let metadata;
  if (options.metadata !== undefined) {
    metadata = options.metadata;
  } else if (source.metadata !== undefined && source.noteId !== undefined && source.id === undefined) {
    metadata = source.metadata;
  } else {
    metadata = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'content'));
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new RevisionStoreError('malformed_metadata', 'Revision metadata must be a JSON object');
  }
  if (metadata.id !== undefined && metadata.id !== noteId) {
    throw new RevisionStoreError('malformed_metadata', 'Revision metadata ID must match its note ID');
  }
  return { noteId, content, metadata, canonicalMetadata: canonicalJson(metadata) };
}

function normalizedTimestamp(value, fallback) {
  const timestamp = value ?? fallback;
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new RevisionStoreError('malformed_timestamp', 'Revision timestamp is invalid');
  return date.toISOString();
}

function defaultIdFactory() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new RevisionStoreError('crypto_unavailable', 'Web Crypto randomUUID is unavailable');
  }
  return globalThis.crypto.randomUUID();
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function estimatedBatchBytes(entries) {
  return entries.reduce((total, [key, value]) => total + byteLength(key) + byteLength(JSON.stringify(value)), 0);
}

function isQuotaError(error) {
  const description = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`.toLowerCase();
  return description.includes('quota');
}

function titleKey(value) {
  return String(value).trim().toLocaleLowerCase();
}

export function restoredCopyTitle(title, existingTitles = []) {
  const base = String(title || 'Untitled').trim() || 'Untitled';
  const occupied = new Set([...existingTitles].map(titleKey));
  let sequence = 1;
  let candidate = `${base} (restored copy)`;
  while (occupied.has(titleKey(candidate))) {
    sequence += 1;
    candidate = `${base} ${sequence} (restored copy)`;
  }
  return candidate;
}

function materializedPayload(revision) {
  if (!revision || typeof revision !== 'object' || typeof revision.content !== 'string' || !revision.metadata || typeof revision.metadata !== 'object') {
    throw new RevisionStoreError('malformed_revision', 'A materialized revision is required');
  }
  return revision;
}

export function createRestorePayload(currentNote, materializedRevision, restoredAt = new Date().toISOString()) {
  const current = typeof currentNote?.toJSON === 'function' ? currentNote.toJSON() : currentNote;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new RevisionStoreError('malformed_note', 'The current note is required to create a restore payload');
  }
  const revision = materializedPayload(materializedRevision);
  assertString(current.id, 'current note id');
  if (!Number.isFinite(Date.parse(current.createdAt))) {
    throw new RevisionStoreError('malformed_note', 'The current note createdAt is invalid');
  }
  const payload = {
    ...cloneJson(current),
    ...cloneJson(revision.metadata),
    content: revision.content,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: normalizedTimestamp(restoredAt, new Date()),
  };
  for (const stateField of ['deletedAt', 'archivedAt']) {
    if (stateField in current || stateField in revision.metadata) payload[stateField] = current[stateField] ?? null;
  }
  return payload;
}

export function createRestoreCopyPayload(materializedRevision, {
  id,
  createdAt = new Date().toISOString(),
  existingTitles = [],
} = {}) {
  const revision = materializedPayload(materializedRevision);
  assertString(id, 'copy id');
  if (id === revision.noteId) throw new RevisionStoreError('malformed_note', 'Restore as Copy requires a new note ID');
  const timestamp = normalizedTimestamp(createdAt, new Date());
  const payload = {
    ...cloneJson(revision.metadata),
    id,
    title: restoredCopyTitle(revision.metadata.title, existingTitles),
    content: revision.content,
    parentId: null,
    deletedAt: null,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return payload;
}

export class RevisionStore {
  constructor(storage, options = {}) {
    if (!storage || typeof storage.load !== 'function' || typeof storage.keys !== 'function') {
      throw new TypeError('RevisionStore requires an injected storage implementation');
    }
    this.storage = storage;
    this.retention = normalizeRetention(options.retention ?? options);
    this.gcBatchSize = normalizeBoundedInteger(options.gcBatchSize, 1, 1000, 25);
    this.quotaReserveRatio = typeof options.quotaReserveRatio === 'number' && options.quotaReserveRatio >= 0 && options.quotaReserveRatio <= 0.5
      ? options.quotaReserveRatio
      : 0.05;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultIdFactory;
    this.state = {
      paused: false,
      pauseReason: null,
      lastRevisionCapture: null,
      lastLocalSnapshot: null,
      lastError: null,
    };
    this.mutationQueue = Promise.resolve();
  }

  async backendStatus() {
    let status = null;
    if (typeof this.storage.getStatus === 'function') status = await this.storage.getStatus();
    else if (typeof this.storage.status === 'function') status = await this.storage.status();
    else if (typeof this.storage.ready === 'function') {
      const ready = await this.storage.ready();
      status = {
        backend: ready ? 'indexeddb' : 'localstorage',
        capabilities: { revisionHistory: ready, atomicBatch: ready },
      };
    }

    if (!status) {
      return {
        backend: 'injected',
        capabilities: { revisionHistory: true, atomicBatch: typeof this.storage.saveMany === 'function' },
        quota: null,
      };
    }
    return status;
  }

  async getStatus() {
    const backend = await this.backendStatus();
    const persisted = await this.storage.load(STATUS_KEY, {});
    const lastRevisionCapture = this.state.lastRevisionCapture
      ?? validStoredTimestamp(persisted?.lastRevisionCapture);
    const lastLocalSnapshot = this.state.lastLocalSnapshot
      ?? validStoredTimestamp(persisted?.lastLocalSnapshot);
    const historyAvailable = backend.capabilities?.revisionHistory
      ?? backend.historyAvailable
      ?? backend.backend === 'indexeddb';
    const atomicBatch = backend.capabilities?.atomicBatch ?? typeof this.storage.saveMany === 'function';
    const available = Boolean(historyAvailable && atomicBatch);
    return {
      available,
      historyAvailable: available,
      localSnapshotsAvailable: available,
      paused: this.state.paused,
      degraded: !available || this.state.paused || Boolean(this.state.lastError),
      reason: this.state.pauseReason ?? (available ? null : 'indexeddb_unavailable'),
      backend: backend.backend ?? 'unknown',
      quota: backend.quota ?? null,
      retention: { ...this.retention },
      lastRevisionCapture,
      lastRevisionAt: lastRevisionCapture,
      lastLocalSnapshot,
      lastLocalSnapshotAt: lastLocalSnapshot,
      lastError: this.state.lastError,
    };
  }

  resume() {
    this.state.paused = false;
    this.state.pauseReason = null;
    this.state.lastError = null;
  }

  async ensureAvailable() {
    const status = await this.getStatus();
    if (!status.available) {
      throw new RevisionStoreError('history_unavailable', 'Revision history requires durable IndexedDB storage', { details: status });
    }
    if (status.paused) {
      throw new RevisionStoreError('history_paused', 'Revision history is paused to protect current-note persistence', { details: status });
    }
    return status;
  }

  async readMany(keys, fallback = null) {
    if (typeof this.storage.loadMany === 'function') return this.storage.loadMany(keys, fallback);
    return Promise.all(keys.map((key) => this.storage.load(key, fallback)));
  }

  async writeMany(entries) {
    if (typeof this.storage.saveMany !== 'function') {
      throw new RevisionStoreError('history_unavailable', 'Revision history requires atomic batch writes');
    }
    try {
      const saved = await this.storage.saveMany(entries, { allowFallback: false });
      if (saved === false) {
        const backend = await this.backendStatus();
        const error = backend.lastError || 'Revision batch was not durably saved';
        if (isQuotaError(error)) throw new RevisionStoreError('quota_exceeded', String(error));
        throw new RevisionStoreError('revision_write_failed', String(error));
      }
    } catch (error) {
      if (error instanceof RevisionStoreError) throw error;
      if (isQuotaError(error)) throw new RevisionStoreError('quota_exceeded', 'Revision storage quota was exceeded', { cause: error });
      throw new RevisionStoreError('revision_write_failed', 'Revision batch could not be durably saved', { cause: error });
    }
  }

  async removeMany(keys) {
    if (keys.length === 0) return;
    try {
      if (typeof this.storage.removeMany === 'function') {
        const removed = await this.storage.removeMany(keys);
        if (removed === false) throw new Error('Batch remove failed');
      } else {
        await Promise.all(keys.map((key) => this.storage.remove(key)));
      }
    } catch (error) {
      throw new RevisionStoreError('revision_remove_failed', 'Revision records could not be pruned', { cause: error });
    }
  }

  pauseFor(error) {
    const quota = error?.code === 'quota_exceeded' || isQuotaError(error);
    this.state.paused = quota;
    this.state.pauseReason = quota ? 'quota' : 'storage_error';
    this.state.lastError = String(error?.message || error);
  }

  enqueueMutation(operation) {
    const run = () => typeof this.storage.withLock === 'function'
      ? this.storage.withLock('revision-store', operation)
      : operation();
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async scanNoteRecords(noteId) {
    const keys = await this.storage.keys(RECORD_PREFIX);
    const values = await this.readMany(keys, null);
    const records = [];
    values.forEach((raw, index) => {
      if (isMissing(raw) || raw?.noteId !== noteId) return;
      const id = keys[index].slice(RECORD_PREFIX.length);
      records.push(validateRecord(raw, id));
    });
    return records;
  }

  async list(noteId, { materialize = false, order = 'newest' } = {}) {
    assertString(noteId, 'noteId');
    await this.ensureAvailable();
    const indexedIds = await this.storage.load(indexKey(noteId), null);
    let records = null;
    let usedIndexOrder = false;
    if (Array.isArray(indexedIds)
      && indexedIds.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(indexedIds).size === indexedIds.length) {
      const indexedRecords = await this.readMany(indexedIds.map(recordKey), null);
      try {
        records = indexedRecords.map((raw, index) => {
          if (isMissing(raw)) throw new RevisionStoreError('incomplete_revision', 'Revision index references a missing record');
          const record = validateRecord(raw, indexedIds[index]);
          if (record.noteId !== noteId) throw new RevisionStoreError('malformed_revision', 'Revision index references another note');
          return record;
        });
        usedIndexOrder = true;
      } catch {
        records = null;
      }
    }
    // Legacy/corrupt stores may lack a usable index. The next capture writes a
    // rebuilt index atomically; the explicit rebuildIndex() API is available
    // for a repair without making ordinary healthy reads vault-wide.
    if (records === null) records = newestFirstByChain(await this.scanNoteRecords(noteId));
    else if (!usedIndexOrder) records = newestFirstByChain(records);
    if (order === 'oldest') records.reverse();
    if (!materialize) return records;
    return Promise.all(records.map((record) => this.materialize(record)));
  }

  async get(revisionId) {
    assertString(revisionId, 'id');
    await this.ensureAvailable();
    const raw = await this.storage.load(recordKey(revisionId), null);
    return validateRecord(raw, revisionId);
  }

  /** Service-facing alias that accepts either an ID or a history-view request. */
  async getRevision(request) {
    const revisionId = typeof request === 'string' ? request : request?.revisionId;
    return this.materialize(revisionId);
  }

  /** Service-facing alias used by the history view. */
  async listRevisions(noteId, options) {
    return this.list(noteId, options);
  }

  async materialize(recordOrId) {
    const record = typeof recordOrId === 'string' ? await this.get(recordOrId) : validateRecord(recordOrId, recordOrId?.id);
    const [content, canonicalMetadata] = await this.readMany([
      contentKey(record.contentHash),
      metadataKey(record.metadataHash),
    ], null);
    if (typeof content !== 'string' || typeof canonicalMetadata !== 'string') {
      throw new RevisionStoreError('incomplete_revision', 'Revision content or metadata blob is missing');
    }
    let metadata;
    try {
      metadata = JSON.parse(canonicalMetadata);
    } catch (error) {
      throw new RevisionStoreError('malformed_revision', 'Revision metadata blob is malformed', { cause: error });
    }
    const [actualContentHash, actualMetadataHash] = await Promise.all([
      sha256(content),
      sha256(canonicalJson(metadata)),
    ]);
    if (actualContentHash !== record.contentHash || actualMetadataHash !== record.metadataHash) {
      throw new RevisionStoreError('revision_integrity_failed', 'Revision blob integrity check failed');
    }
    return Object.freeze({ ...record, content, metadata: Object.freeze(metadata) });
  }

  capture(note, options = {}) {
    return this.enqueueMutation(() => this.captureNow(note, options));
  }

  async captureNow(note, options = {}) {
    if (typeof options === 'string') options = { reason: options };
    const status = await this.ensureAvailable();
    const reason = options.reason ?? 'autosave';
    if (!REVISION_REASONS.includes(reason)) {
      throw new RevisionStoreError('invalid_capture_reason', `Unsupported revision capture reason: ${reason}`);
    }
    const input = normalizeNoteInput(note, options);
    const createdAt = normalizedTimestamp(options.createdAt, this.now());
    const [contentHash, metadataHash] = await Promise.all([
      sha256(input.content),
      sha256(input.canonicalMetadata),
    ]);
    const existing = await this.list(input.noteId);
    const parent = existing[0] ?? null;
    if (!options.force && parent?.contentHash === contentHash && parent.metadataHash === metadataHash) {
      const retention = await this.pruneNow(input.noteId);
      return {
        captured: false,
        reason: 'unchanged',
        revision: parent,
        pruned: retention.pruned,
        garbageCollected: retention.garbageCollected,
      };
    }

    const id = this.idFactory();
    assertString(id, 'id');
    if (id.length > 512) throw new RevisionStoreError('invalid_revision_id', 'Revision ID is too long');
    if (!isMissing(await this.storage.load(recordKey(id), null))) {
      throw new RevisionStoreError('revision_id_collision', 'Revision ID already exists and immutable records cannot be overwritten');
    }

    const record = Object.freeze({
      id,
      noteId: input.noteId,
      createdAt,
      reason,
      contentHash,
      metadataHash,
      parentRevisionId: parent?.id ?? null,
      schemaVersion: REVISION_SCHEMA_VERSION,
    });
    const [storedContent, storedMetadata] = await this.readMany([
      contentKey(contentHash),
      metadataKey(metadataHash),
    ], null);
    if (!isMissing(storedContent) && storedContent !== input.content) {
      throw new RevisionStoreError('hash_collision', 'Stored revision content does not match its SHA-256 key');
    }
    if (!isMissing(storedMetadata) && storedMetadata !== input.canonicalMetadata) {
      throw new RevisionStoreError('hash_collision', 'Stored revision metadata does not match its SHA-256 key');
    }

    const index = [record.id, ...existing.map((entry) => entry.id)];
    const entries = [];
    if (isMissing(storedContent)) entries.push([contentKey(contentHash), input.content]);
    if (isMissing(storedMetadata)) entries.push([metadataKey(metadataHash), input.canonicalMetadata]);
    const storedStatus = await this.storage.load(STATUS_KEY, {});
    entries.push(
      [recordKey(record.id), record],
      [indexKey(input.noteId), index],
      [STATUS_KEY, {
        lastRevisionCapture: createdAt,
        lastLocalSnapshot: validStoredTimestamp(storedStatus?.lastLocalSnapshot),
      }],
    );

    const quota = status.quota;
    if (Number.isFinite(quota?.usage) && Number.isFinite(quota?.quota) && quota.quota > 0) {
      const remainingAfterWrite = quota.quota - quota.usage - estimatedBatchBytes(entries);
      if (remainingAfterWrite < quota.quota * this.quotaReserveRatio) {
        const error = new RevisionStoreError('quota_exceeded', 'Revision capture paused before consuming the current-note storage reserve');
        this.pauseFor(error);
        throw error;
      }
    }

    try {
      await this.writeMany(entries);
      this.state.lastRevisionCapture = createdAt;
      this.state.lastError = null;
      this.state.pauseReason = null;
      const retention = await this.pruneNow(input.noteId);
      return {
        captured: true,
        revision: record,
        pruned: retention.pruned,
        garbageCollected: retention.garbageCollected,
      };
    } catch (error) {
      this.pauseFor(error);
      throw error;
    }
  }

  prune(noteId, options = {}) {
    return this.enqueueMutation(() => this.pruneNow(noteId, options));
  }

  async pruneNow(noteId, { collectGarbage = true } = {}) {
    const records = await this.list(noteId);
    if (records.length === 0) return { pruned: 0, garbageCollected: 0 };
    const cutoff = new Date(this.now()).getTime() - this.retention.days * DAY_MS;
    const retainedAfterAge = records.filter((record, index) => index === 0 || Date.parse(record.createdAt) >= cutoff);
    const retained = retainedAfterAge.slice(0, this.retention.count);
    const retainedIds = new Set(retained.map((record) => record.id));
    const removed = records.filter((record) => !retainedIds.has(record.id));
    if (removed.length === 0) {
      return { pruned: 0, garbageCollected: 0 };
    }

    // Records are authoritative; the per-note index is only a derived fast
    // path. Delete first so a failed removal leaves the complete old index for
    // a later retry. If the following index write fails, list() detects its
    // missing record references and safely falls back to a record scan.
    await this.removeMany(removed.map((record) => recordKey(record.id)));
    await this.writeMany([[indexKey(noteId), retained.map((record) => record.id)]]);
    const garbage = collectGarbage ? await this.garbageCollectAllNow() : { removed: 0 };
    return { pruned: removed.length, garbageCollected: garbage.removed };
  }

  garbageCollect(options = {}) {
    return this.enqueueMutation(() => this.garbageCollectNow(options));
  }

  async unreferencedBlobKeysNow() {
    await this.ensureAvailable();
    const recordKeys = await this.storage.keys(RECORD_PREFIX);
    const records = await this.readMany(recordKeys, null);
    const referencedContent = new Set();
    const referencedMetadata = new Set();
    records.forEach((raw, index) => {
      if (isMissing(raw)) return;
      const id = recordKeys[index].slice(RECORD_PREFIX.length);
      const record = validateRecord(raw, id);
      referencedContent.add(contentKey(record.contentHash));
      referencedMetadata.add(metadataKey(record.metadataHash));
    });
    const snapshotKeys = await this.storage.keys(SNAPSHOT_RECORD_PREFIX);
    const snapshots = await this.readMany(snapshotKeys, null);
    snapshots.forEach((raw, index) => {
      if (isMissing(raw)) return;
      const id = snapshotKeys[index].slice(SNAPSHOT_RECORD_PREFIX.length);
      const snapshot = validateSnapshotRecord(raw, id);
      snapshot.notes.forEach((reference) => {
        referencedContent.add(contentKey(reference.contentHash));
        referencedMetadata.add(metadataKey(reference.metadataHash));
      });
      referencedMetadata.add(metadataKey(snapshot.configHash));
    });

    const [contentKeys, metadataKeys] = await Promise.all([
      this.storage.keys(CONTENT_PREFIX),
      this.storage.keys(METADATA_PREFIX),
    ]);
    return [
      ...contentKeys.filter((key) => !referencedContent.has(key)),
      ...metadataKeys.filter((key) => !referencedMetadata.has(key)),
    ];
  }

  async garbageCollectNow({ limit = this.gcBatchSize } = {}) {
    const boundedLimit = normalizeBoundedInteger(limit, 1, 1000, this.gcBatchSize);
    const unreferenced = await this.unreferencedBlobKeysNow();
    const batch = unreferenced.slice(0, boundedLimit);
    await this.removeMany(batch);
    return { removed: batch.length, remaining: unreferenced.length - batch.length };
  }

  /**
   * Drain every currently unreferenced blob while keeping each storage
   * transaction bounded. Retention paths await this method so a large pruned
   * snapshot cannot leave an indefinitely growing orphan backlog.
   */
  garbageCollectAll(options = {}) {
    return this.enqueueMutation(() => this.garbageCollectAllNow(options));
  }

  async garbageCollectAllNow({ limit = this.gcBatchSize } = {}) {
    const boundedLimit = normalizeBoundedInteger(limit, 1, 1000, this.gcBatchSize);
    // The origin-wide mutation lock keeps this fixed candidate set stable.
    // Compute references once, then retain bounded delete transactions without
    // re-reading the full vault for every batch.
    const unreferenced = await this.unreferencedBlobKeysNow();
    for (let offset = 0; offset < unreferenced.length; offset += boundedLimit) {
      await this.removeMany(unreferenced.slice(offset, offset + boundedLimit));
    }
    return {
      removed: unreferenced.length,
      remaining: 0,
      batches: Math.ceil(unreferenced.length / boundedLimit),
    };
  }

  rebuildIndex(noteId) {
    return this.enqueueMutation(() => this.rebuildIndexNow(noteId));
  }

  async rebuildIndexNow(noteId) {
    assertString(noteId, 'noteId');
    await this.ensureAvailable();
    const records = newestFirstByChain(await this.scanNoteRecords(noteId));
    await this.writeMany([[indexKey(noteId), records.map((record) => record.id)]]);
    return records.length;
  }

  async listSnapshots({ kind, materialize = false, order = 'newest' } = {}) {
    await this.ensureAvailable();
    if (kind !== undefined && !(kind in SNAPSHOT_LIMITS)) {
      throw new RevisionStoreError('invalid_snapshot_kind', 'Local snapshot kind must be daily or weekly');
    }
    const keys = await this.storage.keys(SNAPSHOT_RECORD_PREFIX);
    const values = await this.readMany(keys, null);
    const records = values.flatMap((raw, index) => {
      if (isMissing(raw)) return [];
      const id = keys[index].slice(SNAPSHOT_RECORD_PREFIX.length);
      const record = validateSnapshotRecord(raw, id);
      return kind === undefined || record.kind === kind ? [record] : [];
    });
    records.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id));
    if (order === 'oldest') records.reverse();
    if (!materialize) return records;
    return Promise.all(records.map((record) => this.materializeSnapshot(record)));
  }

  async getSnapshot(snapshotId) {
    assertString(snapshotId, 'snapshot id');
    await this.ensureAvailable();
    const raw = await this.storage.load(snapshotRecordKey(snapshotId), null);
    return validateSnapshotRecord(raw, snapshotId);
  }

  async materializeSnapshot(recordOrId) {
    const record = typeof recordOrId === 'string'
      ? await this.getSnapshot(recordOrId)
      : validateSnapshotRecord(recordOrId, recordOrId?.id);
    const keys = record.notes.flatMap((entry) => [
      contentKey(entry.contentHash),
      metadataKey(entry.metadataHash),
    ]);
    keys.push(metadataKey(record.configHash));
    const blobs = await this.readMany(keys, null);
    const notes = [];
    for (let index = 0; index < record.notes.length; index += 1) {
      const reference = record.notes[index];
      const content = blobs[index * 2];
      const canonicalMetadata = blobs[index * 2 + 1];
      if (typeof content !== 'string' || typeof canonicalMetadata !== 'string') {
        throw new RevisionStoreError('incomplete_snapshot', `Local snapshot is missing data for note ${reference.noteId}`);
      }
      let metadata;
      try {
        metadata = JSON.parse(canonicalMetadata);
      } catch (error) {
        throw new RevisionStoreError('malformed_snapshot', `Local snapshot metadata is malformed for note ${reference.noteId}`, { cause: error });
      }
      const [actualContentHash, actualMetadataHash] = await Promise.all([
        sha256(content),
        sha256(canonicalJson(metadata)),
      ]);
      if (actualContentHash !== reference.contentHash || actualMetadataHash !== reference.metadataHash) {
        throw new RevisionStoreError('snapshot_integrity_failed', `Local snapshot integrity check failed for note ${reference.noteId}`);
      }
      notes.push(Object.freeze({ ...metadata, id: metadata.id ?? reference.noteId, content }));
    }
    const canonicalConfig = blobs.at(-1);
    if (typeof canonicalConfig !== 'string') {
      throw new RevisionStoreError('incomplete_snapshot', 'Local snapshot config data is missing');
    }
    let config;
    try {
      config = JSON.parse(canonicalConfig);
    } catch (error) {
      throw new RevisionStoreError('malformed_snapshot', 'Local snapshot config data is malformed', { cause: error });
    }
    if (!config || typeof config !== 'object' || Array.isArray(config) || await sha256(canonicalJson(config)) !== record.configHash) {
      throw new RevisionStoreError('snapshot_integrity_failed', 'Local snapshot config integrity check failed');
    }
    return Object.freeze({
      ...record,
      notes: Object.freeze(notes),
      config: Object.freeze(config),
    });
  }

  createSnapshot(vault, options = {}) {
    return this.enqueueMutation(() => this.createSnapshotNow(vault, options));
  }

  async createSnapshotNow(vault, { kind = 'daily', createdAt = this.now() } = {}) {
    const status = await this.ensureAvailable();
    if (!(kind in SNAPSHOT_LIMITS)) {
      throw new RevisionStoreError('invalid_snapshot_kind', 'Local snapshot kind must be daily or weekly');
    }
    if (!vault || typeof vault !== 'object' || Array.isArray(vault) || !Array.isArray(vault.notes)) {
      throw new RevisionStoreError('malformed_snapshot', 'A local snapshot requires a vault object with a notes array');
    }
    if (!vault.config || typeof vault.config !== 'object' || Array.isArray(vault.config)) {
      throw new RevisionStoreError('malformed_snapshot', 'A local snapshot requires the complete vault config object');
    }
    const vaultSchemaVersion = vault.vaultSchemaVersion ?? vault.schemaVersion;
    if (!Number.isInteger(vaultSchemaVersion) || vaultSchemaVersion < 0) {
      throw new RevisionStoreError('malformed_snapshot', 'A local snapshot requires a valid vault schema version');
    }
    const timestamp = normalizedTimestamp(createdAt, this.now());
    const period = snapshotPeriod(kind, timestamp);
    const samePeriod = (await this.listSnapshots({ kind })).find((snapshot) => snapshot.period === period);
    if (samePeriod) {
      const pruned = await this.pruneSnapshotsNow(kind);
      return {
        created: false,
        snapshot: samePeriod,
        pruned: pruned.pruned,
        garbageCollected: pruned.garbageCollected,
      };
    }
    const sourceNotes = vault.notes;
    const inputs = sourceNotes.map((note) => normalizeNoteInput(note, {}));
    const canonicalConfig = canonicalJson(vault.config);
    const configHash = await sha256(canonicalConfig);
    const seen = new Set();
    for (const input of inputs) {
      if (seen.has(input.noteId)) throw new RevisionStoreError('malformed_snapshot', 'A local snapshot cannot contain duplicate note IDs');
      seen.add(input.noteId);
    }
    const references = await Promise.all(inputs.map(async (input) => ({
      noteId: input.noteId,
      contentHash: await sha256(input.content),
      metadataHash: await sha256(input.canonicalMetadata),
    })));
    const id = this.idFactory();
    assertString(id, 'snapshot id');
    if (id.length > 512) throw new RevisionStoreError('invalid_revision_id', 'Snapshot ID is too long');
    if (!isMissing(await this.storage.load(snapshotRecordKey(id), null))) {
      throw new RevisionStoreError('revision_id_collision', 'Snapshot ID already exists and immutable records cannot be overwritten');
    }
    const record = Object.freeze({
      id,
      createdAt: timestamp,
      kind,
      period,
      notes: references.map((entry) => Object.freeze(entry)),
      configHash,
      vaultSchemaVersion,
      schemaVersion: REVISION_SCHEMA_VERSION,
    });

    const uniqueBlobs = new Map();
    inputs.forEach((input, index) => {
      uniqueBlobs.set(contentKey(references[index].contentHash), input.content);
      uniqueBlobs.set(metadataKey(references[index].metadataHash), input.canonicalMetadata);
    });
    uniqueBlobs.set(metadataKey(configHash), canonicalConfig);
    const blobKeys = [...uniqueBlobs.keys()];
    const storedBlobs = await this.readMany(blobKeys, null);
    const entries = [];
    blobKeys.forEach((key, index) => {
      const value = uniqueBlobs.get(key);
      if (!isMissing(storedBlobs[index]) && storedBlobs[index] !== value) {
        throw new RevisionStoreError('hash_collision', 'Stored snapshot data does not match its SHA-256 key');
      }
      if (isMissing(storedBlobs[index])) entries.push([key, value]);
    });
    const storedStatus = await this.storage.load(STATUS_KEY, {});
    entries.push(
      [snapshotRecordKey(id), record],
      [STATUS_KEY, {
        lastRevisionCapture: validStoredTimestamp(storedStatus?.lastRevisionCapture),
        lastLocalSnapshot: timestamp,
      }],
    );

    const quota = status.quota;
    if (Number.isFinite(quota?.usage) && Number.isFinite(quota?.quota) && quota.quota > 0) {
      const remainingAfterWrite = quota.quota - quota.usage - estimatedBatchBytes(entries);
      if (remainingAfterWrite < quota.quota * this.quotaReserveRatio) {
        const error = new RevisionStoreError('quota_exceeded', 'Local snapshot paused before consuming the current-note storage reserve');
        this.pauseFor(error);
        throw error;
      }
    }

    try {
      await this.writeMany(entries);
      this.state.lastLocalSnapshot = timestamp;
      this.state.lastError = null;
      this.state.pauseReason = null;
      const pruned = await this.pruneSnapshotsNow(kind);
      return { created: true, snapshot: record, pruned: pruned.pruned, garbageCollected: pruned.garbageCollected };
    } catch (error) {
      this.pauseFor(error);
      throw error;
    }
  }

  pruneSnapshots(kind) {
    return this.enqueueMutation(() => this.pruneSnapshotsNow(kind));
  }

  async pruneSnapshotsNow(kind, { collectGarbage = true } = {}) {
    if (!(kind in SNAPSHOT_LIMITS)) {
      throw new RevisionStoreError('invalid_snapshot_kind', 'Local snapshot kind must be daily or weekly');
    }
    const records = await this.listSnapshots({ kind });
    const removed = records.slice(SNAPSHOT_LIMITS[kind]);
    if (removed.length === 0) return { pruned: 0, garbageCollected: 0 };
    await this.removeMany(removed.map((record) => snapshotRecordKey(record.id)));
    const garbage = collectGarbage ? await this.garbageCollectAllNow() : { removed: 0 };
    return { pruned: removed.length, garbageCollected: garbage.removed };
  }

  deleteSnapshot(snapshotId) {
    return this.enqueueMutation(() => this.deleteSnapshotNow(snapshotId));
  }

  async deleteSnapshotNow(snapshotId) {
    await this.getSnapshot(snapshotId);
    await this.removeMany([snapshotRecordKey(snapshotId)]);
    return this.garbageCollectAllNow();
  }

  deleteNoteHistory(noteId) {
    return this.deleteNoteHistories([noteId]);
  }

  deleteNoteHistories(noteIds) {
    return this.enqueueMutation(() => this.deleteNoteHistoriesNow(noteIds));
  }

  async deleteNoteHistoriesNow(noteIds) {
    const ids = [...new Set(noteIds)];
    ids.forEach((id) => assertString(id, 'noteId'));
    await this.ensureAvailable();
    const recordIds = [];
    for (const noteId of ids) {
      const records = await this.list(noteId);
      records.forEach((record) => recordIds.push(record.id));
    }
    const purgedSet = new Set(ids);
    const snapshots = await this.listSnapshots();
    const removedSnapshots = snapshots.filter((snapshot) => (
      snapshot.notes.some((reference) => purgedSet.has(reference.noteId))
    ));
    const keys = [
      ...recordIds.map(recordKey),
      ...ids.map(indexKey),
      ...removedSnapshots.map((snapshot) => snapshotRecordKey(snapshot.id)),
    ];
    for (let offset = 0; offset < keys.length; offset += 1000) {
      await this.removeMany(keys.slice(offset, offset + 1000));
    }
    const garbage = await this.garbageCollectAllNow();
    return {
      notes: ids.length,
      revisions: recordIds.length,
      snapshots: removedSnapshots.length,
      garbageCollected: garbage.removed,
    };
  }

  reconcileVaultNoteIds(noteIds) {
    return this.enqueueMutation(() => this.reconcileVaultNoteIdsNow(noteIds));
  }

  async reconcileVaultNoteIdsNow(noteIds) {
    const liveIds = new Set(noteIds);
    liveIds.forEach((id) => assertString(id, 'noteId'));
    await this.ensureAvailable();
    const absentIds = new Set();
    const revisionNoteIds = new Set();
    const recordKeys = await this.storage.keys(RECORD_PREFIX);
    const records = await this.readMany(recordKeys, null);
    records.forEach((raw, index) => {
      if (isMissing(raw)) return;
      const record = validateRecord(raw, recordKeys[index].slice(RECORD_PREFIX.length));
      revisionNoteIds.add(record.noteId);
      if (!liveIds.has(record.noteId)) absentIds.add(record.noteId);
    });
    const snapshots = await this.listSnapshots();
    snapshots.forEach((snapshot) => snapshot.notes.forEach((reference) => {
      if (!liveIds.has(reference.noteId)) absentIds.add(reference.noteId);
    }));

    const removed = absentIds.size
      ? await this.deleteNoteHistoriesNow([...absentIds])
      : { notes: 0, revisions: 0, snapshots: 0, garbageCollected: 0 };
    let pruned = 0;
    for (const noteId of revisionNoteIds) {
      if (!liveIds.has(noteId)) continue;
      const retention = await this.pruneNow(noteId, { collectGarbage: false });
      pruned += retention.pruned;
    }
    let snapshotsPruned = 0;
    for (const kind of Object.keys(SNAPSHOT_LIMITS)) {
      const retention = await this.pruneSnapshotsNow(kind, { collectGarbage: false });
      snapshotsPruned += retention.pruned;
    }
    // Always retry orphan collection on startup. A prior cleanup can commit
    // record/snapshot removal and then be interrupted before its blob sweep;
    // once that happens there is intentionally no live record left to signal
    // the unfinished work.
    const garbage = await this.garbageCollectAllNow();
    return {
      ...removed,
      pruned,
      snapshotsPruned,
      garbageCollected: removed.garbageCollected + garbage.removed,
    };
  }

  async buildRestorePayload(currentNote, recordOrId, { restoredAt = this.now() } = {}) {
    const revision = await this.materialize(recordOrId);
    return createRestorePayload(currentNote, revision, restoredAt);
  }

  async buildRestoreCopyPayload(recordOrId, {
    id = this.idFactory(),
    createdAt = this.now(),
    existingTitles = [],
  } = {}) {
    const revision = await this.materialize(recordOrId);
    return createRestoreCopyPayload(revision, { id, createdAt, existingTitles });
  }

  /**
   * Validate the selected revision, durably capture the current state, then
   * return (but do not persist) the note payload that database integration may apply.
   */
  async prepareRestore(currentNote, recordOrId, { restoredAt = this.now() } = {}) {
    const selectedRevision = await this.materialize(recordOrId);
    // Restore is the one boundary where an explicit record is required even
    // when the latest autosave already has identical blobs. The record remains
    // tiny because content/metadata are still hash-deduplicated.
    const safetyCapture = await this.capture(currentNote, { reason: 'pre_restore', force: true });
    const payload = createRestorePayload(currentNote, selectedRevision, restoredAt);
    return { selectedRevision, safetyCapture, payload };
  }
}
