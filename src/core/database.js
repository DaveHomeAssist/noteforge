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

import { Note } from './note.js';
import { storage } from './storage.js';
import { runMigrations, CURRENT_SCHEMA_VERSION } from './migrations.js';
import { isDescendant, ancestorChain } from '../utils/tree.js';
import { normalizeTitle } from '../utils/helpers.js';

const NOTES_KEY = 'notes';
const CONFIG_KEY = 'config';
const SCHEMA_KEY = 'schemaVersion';

export class Database {
  constructor() {
    this.notes = new Map(); // id -> Note (both live and trashed)
    // Default config is available synchronously; init() overlays the stored one.
    // No `theme` default here — a fresh install must fall through to the settings
    // default (themeMode: 'system'); a legacy stored `theme` still wins for upgrades.
    this.config = { showGraph: false };
    this.listeners = new Set();
    this.ready = false;
    this._writeQueue = new Map(); // key -> latest value (coalesced)
    this._draining = null; // the single in-flight drain promise, or null
    this.onPersistError = null; // optional (key) => void hook for the UI
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
    const storedVersion = await storage.load(SCHEMA_KEY, undefined);
    const rawNotes = await storage.load(NOTES_KEY, []);
    const rawConfig = await storage.load(CONFIG_KEY, {});

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

  #persist() {
    // Persist the full set (live + trashed) so the Trash survives reload.
    this.#queueWrite(NOTES_KEY, this.#rawNotes().map((n) => n.toJSON()));
  }

  #queueWrite(key, value) {
    this._writeQueue.set(key, value); // latest snapshot wins (coalesced)
    void this.#flushWrites();
  }

  #flushWrites() {
    // A single shared drain: concurrent callers (incl. flush()) get the SAME
    // in-flight promise, so awaiting it actually waits for pending writes to
    // commit instead of returning early while a write is still in flight.
    if (this._draining) return this._draining;
    this._draining = (async () => {
      try {
        while (this._writeQueue.size) {
          const [key, value] = this._writeQueue.entries().next().value;
          const okSave = await storage.save(key, value);
          if (okSave) {
            // Delete only if a newer snapshot for this key wasn't queued while
            // we awaited — otherwise loop again and persist the newer value.
            if (this._writeQueue.get(key) === value) this._writeQueue.delete(key);
          } else {
            // Persist failed on every backend (e.g. IndexedDB error AND
            // localStorage over quota). Never silently drop it: keep the
            // snapshot queued, surface the failure, and stop this drain to
            // avoid a hot spin. The in-memory Map is still the source of truth
            // for the session, and the next save (or flush) retries.
            this.#reportPersistError(key);
            break;
          }
        }
      } finally {
        this._draining = null;
      }
    })();
    return this._draining;
  }

  #reportPersistError(key) {
    console.error(`[database] could not persist "${key}" — kept in memory; will retry on the next save`);
    try { if (this.onPersistError) this.onPersistError(key); } catch { /* ignore hook errors */ }
  }

  /** Await the in-flight write drain — call before unload for best-effort durability. */
  async flush() {
    await this.#flushWrites();
  }

  setConfig(patch) {
    this.config = { ...this.config, ...patch };
    this.#queueWrite(CONFIG_KEY, this.config);
  }

  // --- CRUD ---------------------------------------------------------------

  saveNote(note) {
    this.notes.set(note.id, note);
    this.#persist();
    this.#emit();
    return note;
  }

  createNote(fields = {}) {
    const note = new Note(fields);
    return this.saveNote(note);
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
   * cycles (parent can't be a descendant), and parents that aren't live notes.
   * @returns {boolean} whether the move was applied.
   */
  setParent(id, parentId) {
    const note = this.getNote(id);
    if (!note) return false;
    const next = parentId || null;
    if (next === note.parentId) return true; // no-op
    if (next !== null) {
      if (next === id) return false;
      if (!this.getNote(next)) return false; // parent must be a live note
      if (isDescendant(this.getAllNotes(), id, next)) return false; // would create a cycle
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
    this.#persist();
    this.#emit();
    return true;
  }

  /** Restore a note from the Trash. Returns true if it was trashed. */
  restoreNote(id) {
    const note = this.notes.get(id);
    if (!note || !note.isTrashed) return false;
    note.restore();
    this.#persist();
    this.#emit();
    return true;
  }

  /** Permanently remove a single note (from the Trash or otherwise). */
  purgeNote(id) {
    const existed = this.notes.delete(id);
    if (existed) {
      this.#persist();
      this.#emit();
    }
    return existed;
  }

  /** Permanently remove every trashed note. Returns how many were purged. */
  emptyTrash() {
    let purged = 0;
    for (const note of this.#rawNotes()) {
      if (note.isTrashed) {
        this.notes.delete(note.id);
        purged++;
      }
    }
    if (purged) {
      this.#persist();
      this.#emit();
    }
    return purged;
  }

  /** A live note by id, or null (trashed notes are treated as absent). */
  getNote(id) {
    const note = this.notes.get(id);
    return note && !note.isTrashed ? note : null;
  }

  /** All live notes (excludes the Trash). */
  getAllNotes() {
    return this.#rawNotes().filter((n) => !n.isTrashed);
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

  /** Resolve a wikilink target (by title, case-insensitive) to a live Note. */
  resolveTitle(title) {
    const key = normalizeTitle(title);
    return this.getAllNotes().find((n) => normalizeTitle(n.title) === key) || null;
  }

  /** All live titles currently in use — feeds the wikilink renderer. */
  allTitles() {
    return this.getAllNotes().map((n) => n.title);
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

  /** Live notes that link *to* the given note via a [[wikilink]] on its title. */
  backlinksFor(id) {
    const note = this.getNote(id);
    if (!note) return [];
    const target = normalizeTitle(note.title);
    return this.getAllNotes().filter(
      (other) =>
        other.id !== id &&
        other.outgoingLinks().some((link) => normalizeTitle(link) === target)
    );
  }

  /**
   * Directed link graph over live notes.
   * @returns {{ nodes: Note[], edges: {source:string,target:string}[] }}
   */
  graph() {
    const nodes = this.getAllNotes();
    const edges = [];
    for (const note of nodes) {
      for (const link of note.outgoingLinks()) {
        const target = this.resolveTitle(link);
        if (target && target.id !== note.id) {
          edges.push({ source: note.id, target: target.id });
        }
      }
    }
    return { nodes, edges };
  }
}
