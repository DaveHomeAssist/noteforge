function clean(db, canAdopt) {
  return (
    !db._readOnly &&
    db._vaultMeta &&
    !db._vaultReplacing &&
    !db._draining &&
    !db._writeQueue.size &&
    canAdopt() &&
    db.notes.size === db._savedNotes.size &&
    [...db.notes].every(([id, note]) => JSON.stringify(note.toJSON()) === db._savedNotes.get(id)) &&
    JSON.stringify(db.config) === JSON.stringify(db._savedConfig)
  );
}

/** Notifications are hints. Only a consistent storage read can advance a view. */
export async function refreshVault(db, canAdopt, adopt) {
  if (!clean(db, canAdopt)) return { status: 'deferred' };
  const revision = db._mutationRevision;
  const snapshot = await db.storage.readCurrentVault();
  if (revision !== db._mutationRevision || !clean(db, canAdopt)) return { status: 'deferred' };
  if (!snapshot?.meta || !snapshot.config) throw new Error('The saved vault could not be refreshed.');
  if (
    snapshot.meta.generation === db._vaultMeta.generation &&
    snapshot.meta.sequence === db._vaultMeta.sequence &&
    JSON.stringify(snapshot.conflicts) === JSON.stringify([...db.conflicts.values()])
  )
    return { status: 'unchanged' };
  const records = new Map(snapshot.records);
  const noteIds = [...new Set([...db.notes.keys(), ...records.keys()])].filter(
    (id) => JSON.stringify(records.get(id)?.value ?? null) !== (db._savedNotes.get(id) ?? 'null'),
  );
  adopt(snapshot, noteIds);
  return { status: 'refreshed', noteIds };
}
