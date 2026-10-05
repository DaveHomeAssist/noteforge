import { introducedIdentityClaims, identityCollisionsFor } from './note-identity.js';

// Current-note commits use IndexedDB's transaction isolation, not window-local
// queues or advisory locks. No asynchronous computation runs inside a transaction.
export const VAULT_META = 'vault:meta';
export const VAULT_CONFIG = 'vault:config';
export const NOTE_PREFIX = 'note:';
export const CONFLICT_PREFIX = 'vault:conflict:';
export const RESOLVED_CONFLICT_PREFIX = 'vault:resolved-conflict:';
export const LEGACY_BACKUP = 'vault:legacy-backup';
export const LEGACY_CAPTURE = 'vault:legacy-capture';
export const SCHEMA_BACKUP_PREFIX = 'vault:schema-backup:';
export const LEGACY_ARCHIVE_PREFIX = 'vault:legacy-archive:';
// The legacy current-state sources. After activation this build reads them and
// never writes them; shared revision history and lease keys are not current state.
export const LEGACY_KEYS = ['notes', 'config', 'schemaVersion'];

function sameDraft(left = [], right = []) {
  const withoutVersions = (writes) => JSON.stringify(writes.map((write) => ({ ...write, expected: 0 })));
  return withoutVersions(left) === withoutVersions(right);
}

// Only newly introduced live names need a scan. The cursor and final writes
// share one readwrite transaction, so a competing claim cannot slip between them.
function checkIdentity(store, notes, current, conflicts, apply) {
  const claims = introducedIdentityClaims(notes, current);
  if (!claims.size) return apply();
  const changed = new Set(notes.map((write) => write.id));
  // Include the final state of every write: a batch can release and claim a name,
  // but two new records in that batch cannot both introduce the same live name.
  for (const write of notes) conflicts.push(...identityCollisionsFor(claims, write.id, write.value));
  const request = store.openCursor(IDBKeyRange.bound(NOTE_PREFIX, `${NOTE_PREFIX}\uffff`));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return apply();
    const id = String(cursor.key).slice(NOTE_PREFIX.length);
    if (!changed.has(id)) conflicts.push(...identityCollisionsFor(claims, id, cursor.value.value));
    cursor.continue();
  };
}

/** @param {(NoteWrite | ConfigWrite)[]} writes
 * @param {'id' | 'key'} identity
 */
function validateWrites(writes, identity) {
  if (
    new Set(writes.map((write) => write[identity])).size !== writes.length ||
    writes.some((write) => !write[identity] || !Number.isSafeInteger(write.expected) || write.expected < 0)
  )
    throw new TypeError('Invalid or duplicate mutation.');
}

/** @typedef {{id:string, [key:string]:unknown}} RawNote */
/** @typedef {{version:number, value:RawNote|null}} RecordValue */
/** @typedef {{id:string, expected:number, value:RawNote|null, allowIdentityConflicts?:boolean}} NoteWrite */
/** @typedef {{key:string, expected:number, value:unknown, remove?:boolean}} ConfigWrite */
/** @typedef {{generation:string, sequence?:number, notes?:NoteWrite[], config?:ConfigWrite[],
 * conflictId?:string, timestamp:string, resolution?:{id:string,fingerprint:string,action:'keep-current'|'save-copy'|'use-draft'},
 * replacement?:{notes:RawNote[], config:object, schemaVersion:number}}} Mutation */

/** Resolve only after transaction completion; a request success is not a commit. */
function transactionResult(transaction, result) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || new Error('The vault transaction was aborted.'));
  });
}

/** Read a consistent snapshot, including tombstone versions and config versions.
 * @param {IDBDatabase} db
 * @param {string} storeName
 */
export function readVault(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const snapshot = { meta: null, config: null, persistence: null, records: [], conflicts: [] };
  const done = transactionResult(tx, () => snapshot);
  const meta = store.get(VAULT_META);
  const config = store.get(VAULT_CONFIG);
  meta.onsuccess = () => {
    snapshot.meta = meta.result ?? null;
    // The save time lives in the activation marker, never in a legacy key.
    if (snapshot.meta?.lastPersistedAt) snapshot.persistence = { lastPersistedAt: snapshot.meta.lastPersistedAt };
  };
  config.onsuccess = () => {
    snapshot.config = config.result ?? null;
  };
  const records = store.openCursor(IDBKeyRange.bound(NOTE_PREFIX, `${NOTE_PREFIX}\uffff`));
  records.onsuccess = () => {
    const cursor = records.result;
    if (!cursor) return;
    snapshot.records.push([String(cursor.key).slice(NOTE_PREFIX.length), cursor.value]);
    cursor.continue();
  };
  const conflicts = store.openCursor(IDBKeyRange.bound(CONFLICT_PREFIX, `${CONFLICT_PREFIX}\uffff`));
  conflicts.onsuccess = () => {
    const cursor = conflicts.result;
    if (!cursor) return;
    snapshot.conflicts.push(cursor.value);
    cursor.continue();
  };
  return done;
}

/** Read only what tells a window whether a full refresh is needed. */
export function readVaultHead(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const head = { meta: null, conflictIds: [] };
  const done = transactionResult(tx, () => head);
  const meta = store.get(VAULT_META);
  meta.onsuccess = () => {
    head.meta = meta.result ?? null;
  };
  const conflicts = store.openKeyCursor(IDBKeyRange.bound(CONFLICT_PREFIX, `${CONFLICT_PREFIX}\uffff`));
  conflicts.onsuccess = () => {
    const cursor = conflicts.result;
    if (!cursor) return;
    head.conflictIds.push(String(cursor.key).slice(CONFLICT_PREFIX.length));
    cursor.continue();
  };
  return done;
}

/** A legacy note version kept for explicit review. It is never applied automatically. */
export function legacyConflict({
  generation,
  timestamp,
  id,
  value,
  current,
  backend,
  kind,
  raw,
  conflictId = `legacy-${crypto.randomUUID()}`,
}) {
  return {
    id: conflictId,
    mutation: {
      generation,
      timestamp,
      conflictId,
      notes: [{ id, expected: current?.version ?? 0, value }],
      config: [],
    },
    conflicts: [{ kind: 'note', id, current: current ?? { version: 0, value: null } }],
    detectedAt: timestamp,
    legacy: { backend, kind, raw },
  };
}

function sameSource(read, supplied, key) {
  const present = Object.hasOwn(supplied, key);
  return read === undefined ? !present : present && JSON.stringify(read) === JSON.stringify(supplied[key]);
}

/** Activate the per-note vault from caller-verified legacy sources.
 * Each source is compared with the bytes it supplied: IndexedDB inside this
 * transaction, localStorage synchronously within it. Legacy current-state keys
 * are read and never written. Records, archive, capture baseline, review items
 * and the marker commit together or not at all.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {{timestamp:string, indexedDB:object, localStorage:object|null, backup:object,
 *   migrated:{notes:RawNote[],config:object,schemaVersion:number},
 *   reviews:{id:string,value:RawNote,raw:unknown,backend:string,kind:string}[]}} plan
 * @param {string} generation
 * @param {() => object|null} [readLocal]
 */
export function initializeVault(db, storeName, plan, generation, readLocal = () => null) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  let result = { status: 'stale' };
  const done = transactionResult(tx, () => result);
  const supplied = plan.indexedDB ?? {};
  const requests = [...LEGACY_KEYS, VAULT_META].map((key) => store.get(key));
  let pending = requests.length;
  for (const request of requests) {
    request.onsuccess = () => {
      if (--pending) return;
      if (requests[LEGACY_KEYS.length].result) {
        result = { status: 'existing' };
        return;
      }
      if (!LEGACY_KEYS.every((key, index) => sameSource(requests[index].result, supplied, key))) return;
      if (plan.localStorage) {
        let local;
        try {
          local = readLocal();
        } catch {
          return;
        }
        if (JSON.stringify(local) !== JSON.stringify(plan.localStorage)) return;
      }
      store.put(plan.backup, LEGACY_BACKUP);
      const current = new Map();
      for (const note of plan.migrated.notes) {
        current.set(note.id, { version: 1, value: note });
        store.put({ version: 1, value: note }, NOTE_PREFIX + note.id);
      }
      store.put(
        {
          values: plan.migrated.config,
          versions: Object.fromEntries(Object.keys(plan.migrated.config).map((key) => [key, 1])),
        },
        VAULT_CONFIG,
      );
      store.put(
        { generation, sequence: 0, schemaVersion: plan.migrated.schemaVersion, activatedAt: plan.timestamp },
        VAULT_META,
      );
      // Later legacy saves are captured against exactly these source values.
      store.put(
        {
          version: 1,
          capturedAt: plan.timestamp,
          captures: 0,
          indexedDB: supplied,
          localStorage: plan.localStorage,
        },
        LEGACY_CAPTURE,
      );
      for (const review of plan.reviews ?? []) {
        const conflict = legacyConflict({
          ...review,
          generation,
          timestamp: plan.timestamp,
          current: current.get(review.id),
        });
        store.put(conflict, CONFLICT_PREFIX + conflict.id);
      }
      result = { status: 'committed', reviews: plan.reviews?.length ?? 0 };
    };
  }
  return done;
}

/** Migrate an activated vault from an older schema in one conditional transaction.
 * The previous records are archived; changed notes and settings get new versions,
 * and the new generation makes work queued against the old shape conflict.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {{generation:string,sequence:number,schemaVersion:number}} expected
 * @param {{notes:RawNote[],config:object,schemaVersion:number}} migrated
 * @param {string} generation
 * @param {string} timestamp
 */
export function migrateVault(db, storeName, expected, migrated, generation, timestamp) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  let result = { status: 'stale' };
  const done = transactionResult(tx, () => result);
  const metaRequest = store.get(VAULT_META);
  const configRequest = store.get(VAULT_CONFIG);
  const records = [];
  const cursorRequest = store.openCursor(IDBKeyRange.bound(NOTE_PREFIX, `${NOTE_PREFIX}\uffff`));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      records.push([String(cursor.key).slice(NOTE_PREFIX.length), cursor.value]);
      cursor.continue();
      return;
    }
    const meta = metaRequest.result;
    const settings = configRequest.result;
    const next = new Map(migrated.notes.map((note) => [note.id, note]));
    const live = records.filter(([, record]) => record.value);
    if (
      !meta ||
      !settings ||
      meta.generation !== expected.generation ||
      meta.sequence !== expected.sequence ||
      meta.schemaVersion !== expected.schemaVersion ||
      live.length !== next.size ||
      live.some(([id]) => !next.has(id))
    )
      return;
    store.put(
      { meta, config: settings, records, migratedAt: timestamp, toSchemaVersion: migrated.schemaVersion },
      `${SCHEMA_BACKUP_PREFIX}${meta.schemaVersion}:${meta.generation}`,
    );
    for (const [id, record] of live) {
      const value = next.get(id);
      if (JSON.stringify(value) !== JSON.stringify(record.value))
        store.put({ version: record.version + 1, value }, NOTE_PREFIX + id);
    }
    let versions = settings.versions;
    for (const key of new Set([...Object.keys(settings.values), ...Object.keys(migrated.config)])) {
      const before = Object.hasOwn(settings.values, key) ? JSON.stringify(settings.values[key]) : undefined;
      const after = Object.hasOwn(migrated.config, key) ? JSON.stringify(migrated.config[key]) : undefined;
      if (before !== after) versions = { ...versions, [key]: (Object.hasOwn(versions, key) ? versions[key] : 0) + 1 };
    }
    store.put({ values: migrated.config, versions }, VAULT_CONFIG);
    const nextMeta = {
      ...meta,
      generation,
      sequence: meta.sequence + 1,
      schemaVersion: migrated.schemaVersion,
      lastPersistedAt: timestamp,
    };
    store.put(nextMeta, VAULT_META);
    result = { status: 'committed', meta: nextMeta };
  };
  return done;
}

const presentLegacy = (requests) =>
  Object.fromEntries(
    LEGACY_KEYS.flatMap((key, index) => (requests[index].result === undefined ? [] : [[key, requests[index].result]])),
  );

/** Order-independent JSON: a legacy save re-serializes every note in its own key order. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function parseRaw(raw) {
  try {
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Per-note differences between two legacy note arrays. Deletions are reported, never applied. */
function legacyChanges(backend, base, now, schemaVersion, normalize) {
  if (!Array.isArray(now)) return [];
  const before = new Map((Array.isArray(base) ? base : []).map((note) => [note?.id, canonicalJSON(note)]));
  const after = new Set();
  const changes = [];
  for (const raw of now) {
    if (typeof raw?.id !== 'string' || !raw.id) continue;
    after.add(raw.id);
    if (before.get(raw.id) === canonicalJSON(raw)) continue;
    const value = normalize(raw, schemaVersion);
    if (value) changes.push({ backend, id: raw.id, raw, value, kind: before.has(raw.id) ? 'edit' : 'new' });
  }
  for (const id of before.keys())
    if (typeof id === 'string' && id && !after.has(id))
      changes.push({ backend, id, raw: null, value: null, kind: 'deletion' });
  return changes;
}

/** Capture legacy saves made after activation as durable review items.
 * One readwrite transaction re-reads the legacy IndexedDB values, records each
 * changed, new or deleted legacy note beside the current note, archives legacy
 * settings unapplied, and advances the baseline to exactly what it read. The
 * fallback is read synchronously inside it; a later fallback save differs from
 * the recorded bytes and is caught by the next capture. Current notes, settings
 * and the legacy sources are never written.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {() => object|null} readLocal
 * @param {(raw: object, schemaVersion: unknown) => RawNote|null} normalize
 * @param {string} timestamp
 */
export function captureLegacy(db, storeName, readLocal, normalize, timestamp) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const result = { status: 'inactive', conflicts: [], seen: null };
  const done = transactionResult(tx, () => result);
  const requests = [...LEGACY_KEYS, LEGACY_CAPTURE, VAULT_META].map((key) => store.get(key));
  const active = [];
  const cursorRequest = store.openCursor(IDBKeyRange.bound(CONFLICT_PREFIX, `${CONFLICT_PREFIX}\uffff`));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      if (cursor.value?.legacy) active.push(cursor.value);
      cursor.continue();
      return;
    }
    const baseline = requests[LEGACY_KEYS.length].result;
    const meta = requests[LEGACY_KEYS.length + 1].result;
    if (!baseline || !meta) return;
    let local = null;
    try {
      local = readLocal();
    } catch {
      // An unreadable fallback cannot be compared; its baseline stays unchanged.
    }
    const indexed = presentLegacy(requests);
    result.status = 'unchanged';
    result.seen = JSON.stringify([indexed, local]);
    const base = baseline.indexedDB ?? {};
    const indexedChanged = JSON.stringify(indexed) !== JSON.stringify(base);
    const localChanged = local !== null && JSON.stringify(local) !== JSON.stringify(baseline.localStorage);
    if (!indexedChanged && !localChanged) return;
    const baseLocalNotes = parseRaw(baseline.localStorage?.notes);
    const changes = [];
    const archive = {};
    if (indexedChanged) {
      // A legacy client copies fallback notes into an absent IndexedDB key on load.
      changes.push(
        ...legacyChanges(
          'indexeddb',
          Object.hasOwn(base, 'notes') ? base.notes : baseLocalNotes,
          indexed.notes,
          indexed.schemaVersion,
          normalize,
        ),
      );
      for (const key of ['config', 'schemaVersion'])
        if (JSON.stringify(indexed[key]) !== JSON.stringify(base[key]))
          archive.indexedDB = { ...archive.indexedDB, [key]: indexed[key] };
    }
    if (localChanged) {
      const notes = parseRaw(local.notes);
      if (local.notes !== null && notes === undefined) archive.localStorage = { notes: local.notes };
      changes.push(...legacyChanges('localstorage', baseLocalNotes, notes, parseRaw(local.schemaVersion), normalize));
      for (const key of ['config', 'schemaVersion'])
        if (local[key] !== (baseline.localStorage?.[key] ?? null))
          archive.localStorage = { ...archive.localStorage, [key]: local[key] };
    }
    const currentRequests = changes.map((change) => store.get(NOTE_PREFIX + change.id));
    let pending = currentRequests.length;
    const record = () => {
      const byNote = new Map(
        active.map((conflict) => [`${conflict.legacy.backend}:${conflict.mutation.notes[0]?.id}`, conflict]),
      );
      const drafts = new Set(
        active.map(
          (conflict) => `${conflict.mutation.notes[0]?.id}:${canonicalJSON(conflict.mutation.notes[0]?.value)}`,
        ),
      );
      changes.forEach((change, index) => {
        const current = currentRequests[index].result;
        const draft = `${change.id}:${canonicalJSON(change.value)}`;
        // Nothing to review: the vault already holds this exact note, or the
        // deleted note is already gone, or another review item holds this draft.
        if (
          change.kind === 'deletion'
            ? !current?.value
            : canonicalJSON(current?.value ?? null) === canonicalJSON(change.value)
        )
          return;
        if (drafts.has(draft)) return;
        drafts.add(draft);
        const key = `${change.backend}:${change.id}`;
        const previous = byNote.get(key);
        // Repeated saves of one note from one older window update its review item;
        // every earlier captured version stays in that item's history.
        const conflict = legacyConflict({
          ...change,
          generation: meta.generation,
          timestamp,
          current,
          ...(previous ? { conflictId: previous.id } : {}),
        });
        if (previous)
          conflict.legacy.history = [
            ...(previous.legacy.history ?? []),
            { capturedAt: previous.detectedAt, kind: previous.legacy.kind, raw: previous.legacy.raw },
          ];
        store.put(conflict, CONFLICT_PREFIX + conflict.id);
        byNote.set(key, conflict);
        result.conflicts.push(conflict);
      });
      if (Object.keys(archive).length)
        store.put({ capturedAt: timestamp, ...archive }, `${LEGACY_ARCHIVE_PREFIX}${timestamp}:${crypto.randomUUID()}`);
      store.put(
        {
          ...baseline,
          capturedAt: timestamp,
          captures: (baseline.captures ?? 0) + 1,
          indexedDB: indexed,
          localStorage: local ?? baseline.localStorage,
        },
        LEGACY_CAPTURE,
      );
      result.status = 'captured';
    };
    if (!pending) record();
    for (const request of currentRequests)
      request.onsuccess = () => {
        if (!--pending) record();
      };
  };
  return done;
}

/** Atomically compare versions and apply a mutation, retaining conflicting drafts.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {Mutation} mutation
 */
export function commitVault(db, storeName, mutation) {
  mutation = structuredClone(mutation);
  const notes = mutation.notes ?? [];
  const config = mutation.config ?? [];
  const resolution = mutation.resolution;
  if (resolution) {
    if (
      !resolution.id ||
      typeof resolution.fingerprint !== 'string' ||
      !['keep-current', 'save-copy', 'use-draft'].includes(resolution.action) ||
      !Number.isSafeInteger(mutation.sequence) ||
      mutation.replacement
    )
      throw new TypeError('Invalid resolution.');
    if (resolution.action === 'keep-current' && (notes.length || config.length))
      throw new TypeError('Keep-current cannot write notes or settings.');
    if (
      resolution.action === 'save-copy' &&
      (!notes.length || config.length || notes.some((note) => note.expected !== 0 || !note.value))
    )
      throw new TypeError('Copies require new note IDs.');
  }
  validateWrites(notes, 'id');
  validateWrites(config, 'key');
  for (const write of notes) {
    if (write.value !== null && write.value.id !== write.id) throw new TypeError('Invalid note.');
  }
  if (mutation.replacement) {
    if (!Number.isSafeInteger(mutation.sequence)) throw new TypeError('A replacement requires a vault sequence.');
    const ids = mutation.replacement.notes.map((note) => note.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new TypeError('Invalid replacement IDs.');
  }
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  let result;
  const done = transactionResult(tx, () => result);
  const metaRequest = store.get(VAULT_META);
  const configRequest = store.get(VAULT_CONFIG);
  const noteRequests = notes.map((write) => store.get(NOTE_PREFIX + write.id));
  const conflictRequest = resolution ? store.get(CONFLICT_PREFIX + resolution.id) : null;
  const all = [metaRequest, configRequest, ...noteRequests, ...(conflictRequest ? [conflictRequest] : [])];
  let pending = all.length;
  for (const request of all) {
    request.onsuccess = () => {
      if (--pending) return;
      const meta = metaRequest.result;
      const settings = configRequest.result ?? { values: {}, versions: {} };
      const reviewedConflict = conflictRequest?.result;
      if (resolution) {
        if (!reviewedConflict || JSON.stringify(reviewedConflict) !== resolution.fingerprint) {
          result = { status: 'stale', reason: 'conflict_changed', meta };
          return;
        }
        const original = reviewedConflict.mutation;
        if (
          resolution.action === 'use-draft' &&
          (original.generation !== mutation.generation ||
            original.sequence !== undefined ||
            original.replacement ||
            !sameDraft(notes, original.notes) ||
            !sameDraft(config, original.config))
        ) {
          result = { status: 'stale', reason: 'replan_required', meta };
          return;
        }
        if (
          resolution.action === 'save-copy' &&
          notes.some((note) => (original.notes ?? []).some((draft) => draft.id === note.id))
        ) {
          result = { status: 'stale', reason: 'copy_identity', meta };
          return;
        }
      }
      const conflicts = [];
      if (!meta || meta.generation !== mutation.generation) conflicts.push({ kind: 'generation' });
      if (mutation.sequence !== undefined && meta?.sequence !== mutation.sequence) conflicts.push({ kind: 'plan' });
      notes.forEach((write, index) => {
        const current = noteRequests[index].result;
        if ((current?.version ?? 0) !== write.expected) {
          conflicts.push({ kind: 'note', id: write.id, current: current ?? { version: 0, value: null } });
        }
      });
      for (const write of config) {
        if ((Object.hasOwn(settings.versions, write.key) ? settings.versions[write.key] : 0) !== write.expected) {
          conflicts.push({ kind: 'config', key: write.key, current: settings.values[write.key] });
        }
      }
      const apply = () => {
        if (conflicts.length) {
          if (resolution) {
            result = { status: 'stale', reason: 'vault_changed', conflicts, meta };
            return;
          }
          const conflict = { id: mutation.conflictId, mutation, conflicts, detectedAt: mutation.timestamp };
          if (mutation.conflictId) store.put(conflict, CONFLICT_PREFIX + mutation.conflictId);
          result = { status: 'conflict', conflict, meta };
          return;
        }
        if (mutation.replacement) {
          // An exclusive transaction fences every concurrent note/config mutation.
          // Old queued work is invalidated by the newly committed generation.
          const next = mutation.replacement;
          const cursorRequest = store.openCursor(IDBKeyRange.bound(NOTE_PREFIX, `${NOTE_PREFIX}\uffff`));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
              return;
            }
            for (const note of next.notes) store.put({ version: 1, value: note }, NOTE_PREFIX + note.id);
            store.put(
              { values: next.config, versions: Object.fromEntries(Object.keys(next.config).map((key) => [key, 1])) },
              VAULT_CONFIG,
            );
            const nextMeta = {
              generation: crypto.randomUUID(),
              sequence: meta.sequence + 1,
              schemaVersion: next.schemaVersion,
              lastPersistedAt: mutation.timestamp,
            };
            store.put(nextMeta, VAULT_META);
            result = { status: 'committed', meta: nextMeta };
          };
          return;
        }
        const previousConfig = config.map((write) => [
          write.key,
          {
            value: settings.values[write.key],
            present: Object.hasOwn(settings.values, write.key),
            version: Object.hasOwn(settings.versions, write.key) ? settings.versions[write.key] : 0,
          },
        ]);
        for (const write of notes)
          store.put({ version: write.expected + 1, value: write.value }, NOTE_PREFIX + write.id);
        for (const write of config) {
          if (write.remove) delete settings.values[write.key];
          else settings.values = { ...settings.values, [write.key]: write.value };
          settings.versions = { ...settings.versions, [write.key]: write.expected + 1 };
        }
        if (config.length) store.put(settings, VAULT_CONFIG);
        const nextMeta = { ...meta, sequence: meta.sequence + 1, lastPersistedAt: mutation.timestamp };
        if (resolution) {
          // Resolving never erases the last recoverable draft or replaced version.
          // The archive, note/config writes and active-conflict removal commit together.
          store.put(
            {
              conflict: reviewedConflict,
              resolution: {
                action: resolution.action,
                timestamp: mutation.timestamp,
                generation: meta.generation,
                sequence: nextMeta.sequence,
              },
              before: {
                notes: notes.map((write, index) => [write.id, noteRequests[index].result ?? null]),
                config: previousConfig,
              },
            },
            `${RESOLVED_CONFLICT_PREFIX}${resolution.id}:${meta.generation}:${nextMeta.sequence}`,
          );
          store.delete(CONFLICT_PREFIX + resolution.id);
        }
        store.put(nextMeta, VAULT_META);
        result = { status: 'committed', meta: nextMeta };
      };
      if (conflicts.length || mutation.replacement) apply();
      else
        checkIdentity(
          store,
          notes,
          noteRequests.map((request) => request.result),
          conflicts,
          apply,
        );
    };
  }
  return done;
}
