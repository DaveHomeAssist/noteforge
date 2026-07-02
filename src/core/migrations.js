// Pure schema versioning for the persisted payload. Kept free of any storage /
// DOM dependency so it can be unit-tested in Node and reasoned about in
// isolation. The Database loads the raw records, runs them forward to
// CURRENT_SCHEMA_VERSION, and persists the result plus the new version.
//
// A "payload" is the combined, storable app state:
//   { notes: Array<noteJSON>, config: object }
//
// Each entry in MIGRATIONS[v] upgrades a payload from version v-1 to v. Add a
// new numbered function whenever the on-disk shape changes; never edit an old
// one (users may still be on that version).

export const CURRENT_SCHEMA_VERSION = 3;

const MIGRATIONS = {
  // v0 -> v1: introduce soft-delete. Every note gains an explicit `deletedAt`
  // (null = live). Older exports simply lacked the field.
  1: (payload) => {
    const notes = Array.isArray(payload.notes)
      ? payload.notes.map((n) => ({ ...n, deletedAt: n && n.deletedAt != null ? n.deletedAt : null }))
      : payload.notes;
    return { ...payload, notes };
  },
  // v1 -> v2: introduce pinning. Every note gains an explicit `pinned` flag.
  2: (payload) => {
    const notes = Array.isArray(payload.notes)
      ? payload.notes.map((n) => ({ ...n, pinned: !!(n && n.pinned) }))
      : payload.notes;
    return { ...payload, notes };
  },
  // v2 -> v3: introduce the outline tree. Every note gains an explicit `parentId`.
  3: (payload) => {
    const notes = Array.isArray(payload.notes)
      ? payload.notes.map((n) => ({ ...n, parentId: n && typeof n.parentId === 'string' ? n.parentId : null }))
      : payload.notes;
    return { ...payload, notes };
  },
};

/**
 * Detect the schema version of an already-loaded payload. Used only when no
 * explicit version record exists (legacy data): version 0.
 */
export function detectVersion(storedVersion) {
  return Number.isInteger(storedVersion) && storedVersion >= 0 ? storedVersion : 0;
}

/**
 * Run `payload` forward from `fromVersion` to CURRENT_SCHEMA_VERSION.
 * @returns {{ data: object, version: number, migrated: boolean }}
 */
export function runMigrations(payload, fromVersion) {
  let data = payload || {};
  let v = detectVersion(fromVersion);
  const start = v;
  while (v < CURRENT_SCHEMA_VERSION) {
    v += 1;
    const step = MIGRATIONS[v];
    if (step) data = step(data);
  }
  return { data, version: CURRENT_SCHEMA_VERSION, migrated: v !== start };
}
