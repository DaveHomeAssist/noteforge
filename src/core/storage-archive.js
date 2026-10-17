import { encodeRecoveryValue } from './recovery-archive-codec.js';

// Open the existing database at its actual version. Never upgrade it for export.
function openExistingDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let settled = false;
    let missing = false;
    const request = indexedDB.open('my-notes-app');
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('Storage archive open timed out. Close other NoteForge windows and retry.'));
    }, 10000);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort();
    };
    request.onblocked = () => {
      clearTimeout(timer);
      settled = true;
      reject(
        new Error('Storage archive is blocked by an open database upgrade. Close other NoteForge windows and retry.'),
      );
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (missing) resolve(null);
      else reject(request.error || new Error('The saved database could not be read.'));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) return request.result.close();
      settled = true;
      resolve(request.result);
    };
  });
}

function readDatabase(db) {
  const names = [...db.objectStoreNames];
  const source = { status: 'read', version: db.version, stores: [] };
  if (!names.length) return Promise.resolve(source);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readonly');
    tx.oncomplete = () => resolve(source);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('The storage archive read was interrupted.'));
    for (const name of names) {
      const store = tx.objectStore(name);
      const saved = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [], entries: [] };
      for (const indexName of store.indexNames) {
        const index = store.index(indexName);
        saved.indexes.push({
          name: index.name,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        });
      }
      source.stores.push(saved);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        saved.entries.push([cursor.key, cursor.value]);
        cursor.continue();
      };
    }
  });
}

export async function createStorageArchive() {
  const db = await openExistingDatabase();
  let indexed;
  try {
    indexed = db
      ? await readDatabase(db)
      : { status: typeof indexedDB === 'undefined' ? 'unavailable' : 'absent', stores: [] };
  } finally {
    db?.close();
  }
  // Other applications on the same origin are outside this archive's authority.
  // These independent backends cannot be read as a single atomic transaction.
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('my-notes-app:')) local[key] = localStorage.getItem(key);
  }
  const source = await encodeRecoveryValue({
    indexedDB: indexed,
    localStorage: local,
  });
  return {
    format: 'noteforge-storage-archive',
    version: 1,
    indexedDBStatus: indexed.status,
    capturedAt: new Date().toISOString(),
    consistency:
      'IndexedDB is one readonly transaction. localStorage is a separate non-atomic capture; close other writers before export.',
    limitations:
      'No portable conversion or automatic restore. Browser key-generator counters are not exposed; schema-compatible recovery must handle future auto-generated keys explicitly.',
    source,
  };
}
