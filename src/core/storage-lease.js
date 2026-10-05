// Optional revision coordination when Web Locks are unavailable.
const STORE = 'kv';
const LOCK_PREFIX = '__internal_lock__:';
const LEASE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

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

/** @returns {Promise<void>} */
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

export async function withDurableLease(db, name, operation) {
  const key = `${LOCK_PREFIX}${name}`;
  const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await idbTryAcquireLease(db, key, owner))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${name} storage lock`);
    await lockDelay(25 + Math.floor(Math.random() * 25));
  }

  let leaseLost = false;
  const renewal = setInterval(
    () => {
      void idbRenewLease(db, key, owner)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    },
    Math.floor(LEASE_MS / 3),
  );
  try {
    const result = await operation();
    if (leaseLost) throw new Error(`Lost the ${name} storage lock before the operation completed`);
    return result;
  } finally {
    clearInterval(renewal);
    await idbReleaseLease(db, key, owner).catch(() => {});
  }
}
