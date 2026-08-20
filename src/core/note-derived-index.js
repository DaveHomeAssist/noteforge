// Small rebuildable cache for derived views whose records belong to one source
// note. Database subscriptions provide changed note IDs, so an ordinary save
// reparses only that note; full rebuilds remain available after init/restore.

export class NoteDerivedIndex {
  constructor(db, derive) {
    if (!db || typeof derive !== 'function') throw new TypeError('A note-derived index requires a database and derivation function.');
    this.db = db;
    this.derive = derive;
    this.records = new Map();
    this.dirty = null;
    this.unsubscribe = db.subscribe?.((_database, noteIds) => this.invalidate(noteIds)) || null;
  }

  invalidate(noteIds = null) {
    if (!Array.isArray(noteIds)) {
      this.dirty = null;
      return;
    }
    if (this.dirty === null) return;
    for (const id of noteIds) if (typeof id === 'string') this.dirty.add(id);
  }

  #derive(note) {
    const records = this.derive(note);
    this.records.set(note.id, Array.isArray(records) ? records : []);
  }

  list() {
    if (this.dirty === null) {
      this.records.clear();
      for (const note of this.db.getAllNotes()) this.#derive(note);
      this.dirty = new Set();
    } else if (this.dirty.size) {
      for (const id of this.dirty) {
        const note = this.db.getNote(id);
        if (note) this.#derive(note);
        else this.records.delete(id);
      }
      this.dirty.clear();
    }
    return [...this.records.values()].flat();
  }

  destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.records.clear();
    this.dirty = new Set();
  }
}
