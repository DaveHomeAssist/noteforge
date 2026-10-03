// Current-note commits use IndexedDB's transaction isolation, not window-local
// queues or advisory locks. No asynchronous computation runs inside a transaction.
export const VAULT_META = 'vault:meta';
export const VAULT_CONFIG = 'vault:config';
export const NOTE_PREFIX = 'note:';
export const CONFLICT_PREFIX = 'vault:conflict:';

/** @typedef {{id:string, [key:string]:unknown}} RawNote */
/** @typedef {{version:number, value:RawNote|null}} RecordValue */
/** @typedef {{id:string, expected:number, value:RawNote|null}} NoteWrite */
/** @typedef {{key:string, expected:number, value:unknown, remove?:boolean}} ConfigWrite */
/** @typedef {{generation:string, sequence?:number, notes?:NoteWrite[], config?:ConfigWrite[],
 * conflictId?:string, timestamp:string, replacement?:{notes:RawNote[], config:object, schemaVersion:number}}} Mutation */

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
  const notes = mutation.notes ?? [];
  const config = mutation.config ?? [];
  if (new Set(notes.map((write) => write.id)).size !== notes.length) throw new TypeError('Duplicate note mutation.');
  if (new Set(config.map((write) => write.key)).size !== config.length)
    throw new TypeError('Duplicate setting mutation.');
  for (const write of notes) {
    if (
      !write.id ||
      !Number.isSafeInteger(write.expected) ||
      write.expected < 0 ||
      (write.value !== null && write.value.id !== write.id)
    )
      throw new TypeError('Invalid note mutation.');
  }
  for (const write of config) {
    if (!write.key || !Number.isSafeInteger(write.expected) || write.expected < 0)
      throw new TypeError('Invalid setting mutation.');
  }
  if (mutation.replacement) {
    const ids = mutation.replacement.notes.map((note) => note.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
      throw new TypeError('Invalid replacement identities.');
  }
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  let result;
  const done = transactionResult(tx, () => result);
  const metaRequest = store.get(VAULT_META);
  const configRequest = store.get(VAULT_CONFIG);
  const noteRequests = notes.map((write) => store.get(NOTE_PREFIX + write.id));
  const all = [metaRequest, configRequest, ...noteRequests];
  let pending = all.length;
  for (const request of all) {
    request.onsuccess = () => {
      if (--pending) return;
      const meta = metaRequest.result;
      const settings = configRequest.result ?? { values: {}, versions: {} };
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
      for (const write of notes) store.put({ version: write.expected + 1, value: write.value }, NOTE_PREFIX + write.id);
      for (const write of config) {
        if (write.remove) delete settings.values[write.key];
        else
          Object.defineProperty(settings.values, write.key, {
            value: write.value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        Object.defineProperty(settings.versions, write.key, {
          value: write.expected + 1,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      if (config.length) store.put(settings, VAULT_CONFIG);
      const nextMeta = { ...meta, sequence: meta.sequence + 1 };
      store.put(nextMeta, VAULT_META);
      store.put({ lastPersistedAt: mutation.timestamp }, 'persistenceStatus');
      result = { status: 'committed', meta: nextMeta };
    };
  }
  return done;
}
