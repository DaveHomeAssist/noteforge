// Async, namespaced persistence. IndexedDB is the primary backend (async,
// hundreds of MB, blob-friendly) so a growing vault and image banners no longer
// hit the ~5 MB localStorage cap. The public surface is a tiny promise-based
// key/value store; the rest of the app treats it as an opaque backend.
//
// - First read of a key that isn't in IndexedDB but *is* in the legacy
//   localStorage namespace is migrated in-place (one time, lazily) so existing
//   users keep their notes with no manual step.
// - If IndexedDB is unavailable (private mode, ancient browser), we transparently
//   fall back to the old localStorage backend behind the same async API.

// NOTE: these storage keys are deliberately kept as 'my-notes-app' even though the
// app is now branded "NoteForge" — renaming them would point at a fresh, empty
// IndexedDB and orphan every existing user's notes. The display name is cosmetic;
// the storage identity must stay stable.
const NS = 'my-notes-app:'; // legacy localStorage namespace (migration source)
const DB_NAME = 'my-notes-app';
const STORE = 'kv';
const DB_VERSION = 1;
const LOCK_PREFIX = '__internal_lock__:';
const LEASE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

// --- IndexedDB plumbing -----------------------------------------------------

let dbPromise; // memoized Promise<IDBDatabase | null>
let lastBackendError = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let idb;
    try {
      idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
    } catch {
      idb = null; // some sandboxes throw on mere access
    }
    if (!idb) return resolve(null);
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[storage] IndexedDB unavailable, using localStorage:', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function idbRequest(db, mode, run) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      return reject(err);
    }
    const store = tx.objectStore(STORE);
    let result;
    const req = run(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

const idbGet = (db, key) => idbRequest(db, 'readonly', (s) => s.get(key));
const idbSet = (db, key, value) => idbRequest(db, 'readwrite', (s) => s.put(value, key));
const idbDel = (db, key) => idbRequest(db, 'readwrite', (s) => s.delete(key));

function idbLoadMany(db, keys) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(STORE);
    const values = new Array(keys.length);
    keys.forEach((key, index) => {
      const req = store.get(key);
      req.onsuccess = () => { values[index] = req.result; };
    });
    tx.oncomplete = () => resolve(values);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

function idbSaveMany(db, entries) {
  return idbRequest(db, 'readwrite', (store) => {
    for (const [key, value] of entries) store.put(value, key);
  });
}

function idbRemoveMany(db, keys) {
  return idbRequest(db, 'readwrite', (store) => {
    for (const key of keys) store.delete(key);
  });
}

function idbKeys(db, prefix) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(STORE);
    const keys = [];
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) keys.push(cursor.key);
      cursor.continue();
    };
    tx.oncomplete = () => resolve(keys.sort());
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

function idbTryAcquireLease(db, key, owner) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let acquired = false;
    const request = store.get(key);
    request.onsuccess = () => {
      const current = request.result;
      const now = Date.now();
      if (!current || current.owner === owner || !Number.isFinite(current.expiresAt) || current.expiresAt <= now) {
        store.put({ owner, expiresAt: now + LEASE_MS }, key);
        acquired = true;
      }
    };
    tx.oncomplete = () => resolve(acquired);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB lock transaction failed'));
  });
}

function idbRenewLease(db, key, owner) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let renewed = false;
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.owner === owner) {
        store.put({ owner, expiresAt: Date.now() + LEASE_MS }, key);
        renewed = true;
      }
    };
    tx.oncomplete = () => resolve(renewed);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB lock renewal failed'));
  });
}

function idbReleaseLease(db, key, owner) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.owner === owner) store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB lock release failed'));
  });
}

const lockDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withDurableLease(db, name, operation) {
  const key = `${LOCK_PREFIX}${name}`;
  const owner = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!await idbTryAcquireLease(db, key, owner)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${name} storage lock`);
    await lockDelay(25 + Math.floor(Math.random() * 25));
  }

  let leaseLost = false;
  const renewal = setInterval(() => {
    void idbRenewLease(db, key, owner)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, Math.floor(LEASE_MS / 3));
  try {
    const result = await operation();
    if (leaseLost) throw new Error(`Lost the ${name} storage lock before the operation completed`);
    return result;
  } finally {
    clearInterval(renewal);
    await idbReleaseLease(db, key, owner).catch(() => {});
  }
}

// --- localStorage fallback / migration source -------------------------------

function legacyLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] failed to load "${key}" from localStorage:`, err);
    return fallback;
  }
}

function legacySave(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`[storage] failed to save "${key}" to localStorage:`, err);
    return false;
  }
}

function legacySaveMany(entries) {
  const batch = [...new Map(entries).entries()];
  const serialized = new Map();
  const previous = new Map();
  try {
    for (const [key, value] of batch) {
      serialized.set(key, JSON.stringify(value));
      previous.set(key, localStorage.getItem(NS + key));
    }
    for (const [key] of batch) localStorage.setItem(NS + key, serialized.get(key));
    return true;
  } catch (err) {
    // localStorage has no transactions. Restore every touched raw value so a
    // quota failure cannot leave a half-applied vault replacement on reload.
    // Clear the attempted batch first: the complete previous batch fit before
    // this write, while restoring a large old value beside a large new value may not.
    for (const [key] of previous) {
      try { localStorage.removeItem(NS + key); } catch { /* continue best-effort rollback */ }
    }
    for (const [key, raw] of previous) {
      try {
        if (raw !== null) localStorage.setItem(NS + key, raw);
      } catch { /* the caller receives false and keeps the in-memory vault */ }
    }
    console.error('[storage] failed to save localStorage batch; previous values restored:', err);
    return false;
  }
}

function legacyRemove(key) {
  try {
    localStorage.removeItem(NS + key);
  } catch { /* ignore */ }
}

function legacyKeys(prefix = '') {
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const storedKey = localStorage.key(index);
      if (!storedKey?.startsWith(NS)) continue;
      const key = storedKey.slice(NS.length);
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys.sort();
  } catch {
    return [];
  }
}

function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && Number.isInteger(localStorage.length);
  } catch {
    return false;
  }
}

function normalizeEntries(entries) {
  if (entries instanceof Map) return [...entries.entries()];
  if (Array.isArray(entries)) {
    return entries.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('Batch entries must be [key, value] pairs');
      return entry;
    });
  }
  if (entries && typeof entries === 'object') return Object.entries(entries);
  throw new TypeError('Batch entries must be a Map, object, or array of [key, value] pairs');
}

async function quotaEstimate() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') return null;
    const estimate = await navigator.storage.estimate();
    return {
      usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
      quota: Number.isFinite(estimate.quota) ? estimate.quota : null,
    };
  } catch {
    return null;
  }
}

// --- public API -------------------------------------------------------------

export const storage = {
  /** Warm up the backend. Resolves true if IndexedDB is in use, false otherwise. */
  async ready() {
    return (await openDB()) != null;
  },

  /**
   * Read a stored value. Falls back to (and lazily migrates) a legacy
   * localStorage entry the first time a key is missing from IndexedDB.
   */
  async load(key, fallback = null) {
    const db = await openDB();
    if (!db) return legacyLoad(key, fallback);
    try {
      const value = await idbGet(db, key);
      lastBackendError = null;
      if (value !== undefined) return value;
      // Not in IndexedDB yet — migrate a legacy localStorage entry if present.
      const legacy = legacyLoad(key, undefined);
      if (legacy !== undefined) {
        try { await idbSet(db, key, legacy); } catch { /* best-effort */ }
        return legacy;
      }
      return fallback;
    } catch (err) {
      lastBackendError = err;
      console.error(`[storage] IndexedDB load "${key}" failed; refusing stale localStorage fallback:`, err);
      throw err;
    }
  },

  async save(key, value) {
    const db = await openDB();
    if (!db) return legacySave(key, value);
    try {
      await idbSet(db, key, value);
      lastBackendError = null;
      return true;
    } catch (err) {
      lastBackendError = err;
      console.error(`[storage] IndexedDB save "${key}" failed; authoritative write remains pending:`, err);
      return false;
    }
  },

  async remove(key) {
    const db = await openDB();
    if (db) {
      try {
        await idbDel(db, key);
        lastBackendError = null;
      } catch { /* ignore */ }
    }
    legacyRemove(key); // drop the legacy copy too so it can't resurrect on reload
  },

  /** Enumerate logical keys without exposing the legacy localStorage prefix. */
  async keys(prefix = '') {
    const normalizedPrefix = String(prefix);
    const legacy = legacyKeys(normalizedPrefix);
    const db = await openDB();
    if (!db) return legacy;
    try {
      const indexed = await idbKeys(db, normalizedPrefix);
      lastBackendError = null;
      return [...new Set([...indexed, ...legacy])].sort();
    } catch (err) {
      lastBackendError = err;
      console.error('[storage] IndexedDB key enumeration failed; refusing stale localStorage fallback:', err);
      throw err;
    }
  },

  /** Read a consistent IndexedDB snapshot. Results align with the input keys. */
  async loadMany(keys, fallback = null) {
    const requested = [...keys];
    const db = await openDB();
    if (!db) return requested.map((key) => legacyLoad(key, fallback));
    try {
      const values = await idbLoadMany(db, requested);
      lastBackendError = null;
      return Promise.all(values.map(async (value, index) => {
        if (value !== undefined) return value;
        const legacy = legacyLoad(requested[index], undefined);
        if (legacy === undefined) return fallback;
        try { await idbSet(db, requested[index], legacy); } catch { /* best-effort lazy migration */ }
        return legacy;
      }));
    } catch (err) {
      lastBackendError = err;
      console.error('[storage] IndexedDB batch read failed; refusing stale localStorage fallback:', err);
      throw err;
    }
  },

  /**
   * Atomically write entries in IndexedDB. Existing fallback semantics remain
   * the default; callers that require IndexedDB durability can disable them.
   */
  async saveMany(entries, { allowFallback = true } = {}) {
    const batch = normalizeEntries(entries);
    if (batch.length === 0) return true;
    const db = await openDB();
    if (!db) {
      if (!allowFallback) return false;
      return legacySaveMany(batch);
    }
    try {
      await idbSaveMany(db, batch);
      lastBackendError = null;
      return true;
    } catch (err) {
      lastBackendError = err;
      console.error('[storage] IndexedDB batch write failed:', err);
      // Once IndexedDB has opened, writing only to localStorage would create a
      // split brain because future reads correctly prefer the existing IDB value.
      return false;
    }
  },

  /** Remove keys in one IndexedDB transaction and prevent legacy resurrection. */
  async removeMany(keys) {
    const requested = [...keys];
    if (requested.length === 0) return true;
    const db = await openDB();
    let removed = true;
    if (db) {
      try {
        await idbRemoveMany(db, requested);
        lastBackendError = null;
      } catch (err) {
        lastBackendError = err;
        removed = false;
      }
    }
    requested.forEach(legacyRemove);
    return removed;
  },

  /** Serialize a revision mutation across every same-origin tab/window. */
  async withLock(name, operation) {
    if (typeof operation !== 'function') throw new TypeError('Storage lock operation must be a function');
    const lockName = `noteforge:${DB_NAME}:${String(name)}`;
    let locks = null;
    try { locks = typeof navigator !== 'undefined' ? navigator.locks : null; } catch { /* unavailable */ }
    if (typeof locks?.request === 'function') {
      return locks.request(lockName, { mode: 'exclusive' }, operation);
    }
    const db = await openDB();
    if (!db) return operation(); // revision callers will fail closed as unavailable
    return withDurableLease(db, lockName, operation);
  },

  /** Report backend and optional-history capabilities for storage-health UI. */
  async getStatus() {
    const db = await openDB();
    const fallbackAvailable = hasLocalStorage();
    const backend = db ? 'indexeddb' : (fallbackAvailable ? 'localstorage' : 'unavailable');
    return {
      backend,
      ready: Boolean(db || fallbackAvailable),
      degraded: !db || Boolean(lastBackendError),
      reason: db ? (lastBackendError ? 'indexeddb_error' : null) : 'indexeddb_unavailable',
      historyAvailable: Boolean(db),
      localSnapshotsAvailable: Boolean(db),
      lastError: lastBackendError ? String(lastBackendError.message || lastBackendError) : null,
      capabilities: {
        keyEnumeration: true,
        batchReads: true,
        batchWrites: true,
        batchRemoves: true,
        atomicBatch: Boolean(db),
        originLock: Boolean(db),
        revisionHistory: Boolean(db),
        localSnapshots: Boolean(db),
      },
      quota: await quotaEstimate(),
    };
  },

  /** Backward-friendly alias for callers that prefer a concise status method. */
  async status() {
    return storage.getStatus();
  },
};
