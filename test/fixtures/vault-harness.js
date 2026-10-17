// Browser-side helpers for synthetic storage regressions. Loaded only by
// test/durability.html through Playwright; never part of the application build.
import { Database } from '../../src/core/database.js';
import { storage } from '../../src/core/storage.js';
import { Note } from '../../src/core/note.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/core/migrations.js';

export { Database, storage, Note, CURRENT_SCHEMA_VERSION };

export const LEGACY_KEYS = ['notes', 'config', 'schemaVersion', 'persistenceStatus'];

/** A second connection that never upgrades: the legacy database stays at version 1. */
export function openRaw() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('my-notes-app', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rawGet(keys) {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const values = {};
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result !== undefined) values[key] = request.result;
        };
      }
      tx.oncomplete = () => resolve(values);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function rawPut(entries) {
  const db = await openRaw();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      for (const [key, value] of entries) tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function rawKeys(prefix = '') {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const keys = [];
      const tx = db.transaction('kv', 'readonly');
      const request = tx.objectStore('kv').openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) keys.push(cursor.key);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(keys);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function legacyLocal() {
  return Object.fromEntries(LEGACY_KEYS.map((key) => [key, localStorage.getItem(`my-notes-app:${key}`)]));
}

export function note(id, content, extra = {}) {
  return new Note({
    id,
    title: id,
    content,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  }).toJSON();
}

export async function openVault({ activate = true, backend = storage, onNotesPersisted = async () => {} } = {}) {
  const db = new Database({ storageBackend: backend, onNotesPersisted });
  await db.init({ allowLegacyMigration: activate });
  await db.flush();
  return db;
}

/** Activate a synthetic schema-6 vault through the real legacy upgrade path. */
export async function seededVault(notes = [note('a', 'Original a'), note('b', 'Original b')]) {
  await rawPut([
    ['notes', notes],
    ['config', {}],
    ['schemaVersion', CURRENT_SCHEMA_VERSION],
  ]);
  return openVault();
}

export async function save(db, id, content) {
  const current = db.getNote(id);
  current.update({ content });
  return db.saveNoteWithReceipt(current).completion;
}

/** Record every IndexedDB and localStorage write the page performs from now on. */
export function instrumentWrites() {
  const log = [];
  const record = (backend, op, key, target = {}) => log.push({ backend, op, key: String(key), ...target });
  const idb = (store) => ({ database: store.transaction.db.name, store: store.name });
  for (const op of ['put', 'add']) {
    const original = IDBObjectStore.prototype[op];
    IDBObjectStore.prototype[op] = function (value, key) {
      record('indexeddb', op, key ?? '(inline)', idb(this));
      return original.call(this, value, key);
    };
  }
  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    record('indexeddb', 'delete', key instanceof IDBKeyRange ? `${key.lower}..${key.upper}` : key, idb(this));
    return remove.call(this, key);
  };
  const clear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function () {
    record('indexeddb', 'clear', '*', idb(this));
    return clear.call(this);
  };
  for (const op of ['update', 'delete']) {
    const original = IDBCursor.prototype[op];
    IDBCursor.prototype[op] = function (...args) {
      record('indexeddb', `cursor-${op}`, this.primaryKey, idb(this.source));
      return original.apply(this, args);
    };
  }
  const deleteDatabase = IDBFactory.prototype.deleteDatabase;
  IDBFactory.prototype.deleteDatabase = function (name) {
    record('indexeddb', 'deleteDatabase', name);
    return deleteDatabase.call(this, name);
  };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name, version) {
    if (version !== undefined && version !== 1) record('indexeddb', 'open-version', `${name}@${version}`);
    return open.call(this, name, version);
  };
  for (const op of ['setItem', 'removeItem']) {
    const original = Storage.prototype[op];
    Storage.prototype[op] = function (key, ...args) {
      if (this === localStorage) record('localstorage', op, key);
      return original.call(this, key, ...args);
    };
  }
  const clearLocal = Storage.prototype.clear;
  Storage.prototype.clear = function () {
    if (this === localStorage) record('localstorage', 'clear', '*');
    return clearLocal.call(this);
  };
  return log;
}

/** Writes that would touch the legacy current-state sources in either backend. */
export function legacyWrites(log) {
  return log.filter(
    (entry) =>
      ['deleteDatabase', 'open-version', 'clear'].includes(entry.op) ||
      (entry.backend === 'indexeddb' && entry.database === 'my-notes-app' && LEGACY_KEYS.includes(entry.key)) ||
      (entry.backend === 'localstorage' && LEGACY_KEYS.map((key) => `my-notes-app:${key}`).includes(entry.key)),
  );
}

let legacyClients = 0;

/** A fresh instance of the exact 7114047 storage module, as an old open tab holds it.
 * `indexedDB: false` makes this one client's database open fail, so it writes the
 * localStorage fallback exactly as 7114047 does after an open failure. */
export async function legacyClient({ indexedDB: useIndexedDB = true } = {}) {
  const url = new URL('./legacy/storage-7114047.js', import.meta.url);
  url.searchParams.set('client', String(++legacyClients));
  const { storage: legacy } = await import(/* @vite-ignore */ url.href);
  if (!useIndexedDB) {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = () => {
      throw new DOMException('Simulated open failure', 'UnknownError');
    };
    try {
      if (await legacy.ready()) throw new Error('legacy client unexpectedly opened IndexedDB');
    } finally {
      IDBFactory.prototype.open = open;
    }
  } else if (!(await legacy.ready())) throw new Error('legacy client could not open IndexedDB');
  return {
    storage: legacy,
    /** The 7114047 Database persists the whole array, then its timestamp. */
    async saveNotes(notes) {
      const saved = await legacy.save('notes', notes);
      await legacy.save('persistenceStatus', { lastPersistedAt: new Date().toISOString() });
      return saved;
    },
    loadNotes: () => legacy.load('notes', []),
  };
}

export async function activeConflicts(db) {
  return (await db.storage.readCurrentVault()).conflicts;
}
