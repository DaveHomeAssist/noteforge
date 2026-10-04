// Current-note commits use IndexedDB's transaction isolation, not window-local
// queues or advisory locks. No asynchronous computation runs inside a transaction.
export const VAULT_META = 'vault:meta';
export const VAULT_CONFIG = 'vault:config';
export const NOTE_PREFIX = 'note:';
export const CONFLICT_PREFIX = 'vault:conflict:';
export const RESOLVED_CONFLICT_PREFIX = 'vault:resolved-conflict:';

function sameDraft(left = [], right = []) {
  const withoutVersions = (writes) => JSON.stringify(writes.map((write) => ({ ...write, expected: 0 })));
  return withoutVersions(left) === withoutVersions(right);
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
/** @typedef {{id:string, expected:number, value:RawNote|null}} NoteWrite */
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
  const persistence = store.get('persistenceStatus');
  meta.onsuccess = () => {
    snapshot.meta = meta.result ?? null;
  };
  config.onsuccess = () => {
    snapshot.config = config.result ?? null;
  };
  persistence.onsuccess = () => {
    snapshot.persistence = persistence.result ?? null;
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

/** Initialize records atomically from a caller-verified legacy snapshot.
 * This is a mechanism, not authorization to activate migration for old clients.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {{notes:RawNote[],config:object,schemaVersion:number}} legacy
 * @param {{notes:RawNote[],config:object,schemaVersion:number}} migrated
 * @param {string} generation
 */
export function initializeVault(db, storeName, legacy, migrated, generation) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  let result = { status: 'stale' };
  const done = transactionResult(tx, () => result);
  const requests = ['notes', 'config', 'schemaVersion', VAULT_META].map((key) => store.get(key));
  let pending = requests.length;
  for (const request of requests) {
    request.onsuccess = () => {
      if (--pending) return;
      if (requests[3].result) {
        result = { status: 'existing' };
        return;
      }
      const current = {
        notes: requests[0].result ?? [],
        config: requests[1].result ?? {},
        schemaVersion: requests[2].result ?? 0,
      };
      if (JSON.stringify(current) !== JSON.stringify(legacy)) return;
      // Retain exact legacy bytes/metadata. All records and the activation marker
      // either commit together or remain absent after an abort/restart.
      store.put(legacy, 'vault:legacy-backup');
      for (const note of migrated.notes) store.put({ version: 1, value: note }, NOTE_PREFIX + note.id);
      store.put(
        { values: migrated.config, versions: Object.fromEntries(Object.keys(migrated.config).map((key) => [key, 1])) },
        VAULT_CONFIG,
      );
      store.put({ generation, sequence: 0, schemaVersion: migrated.schemaVersion }, VAULT_META);
      result = { status: 'committed' };
    };
  }
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
        if (mutation.sequence === undefined) {
          tx.abort();
          return;
        }
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
          };
          store.put(nextMeta, VAULT_META);
          store.put({ lastPersistedAt: mutation.timestamp }, 'persistenceStatus');
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
      for (const write of notes) store.put({ version: write.expected + 1, value: write.value }, NOTE_PREFIX + write.id);
      for (const write of config) {
        if (write.remove) delete settings.values[write.key];
        else settings.values = { ...settings.values, [write.key]: write.value };
        settings.versions = { ...settings.versions, [write.key]: write.expected + 1 };
      }
      if (config.length) store.put(settings, VAULT_CONFIG);
      const nextMeta = { ...meta, sequence: meta.sequence + 1 };
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
      store.put({ lastPersistedAt: mutation.timestamp }, 'persistenceStatus');
      result = { status: 'committed', meta: nextMeta };
    };
  }
  return done;
}
