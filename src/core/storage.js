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

const NS = 'my-notes-app:'; // legacy localStorage namespace (migration source)
const DB_NAME = 'my-notes-app';
const STORE = 'kv';
const DB_VERSION = 1;

// --- IndexedDB plumbing -----------------------------------------------------

let dbPromise; // memoized Promise<IDBDatabase | null>

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

function legacyRemove(key) {
  try {
    localStorage.removeItem(NS + key);
  } catch { /* ignore */ }
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
      if (value !== undefined) return value;
      // Not in IndexedDB yet — migrate a legacy localStorage entry if present.
      const legacy = legacyLoad(key, undefined);
      if (legacy !== undefined) {
        try { await idbSet(db, key, legacy); } catch { /* best-effort */ }
        return legacy;
      }
      return fallback;
    } catch (err) {
      console.warn(`[storage] IndexedDB load "${key}" failed, using localStorage:`, err);
      return legacyLoad(key, fallback);
    }
  },

  async save(key, value) {
    const db = await openDB();
    if (!db) return legacySave(key, value);
    try {
      await idbSet(db, key, value);
      return true;
    } catch (err) {
      console.error(`[storage] IndexedDB save "${key}" failed, using localStorage:`, err);
      return legacySave(key, value);
    }
  },

  async remove(key) {
    const db = await openDB();
    if (db) {
      try { await idbDel(db, key); } catch { /* ignore */ }
    }
    legacyRemove(key); // drop the legacy copy too so it can't resurrect on reload
  },
};
