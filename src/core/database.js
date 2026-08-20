// In-memory note store backed by an async, versioned persistence layer, with a
// tiny pub/sub so UI components can react to changes instead of manually
// calling refresh().
//
// Reads are synchronous off the in-memory Map (snappy UI); writes are persisted
// through a coalescing, serialized queue so keystroke-rate saves never race or
// block the editor. Derived data (tag counts, wikilink graph, backlinks) is
// computed on read from note content — never stored — so it can't drift.
//
// Soft-delete: deleteNote() moves a note to the Trash (sets deletedAt); it stays
// persisted (so it survives reload) but is excluded from every "live" query.

import { Note, normalizeAliases } from './note.js';
import { storage } from './storage.js';
import { runMigrations, CURRENT_SCHEMA_VERSION } from './migrations.js';
import { isDescendant, ancestorChain } from '../utils/tree.js';
import { normalizeTitle } from '../utils/helpers.js';

const NOTES_KEY = 'notes';
const CONFIG_KEY = 'config';
const SCHEMA_KEY = 'schemaVersion';
const PERSISTENCE_KEY = 'persistenceStatus';

function jsonEquivalent(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEquivalent(left[key], right[key]));
}

export class Database {
  constructor({ storageBackend = storage, onNotesPersisted = null, onNotesPurged = null } = {}) {
    this.storage = storageBackend;
    this.notes = new Map(); // id -> Note (both live and trashed)
    // Default config is available synchronously; init() overlays the stored one.
    // No `theme` default here — a fresh install must fall through to the settings
    // default (themeMode: 'system'); a legacy stored `theme` still wins for upgrades.
    this.config = { showGraph: false };
    this.listeners = new Set();
    this.ready = false;
    this._writeQueue = new Map(); // key -> latest value (coalesced)
    this._draining = null; // the single in-flight drain promise, or null
    this._vaultReplacing = false;
    this._historyTasks = new Set(); // optional post-commit revision captures
    this._pendingHistoryCaptures = [];
    this._pendingHistoryPurges = new Set();
    this.lastPersistedAt = null;
    this.lastRevisionAt = null;
    this._identitySignatures = new Map();
    this._titleIndex = new Map();
    this._aliasIndex = new Map();
    this._knowledgeIndex = null;
    this._knowledgeReady = null;
    this.onPersistError = null; // optional (key) => void hook for the UI
    this.onNotesPersisted = onNotesPersisted; // optional async ({ note, reason }[]) => void
    this.onNotesPurged = onNotesPurged; // optional async (noteIds[]) => void
    this.onHistoryError = null; // optional (error) => void hook for degraded recovery
  }

  // --- events -------------------------------------------------------------

  /** Subscribe to store changes. Returns an unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this);
  }

  // --- lifecycle / persistence -------------------------------------------

  /**
   * Load and migrate persisted state into memory. Call once at startup and
   * await it before rendering. Safe to call again to reload.
   */
  async init() {
    const storedVersion = await this.storage.load(SCHEMA_KEY, undefined);
    const rawNotes = await this.storage.load(NOTES_KEY, []);
    const rawConfig = await this.storage.load(CONFIG_KEY, {});
    const storedPersistence = await this.storage.load(PERSISTENCE_KEY, {});

    const { data, version, migrated } = runMigrations(
      { notes: Array.isArray(rawNotes) ? rawNotes : [], config: rawConfig || {} },
      storedVersion
    );

    this.notes.clear();
    for (const nd of data.notes || []) {
      const note = Note.fromJSON(nd);
      this.notes.set(note.id, note);
    }
    this.config = { showGraph: false, ...(data.config || {}) };
    this.lastPersistedAt = typeof storedPersistence?.lastPersistedAt === 'string'
      && Number.isFinite(Date.parse(storedPersistence.lastPersistedAt))
      ? storedPersistence.lastPersistedAt
      : null;
    this.#rebuildResolutionIndexes();

    // Persist the upgrade exactly once (and stamp the version), avoiding a
    // needless write for users already on the current schema.
    if (migrated || storedVersion !== version) {
      this.#persist();
      this.#queueWrite(CONFIG_KEY, this.config);
      this.#queueWrite(SCHEMA_KEY, version);
    }

    this.ready = true;
    this.#emit();
    return this;
  }

  #rawNotes() {
    return Array.from(this.notes.values());
  }

  #persist(captures = [], purgedIds = []) {
    // Persist the full set (live + trashed) so the Trash survives reload.
    this.#queueWrite(
      NOTES_KEY,
      this.#rawNotes().map((n) => n.toJSON()),
      null,
      { captures, purgedIds },
    );
  }

  #queueWrite(key, value, afterPersist = null, noteCommit = null) {
    // Keep the callback with the exact snapshot it describes. If another write
    // arrives while this one is in flight, the newer entry remains queued and
    // receives its own post-commit callback.
    let mergedCommit = noteCommit;
    const previous = this._writeQueue.get(key);
    if (key === NOTES_KEY && noteCommit) {
      // Carry metadata even from an in-flight entry. If that write succeeds,
      // revision capture and purge cleanup are idempotent; if it fails, the
      // successor is the only durable commit that can safely run the work.
      const pending = previous?.noteCommit || null;
      const liveIds = new Set(value.map((note) => note.id));
      const capturesById = new Map();
      for (const capture of [...(pending?.captures || []), ...(noteCommit.captures || [])]) {
        if (liveIds.has(capture.note?.id)) capturesById.set(capture.note.id, capture);
      }
      const purgedIds = [...new Set([...(pending?.purgedIds || []), ...(noteCommit.purgedIds || [])])]
        .filter((id) => !liveIds.has(id));
      mergedCommit = { captures: [...capturesById.values()], purgedIds };
    }
    this._writeQueue.set(key, { value, afterPersist, noteCommit: mergedCommit, inFlight: false }); // latest queued snapshot wins
    if (!this._vaultReplacing) void this.#flushWrites();
  }

  #flushWrites() {
    // A single shared drain: concurrent callers (incl. flush()) get the SAME
    // in-flight promise, so awaiting it actually waits for pending writes to
    // commit instead of returning early while a write is still in flight.
    if (this._draining) return this._draining;
    if (this._vaultReplacing) return null;
    if (this._writeQueue.size === 0) return null;
    let failed = false;
    let draining;
    // Start on the next microtask so `this._draining` is assigned before even
    // an empty/synchronous path can settle and run its finalizer.
    draining = Promise.resolve().then(async () => {
      while (this._writeQueue.size) {
        const [key, entry] = this._writeQueue.entries().next().value;
        entry.inFlight = true;
        let okSave = false;
        try {
          okSave = await this.storage.save(key, entry.value);
        } catch (error) {
          console.error(`[database] storage threw while persisting "${key}":`, error);
        }
        if (okSave) {
          if (key === NOTES_KEY) {
            this.lastPersistedAt = new Date().toISOString();
            this.#queueWrite(PERSISTENCE_KEY, { lastPersistedAt: this.lastPersistedAt });
          }
          // Delete only if a newer snapshot for this key wasn't queued while
          // we awaited — otherwise loop again and persist the newer value.
          if (this._writeQueue.get(key) === entry) this._writeQueue.delete(key);
          entry.afterPersist?.();
          if (entry.noteCommit) {
            if (entry.noteCommit.captures.length) this.#capturePersistedNotes(entry.noteCommit.captures);
            if (entry.noteCommit.purgedIds.length) this.#removePurgedHistory(entry.noteCommit.purgedIds);
          }
        } else {
          // Persist failed on every backend (e.g. IndexedDB error AND
          // localStorage over quota). Never silently drop it: keep the
          // snapshot queued, surface the failure, and stop this drain to
          // avoid a hot spin. The in-memory Map is still the source of truth
          // for the session, and the next save (or flush) retries.
          this.#reportPersistError(key);
          entry.inFlight = false;
          failed = true;
          break;
        }
      }
    }).finally(() => {
      if (this._draining === draining) this._draining = null;
      // A write can be queued after the loop observes an empty Map but before
      // this promise settles. Hand it to a successor drain so it cannot remain
      // stranded until an unrelated future edit. Do not hot-retry a failure.
      if (!failed && this._writeQueue.size) void this.#flushWrites();
    });
    this._draining = draining;
    return draining;
  }

  #capturePersistedNotes(captures) {
    if (typeof this.onNotesPersisted !== 'function') {
      this._pendingHistoryCaptures.push(...captures);
      return;
    }
    // History is optional and runs after the authoritative note snapshot has
    // committed. It never holds up a newer current-note write.
    const task = Promise.resolve()
      .then(() => this.onNotesPersisted(captures))
      .then(() => { this.lastRevisionAt = new Date().toISOString(); })
      .catch((err) => {
        console.warn('[database] note persisted, but revision capture failed:', err);
        try { this.onHistoryError?.(err); } catch { /* ignore hook errors */ }
      })
      .finally(() => this._historyTasks.delete(task));
    this._historyTasks.add(task);
  }

  #removePurgedHistory(noteIds) {
    if (typeof this.onNotesPurged !== 'function') {
      noteIds.forEach((id) => this._pendingHistoryPurges.add(id));
      this._pendingHistoryCaptures = this._pendingHistoryCaptures.filter((capture) => !this._pendingHistoryPurges.has(capture.note?.id));
      return;
    }
    const task = Promise.resolve()
      .then(() => this.onNotesPurged([...noteIds]))
      .catch((err) => {
        console.warn('[database] note purge persisted, but revision cleanup failed:', err);
        try { this.onHistoryError?.(err); } catch { /* ignore hook errors */ }
      })
      .finally(() => this._historyTasks.delete(task));
    this._historyTasks.add(task);
  }

  /** Attach optional recovery handlers and drain post-commit work buffered while lazy modules loaded. */
  async connectHistoryHandlers({ onNotesPersisted, onNotesPurged }) {
    this.onNotesPersisted = onNotesPersisted;
    this.onNotesPurged = onNotesPurged;
    const captures = this._pendingHistoryCaptures;
    const purgedIds = [...this._pendingHistoryPurges];
    this._pendingHistoryCaptures = [];
    this._pendingHistoryPurges.clear();
    if (captures.length) this.#capturePersistedNotes(captures);
    if (purgedIds.length) this.#removePurgedHistory(purgedIds);
    await Promise.allSettled([...this._historyTasks]);
  }

  #reportPersistError(key) {
    console.error(`[database] could not persist "${key}" — kept in memory; will retry on the next save`);
    try { if (this.onPersistError) this.onPersistError(key); } catch { /* ignore hook errors */ }
  }

  /** Await the in-flight write drain — call before unload for best-effort durability. */
  async flush() {
    let drain = this.#flushWrites();
    while (drain) {
      await drain;
      drain = this._draining;
    }
    await Promise.allSettled([...this._historyTasks]);
  }

  /** Await only authoritative note/config writes; optional history stays separate. */
  async flushCurrentWrites() {
    let drain = this.#flushWrites();
    while (drain) {
      await drain;
      drain = this._draining;
    }
    return this._writeQueue.size === 0;
  }

  getPersistenceStatus() {
    return {
      lastPersistedAt: this.lastPersistedAt,
      lastRevisionAt: this.lastRevisionAt,
      pendingWrites: this._writeQueue.size,
      pendingHistory: this._historyTasks.size,
    };
  }

  /**
   * Atomically replace the authoritative vault after a separately verified
   * restore preview. Memory is updated only after storage accepts the batch.
   */
  async replaceVault({ notes, config, schemaVersion = CURRENT_SCHEMA_VERSION }) {
    if (!Array.isArray(notes) || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('A restore requires notes and configuration.');
    }
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new TypeError(`Cannot restore schema ${schemaVersion}; expected schema ${CURRENT_SCHEMA_VERSION}.`);
    }
    const hydrated = notes.map((note) => Note.fromJSON(note));
    const normalized = hydrated.map((note) => note.toJSON());
    const changedByModel = normalized.some((note, index) => !jsonEquivalent(note, notes[index]));
    if (changedByModel) {
      throw new TypeError('A restore note contains metadata that cannot be applied exactly.');
    }
    if (hydrated.some((note) => !note.id) || new Set(hydrated.map((note) => note.id)).size !== hydrated.length) {
      throw new TypeError('A restore cannot contain missing or duplicate note IDs.');
    }
    const rawNotes = normalized;
    const rawConfig = structuredClone(config);

    await this.flush();
    if (this._writeQueue.size > 0 || this._draining) {
      this.#reportPersistError(NOTES_KEY);
      return false;
    }
    let saved = false;
    const persistenceAt = new Date().toISOString();
    this._vaultReplacing = true;
    try {
      if (typeof this.storage.saveMany === 'function') {
        const backend = typeof this.storage.getStatus === 'function'
          ? await this.storage.getStatus()
          : typeof this.storage.status === 'function'
            ? await this.storage.status()
            : null;
        // Once IndexedDB is authoritative, a failed IDB transaction must not be
        // reported as a successful restore written only to stale fallback data.
        const allowFallback = backend?.backend !== 'indexeddb';
        saved = await this.storage.saveMany([
          [NOTES_KEY, rawNotes],
          [CONFIG_KEY, rawConfig],
          [SCHEMA_KEY, CURRENT_SCHEMA_VERSION],
          [PERSISTENCE_KEY, { lastPersistedAt: persistenceAt }],
        ], { allowFallback });
      } else {
        const results = await Promise.all([
          this.storage.save(NOTES_KEY, rawNotes),
          this.storage.save(CONFIG_KEY, rawConfig),
          this.storage.save(SCHEMA_KEY, CURRENT_SCHEMA_VERSION),
          this.storage.save(PERSISTENCE_KEY, { lastPersistedAt: persistenceAt }),
        ]);
        saved = results.every(Boolean);
      }
      if (saved) {
        [NOTES_KEY, CONFIG_KEY, SCHEMA_KEY, PERSISTENCE_KEY].forEach((key) => this._writeQueue.delete(key));
      }
    } catch (error) {
      console.error('[database] vault replacement transaction failed:', error);
      saved = false;
    } finally {
      this._vaultReplacing = false;
      if (!saved && this._writeQueue.size) void this.#flushWrites();
    }
    if (!saved) {
      this.#reportPersistError(NOTES_KEY);
      return false;
    }

    this.notes.clear();
    hydrated.forEach((note) => this.notes.set(note.id, note));
    this.config = { showGraph: false, ...rawConfig };
    this.lastPersistedAt = persistenceAt;
    this.#rebuildLinkState();
    this.#emit();
    return true;
  }

  /**
   * Durably capture current note states before a destructive operation. The
   * caller must await this boundary before applying its mutation.
   * @returns {Promise<boolean>} false when local revision history is unavailable
   */
  async captureRevisionBoundary(notes, reason) {
    await this.flush();
    if (typeof this.onNotesPersisted !== 'function') return false;
    const captures = (notes || []).map((note) => ({
      note: typeof note?.toJSON === 'function' ? note.toJSON() : structuredClone(note),
      reason,
      force: true,
    }));
    if (captures.length === 0) return true;
    await this.onNotesPersisted(captures);
    this.lastRevisionAt = new Date().toISOString();
    return true;
  }

  setConfig(patch) {
    this.config = { ...this.config, ...patch };
    this.#queueWrite(CONFIG_KEY, this.config);
  }

  // --- derived link indexes ----------------------------------------------

  #identitySignature(note) {
    return JSON.stringify([
      normalizeTitle(note?.title),
      ...(Array.isArray(note?.aliases) ? note.aliases.map(normalizeTitle) : []),
      Boolean(note?.isTrashed),
      Boolean(note?.isArchived),
    ]);
  }

  #pushIndex(index, key, note) {
    if (!key) return;
    const entries = index.get(key) || [];
    entries.push(note);
    index.set(key, entries);
  }

  #rebuildResolutionIndexes() {
    this._titleIndex.clear();
    this._aliasIndex.clear();
    this._identitySignatures.clear();
    for (const note of this.getAllNotes()) {
      this.#pushIndex(this._titleIndex, normalizeTitle(note.title), note);
      for (const alias of note.aliases || []) this.#pushIndex(this._aliasIndex, normalizeTitle(alias), note);
      this._identitySignatures.set(note.id, this.#identitySignature(note));
    }

  }

  #rebuildLinkState() {
    this.#rebuildResolutionIndexes();
    this._knowledgeIndex?.rebuild();
  }

  #resolveFromIndexes(title) {
    const key = normalizeTitle(title);
    if (!key) return { status: 'missing', key, note: null, via: null, candidates: [] };
    const canonical = [...new Map((this._titleIndex.get(key) || []).map((note) => [note.id, note])).values()];
    if (canonical.length === 1) return { status: 'resolved', key, note: canonical[0], via: 'title', candidates: canonical };
    if (canonical.length > 1) return { status: 'ambiguous', key, note: null, via: 'title', candidates: canonical };
    const aliases = [...new Map((this._aliasIndex.get(key) || []).map((note) => [note.id, note])).values()];
    if (aliases.length === 1) return { status: 'resolved', key, note: aliases[0], via: 'alias', candidates: aliases };
    if (aliases.length > 1) return { status: 'ambiguous', key, note: null, via: 'alias', candidates: aliases };
    return { status: 'missing', key, note: null, via: null, candidates: [] };
  }

  /** Unique canonical and alias targets used by autocomplete/mention analysis. */
  linkCandidates() {
    const candidates = [];
    for (const [key, notes] of this._titleIndex) {
      const unique = [...new Map(notes.map((note) => [note.id, note])).values()];
      if (unique.length === 1) candidates.push({ name: unique[0].title, targetId: unique[0].id, targetTitle: unique[0].title, key });
    }
    for (const [key, notes] of this._aliasIndex) {
      if (this._titleIndex.has(key)) continue; // canonical title always outranks aliases
      const unique = [...new Map(notes.map((note) => [note.id, note])).values()];
      if (unique.length !== 1) continue;
      const alias = unique[0].aliases.find((value) => normalizeTitle(value) === key);
      if (alias) candidates.push({ name: alias, targetId: unique[0].id, targetTitle: unique[0].title, key });
    }
    return candidates;
  }

  /** Load the rebuildable contextual-link index after the first usable note. */
  async initializeKnowledgeIndex() {
    if (this._knowledgeIndex) return this._knowledgeIndex;
    if (this._knowledgeReady) return this._knowledgeReady;
    this._knowledgeReady = import('./knowledge-index.js')
      .then(({ KnowledgeIndex }) => {
        this._knowledgeIndex = new KnowledgeIndex(this);
        this.#emit();
        return this._knowledgeIndex;
      })
      .catch((error) => {
        this._knowledgeReady = null;
        throw error;
      });
    return this._knowledgeReady;
  }

  // --- CRUD ---------------------------------------------------------------

  saveNote(note, { captureRevision = true, reason = 'autosave' } = {}) {
    const previousIdentity = this._identitySignatures.get(note.id) ?? null;
    this.notes.set(note.id, note);
    const nextIdentity = this.#identitySignature(note);
    if (previousIdentity !== nextIdentity) {
      this.#rebuildResolutionIndexes();
      this._knowledgeIndex?.rebuild();
    } else {
      this._knowledgeIndex?.refreshSource(note);
    }
    const captures = captureRevision ? [{ note: note.toJSON(), reason }] : [];
    this.#persist(captures);
    this.#emit();
    return note;
  }

  createNote(fields = {}, { allowIdentityConflicts = false } = {}) {
    const note = new Note(fields);
    if (!allowIdentityConflicts) {
      const identity = this.#validateIdentityCandidate(null, note.title, note.aliases);
      if (!identity.valid) {
        const error = new Error(identity.message);
        error.code = identity.code;
        error.collision = identity.collision;
        throw error;
      }
      note.title = identity.title;
      note.aliases = identity.aliases;
    }
    // A brand-new blank/default state is not useful history. Its first durable
    // user edit becomes the initial revision boundary instead.
    return this.saveNote(note, { captureRevision: false });
  }

  /** Live child notes of `id` (direct children only). */
  childrenOf(id) {
    return this.getAllNotes().filter((n) => n.parentId === id);
  }

  /** Live ancestor chain of `id`, top-most first (excludes the note itself). */
  ancestorsOf(id) {
    return ancestorChain(this.getAllNotes(), id);
  }

  /**
   * Reparent a note (parentId = null for top level). Rejects self-parenting,
   * cycles (parent can't be a descendant), and parents outside the requested
   * lifecycle scope. Merge import may explicitly include archived notes.
   * @param {{ includeArchived?:boolean }} options
   * @returns {boolean} whether the move was applied.
   */
  setParent(id, parentId, { includeArchived = false } = {}) {
    const inScope = (noteId) => {
      if (!includeArchived) return this.getNote(noteId);
      const candidate = this.notes.get(noteId);
      return candidate && !candidate.isTrashed ? candidate : null;
    };
    const note = inScope(id);
    if (!note) return false;
    const next = parentId || null;
    if (next === note.parentId) return true; // no-op
    if (next !== null) {
      if (next === id) return false;
      if (!inScope(next)) return false; // parent must be available in the same lifecycle scope
      const candidates = includeArchived ? this.getNotesInScope('nontrash') : this.getAllNotes();
      if (isDescendant(candidates, id, next)) return false; // would create a cycle
    }
    note.parentId = next; // structural change only — don't touch updatedAt
    this.#persist();
    this.#emit();
    return true;
  }

  /** Pin or unpin a live note. Returns the new pinned state (or null if absent). */
  setPinned(id, pinned) {
    const note = this.getNote(id);
    if (!note) return null;
    note.setPinned(pinned);
    this.#persist();
    this.#emit();
    return note.pinned;
  }

  /** Move a note to the Trash (recoverable). Returns true if it was live. */
  deleteNote(id) {
    const note = this.notes.get(id);
    if (!note || note.isTrashed) return false;
    note.markTrashed();
    this.#rebuildLinkState();
    this.#persist();
    this.#emit();
    return true;
  }

  /** Restore a note from the Trash. Returns true if it was trashed. */
  restoreNote(id) {
    const note = this.notes.get(id);
    if (!note || !note.isTrashed) return false;
    note.restore();
    this.#rebuildLinkState();
    this.#persist();
    this.#emit();
    return true;
  }

  /** Move one active note to Archive while retaining hierarchy and identity. */
  archiveNote(id) {
    const note = this.getNote(id);
    if (!note) return false;
    const before = note.toJSON();
    note.markArchived();
    this.#rebuildLinkState();
    this.#persist([{ note: before, reason: 'pre_archive' }]);
    this.#emit();
    return true;
  }

  /** Restore one archived note to active scope, rejecting identity ambiguity. */
  unarchiveNote(id) {
    const note = this.getArchivedNote(id);
    if (!note) return false;
    const identity = this.validateNewLinkIdentity(note.title, note.aliases);
    if (!identity.valid) {
      const error = new Error(identity.message);
      error.code = identity.code;
      throw error;
    }
    const before = note.toJSON();
    note.unarchive();
    this.#rebuildLinkState();
    this.#persist([{ note: before, reason: 'pre_unarchive' }]);
    this.#emit();
    return true;
  }

  /** Permanently remove a single note (from the Trash or otherwise). */
  purgeNote(id) {
    const existed = this.notes.delete(id);
    if (existed) {
      this.#rebuildLinkState();
      this.#persist([], [id]);
      this.#emit();
    }
    return existed;
  }

  /** Permanently remove every trashed note. Returns how many were purged. */
  emptyTrash() {
    let purged = 0;
    const purgedIds = [];
    for (const note of this.#rawNotes()) {
      if (note.isTrashed) {
        this.notes.delete(note.id);
        purgedIds.push(note.id);
        purged++;
      }
    }
    if (purged) {
      this.#rebuildLinkState();
      this.#persist([], purgedIds);
      this.#emit();
    }
    return purged;
  }

  /** An active note by id, or null (Archive and Trash require explicit scope). */
  getNote(id) {
    const note = this.notes.get(id);
    return note && !note.isTrashed && !note.isArchived ? note : null;
  }

  /** All active notes (excludes Archive and Trash). */
  getAllNotes() {
    return this.#rawNotes().filter((n) => !n.isTrashed && !n.isArchived);
  }

  getArchivedNote(id) {
    const note = this.notes.get(id);
    return note && !note.isTrashed && note.isArchived ? note : null;
  }

  getArchived() {
    return this.#rawNotes()
      .filter((note) => !note.isTrashed && note.isArchived)
      .sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  }

  getNotesInScope(scope = 'active') {
    if (scope === 'archived') return this.getArchived();
    if (scope === 'trash') return this.getTrash();
    if (scope === 'nontrash') return this.#rawNotes().filter((note) => !note.isTrashed);
    if (scope === 'all') return this.#rawNotes();
    return this.getAllNotes();
  }

  /** Trashed notes, most-recently-deleted first. */
  getTrash() {
    return this.#rawNotes()
      .filter((n) => n.isTrashed)
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  }

  /** Live notes sorted most-recently-updated first. */
  getNotesSorted() {
    return this.getAllNotes().sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  }

  // --- resolution & search ------------------------------------------------

  /** Canonical-title-first, unique-alias-second resolution with ambiguity detail. */
  resolveTitleResult(title) {
    const result = this.#resolveFromIndexes(title);
    return {
      ...result,
      candidates: result.candidates.map((note) => ({ id: note.id, title: note.title })),
    };
  }

  /** Resolve a wikilink target to one live Note, never guessing ambiguity. */
  resolveTitle(title) {
    return this.#resolveFromIndexes(title).note;
  }

  /** Canonical live titles. */
  allTitles() {
    return this.getAllNotes().map((n) => n.title);
  }

  /** Every currently resolvable canonical title or unique alias. */
  allLinkNames() {
    return this.linkCandidates().map((candidate) => candidate.name);
  }

  #validateIdentityCandidate(noteId, title, aliases = []) {
    const storedTitle = String(title ?? '').trim();
    const titleKey = normalizeTitle(storedTitle);
    if (!titleKey) return { valid: false, code: 'blank_title', message: 'A note title cannot be blank.' };
    const normalizedAliases = normalizeAliases(aliases, storedTitle);
    const proposed = [
      { kind: 'title', value: storedTitle, key: titleKey },
      ...normalizedAliases.map((value) => ({ kind: 'alias', value, key: normalizeTitle(value) })),
    ];
    for (const other of this.getAllNotes()) {
      if (other.id === noteId) continue;
      const otherNames = [other.title, ...(other.aliases || [])];
      for (const candidate of proposed) {
        const collision = otherNames.find((value) => normalizeTitle(value) === candidate.key);
        if (collision) {
          return {
            valid: false,
            code: 'identity_collision',
            message: `“${candidate.value}” already identifies “${other.title}”. Choose a unique title.`,
            collision: { noteId: other.id, noteTitle: other.title, value: collision, kind: candidate.kind },
          };
        }
      }
    }
    return { valid: true, title: storedTitle, aliases: normalizedAliases };
  }

  validateLinkIdentity(noteId, title, aliases = []) {
    const current = this.getNote(noteId);
    if (!current) return { valid: false, code: 'missing_note', message: 'The note no longer exists.' };
    return this.#validateIdentityCandidate(noteId, title, aliases);
  }

  /** Validate a proposed live identity before an interactive create. */
  validateNewLinkIdentity(title, aliases = []) {
    return this.#validateIdentityCandidate(null, title, aliases);
  }

  /** Return a canonical title that cannot resolve to any live title or alias. */
  availableTitle(requested = 'Untitled') {
    const base = String(requested ?? '').trim() || 'Untitled';
    if (this.validateNewLinkIdentity(base).valid) return base;
    for (let suffix = 2; suffix < 100_000; suffix += 1) {
      const candidate = `${base} ${suffix}`;
      if (this.validateNewLinkIdentity(candidate).valid) return candidate;
    }
    throw new Error('Could not generate a unique note title.');
  }

  /** Atomic persistence boundary used by previewed, lazily loaded link tools. */
  async commitPlannedNotes(replacements, captures, reason) {
    await this.flush();
    if (this._writeQueue.size || this._draining) throw new Error('Current note changes are still pending; try again after they save.');
    const historyAvailable = await this.captureRevisionBoundary(captures, reason);
    if (!historyAvailable) throw new Error('Browser-local revision history is unavailable, so this source rewrite was not applied.');

    const replacementById = new Map(replacements.map((raw) => [raw.id, Note.fromJSON(raw)]));
    const nextNotes = this.#rawNotes().map((note) => replacementById.get(note.id) || note);
    const rawNotes = nextNotes.map((note) => note.toJSON());
    const persistenceAt = new Date().toISOString();
    let saved = false;
    if (typeof this.storage.saveMany === 'function') {
      const backend = typeof this.storage.getStatus === 'function'
        ? await this.storage.getStatus()
        : typeof this.storage.status === 'function'
          ? await this.storage.status()
          : null;
      saved = await this.storage.saveMany([
        [NOTES_KEY, rawNotes],
        [PERSISTENCE_KEY, { lastPersistedAt: persistenceAt }],
      ], { allowFallback: backend?.backend !== 'indexeddb' });
    } else {
      saved = await this.storage.save(NOTES_KEY, rawNotes);
      if (saved) await this.storage.save(PERSISTENCE_KEY, { lastPersistedAt: persistenceAt });
    }
    if (!saved) throw new Error('The planned source rewrite could not be saved; no in-memory notes were changed.');

    this.notes.clear();
    nextNotes.forEach((note) => this.notes.set(note.id, note));
    this.lastPersistedAt = persistenceAt;
    this.#rebuildLinkState();
    this.#emit();
    return true;
  }

  backlinkOccurrencesFor(id) {
    return this._knowledgeIndex?.backlinkOccurrencesFor(id) || [];
  }

  unlinkedMentionsFor(id) {
    return this._knowledgeIndex?.unlinkedMentionsFor(id) || [];
  }

  /** A trashed note whose title matches (case-insensitive), or null. Lets the
   *  app restore a trashed note instead of forking a duplicate-title note when a
   *  [[wikilink]] to it is followed. */
  findTrashedByTitle(title) {
    const key = normalizeTitle(title);
    return this.getTrash().find((n) => normalizeTitle(n.title) === key) || null;
  }

  searchNotes(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.getNotesSorted();
    return this.getNotesSorted().filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  // --- tags ---------------------------------------------------------------

  /** Map of tag -> count over live notes, computed fresh. */
  tagCounts() {
    const counts = new Map();
    for (const note of this.getAllNotes()) {
      for (const tag of note.tags) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return counts;
  }

  notesByTag(tag) {
    return this.getNotesSorted().filter((n) => n.tags.includes(tag));
  }

  // --- link graph ---------------------------------------------------------

  /** Unique live source notes that link to the given note. */
  backlinksFor(id) {
    if (!this._knowledgeIndex) {
      return this.getAllNotes().filter((source) => source.id !== id && source.outgoingLinks().some((target) => this.resolveTitle(target)?.id === id));
    }
    const ids = new Set(this.backlinkOccurrencesFor(id).map((occurrence) => occurrence.sourceId));
    return [...ids].map((sourceId) => this.getNote(sourceId)).filter(Boolean);
  }

  /**
   * Directed link graph over live notes.
   * @returns {{ nodes: Note[], edges: {source:string,target:string}[] }}
   */
  graph() {
    const nodes = this.getAllNotes();
    if (this._knowledgeIndex) return { nodes, edges: this._knowledgeIndex.graphEdges() };
    const edges = [];
    for (const source of nodes) {
      const targets = new Set(source.outgoingLinks().map((target) => this.resolveTitle(target)?.id).filter(Boolean));
      for (const target of targets) if (target !== source.id) edges.push({ source: source.id, target });
    }
    return { nodes, edges };
  }
}
