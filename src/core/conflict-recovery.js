import { Note } from './note.js';
import { normalizeTitle } from '../utils/helpers.js';

// UI previews are detached from the commit contract. Mutating a rendered preview
// cannot change the reviewed draft or substitute a different write at confirmation.
const previews = new WeakMap();
const stale = () => new Error('The draft or saved vault changed. Review an updated comparison before choosing again.');

export async function previewConflict(db, id) {
  if (db._readOnly || !db._vaultMeta || db._vaultReplacing)
    throw new Error('Conflict recovery is unavailable right now.');
  await db.flushCurrentWrites();
  const revision = db._mutationRevision;
  const localNotes = new Map([...db.notes].map(([id, note]) => [id, JSON.stringify(note.toJSON())]));
  const snapshot = await db.storage.readCurrentVault();
  if (revision !== db._mutationRevision) throw stale();
  const conflict = snapshot.conflicts.find((item) => item.id === id);
  if (!conflict) throw new Error('This conflict has already been resolved.');
  const records = new Map(snapshot.records);
  const mutation = conflict.mutation;
  const notes = (mutation.notes ?? []).map((write) => ({
    id: write.id,
    draft: write.value,
    current: records.get(write.id)?.value ?? null,
  }));
  const preview = {
    id,
    notes,
    config: (mutation.config ?? []).map((write) => ({
      key: write.key,
      draft: write.value,
      current: snapshot.config.values[write.key],
    })),
    canCopy: notes.some((note) => note.draft),
    canUseDraft:
      mutation.generation === snapshot.meta.generation && mutation.sequence === undefined && !mutation.replacement,
    requiresNewPlan: mutation.sequence !== undefined || Boolean(mutation.replacement),
  };
  const shown = structuredClone(preview);
  previews.set(shown, { db, revision, snapshot, conflict, preview, localNotes });
  return shown;
}

function copyWrites(snapshot, conflict, timestamp) {
  const titles = new Set(
    snapshot.records
      .filter(([, record]) => record.value)
      .flatMap(([, record]) => [record.value.title, ...(record.value.aliases ?? [])])
      .map(normalizeTitle),
  );
  return (conflict.mutation.notes ?? [])
    .filter((write) => write.value)
    .map(({ value }) => {
      const base = `${value.title || 'Untitled'} (Recovered copy)`;
      let title = base;
      let index = 2;
      while (titles.has(normalizeTitle(title))) title = `${base} ${index++}`;
      titles.add(normalizeTitle(title));
      const note = Note.fromJSON({
        ...structuredClone(value),
        id: crypto.randomUUID(),
        title,
        aliases: [],
        parentId: null,
        deletedAt: null,
        archivedAt: null,
        pinned: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { id: note.id, expected: 0, value: note.toJSON() };
    });
}

function overlayPending(db, snapshot) {
  const records = new Map(snapshot.records);
  for (const [key, entry] of db._writeQueue) {
    if (key.startsWith('note:'))
      records.set(key.slice(5), { version: entry.expected, value: structuredClone(entry.value) });
    if (key === 'config') {
      for (const write of entry.value) {
        if (write.remove) delete snapshot.config.values[write.key];
        else snapshot.config.values = { ...snapshot.config.values, [write.key]: structuredClone(write.value) };
        snapshot.config.versions = { ...snapshot.config.versions, [write.key]: write.expected };
      }
    }
  }
  snapshot.records = [...records];
  return snapshot;
}

function committedSnapshot(snapshot, mutation, meta, conflicts) {
  const current = structuredClone(snapshot);
  current.meta = meta;
  current.persistence = { lastPersistedAt: mutation.timestamp };
  const retained = new Map(current.conflicts.map((conflict) => [conflict.id, conflict]));
  for (const conflict of conflicts.values()) retained.set(conflict.id, conflict);
  retained.delete(mutation.resolution.id);
  current.conflicts = [...retained.values()];
  const records = new Map(current.records);
  for (const write of mutation.notes) records.set(write.id, { version: write.expected + 1, value: write.value });
  current.records = [...records];
  for (const write of mutation.config) {
    if (write.remove) delete current.config.values[write.key];
    else current.config.values = { ...current.config.values, [write.key]: write.value };
    current.config.versions = { ...current.config.versions, [write.key]: write.expected + 1 };
  }
  return current;
}

export async function resolveConflict(db, shown, action, adopt) {
  const prepared = previews.get(shown);
  if (!prepared || prepared.db !== db || prepared.revision !== db._mutationRevision) throw stale();
  const { snapshot, conflict, preview, revision } = prepared;
  if (!['keep-current', 'save-copy', 'use-draft'].includes(action)) throw new TypeError('Unknown recovery action.');
  if ((action === 'save-copy' && !preview.canCopy) || (action === 'use-draft' && !preview.canUseDraft))
    throw new Error('This operation needs a new plan. Export its draft or keep the current vault.');
  if (db._readOnly || db._vaultReplacing) throw new Error('Another vault operation is in progress.');
  const entries = new Map([...db._writeQueue].filter(([, entry]) => entry.conflictId === conflict.id));
  const beforeNotes = prepared.localNotes;
  db._vaultReplacing = true;
  try {
    if (db._draining) await db._draining;
    if (revision !== db._mutationRevision) throw stale();
    const timestamp = new Date().toISOString();
    const records = new Map(snapshot.records);
    const mutation = {
      generation: snapshot.meta.generation,
      sequence: snapshot.meta.sequence,
      timestamp,
      notes: [],
      config: [],
      resolution: { id: conflict.id, fingerprint: JSON.stringify(conflict), action },
    };
    if (action === 'save-copy') mutation.notes = copyWrites(snapshot, conflict, timestamp);
    if (action === 'use-draft') {
      mutation.notes = (conflict.mutation.notes ?? []).map((write) => ({
        ...write,
        expected: records.get(write.id)?.version ?? 0,
      }));
      mutation.config = (conflict.mutation.config ?? []).map((write) => ({
        ...write,
        expected: Object.hasOwn(snapshot.config.versions, write.key) ? snapshot.config.versions[write.key] : 0,
      }));
      const captures = preview.notes
        .filter((note) => note.current)
        .map((note) => ({ note: structuredClone(note.current), reason: 'pre_restore', force: true }));
      if (captures.length) {
        if (typeof db.onNotesPersisted !== 'function')
          throw new Error('Safety history is not ready. Try again after recovery loads.');
        await db.onNotesPersisted(captures);
      }
    }
    if (
      revision !== db._mutationRevision ||
      beforeNotes.size !== db.notes.size ||
      [...beforeNotes].some(([id, raw]) => JSON.stringify(db.notes.get(id)?.toJSON()) !== raw)
    )
      throw stale();
    const result = await db.storage.commitCurrentVault(mutation);
    if (result.status !== 'committed') throw stale();
    previews.delete(shown);
    // If an edit arrived during commit, retain it on its original base. It must
    // conflict explicitly rather than automatically overwriting the resolution.
    for (const [id, note] of db.notes) {
      const raw = JSON.stringify(note.toJSON());
      if (raw !== beforeNotes.get(id) && raw !== JSON.stringify(db._writeQueue.get(`note:${id}`)?.value))
        db.saveNote(note);
    }
    for (const [key, entry] of entries) {
      if (db._writeQueue.get(key) === entry) db._writeQueue.delete(key);
    }
    for (const entry of db._writeQueue.values()) {
      if (entry.conflictId === conflict.id) entry.conflictId = undefined;
    }
    // The vault-wide precondition proves this projection is the committed state.
    // A follow-up read failure must not turn an acknowledged resolution into an
    // ambiguous result or discard a newer local draft.
    const current = committedSnapshot(snapshot, mutation, result.meta, db.conflicts);
    adopt(overlayPending(db, current));
    return {
      action,
      noteIds: [...new Set([...preview.notes.map((note) => note.id), ...mutation.notes.map((write) => write.id)])],
    };
  } finally {
    db._vaultReplacing = false;
    void db.flushCurrentWrites();
  }
}
