import { normalizeTitle } from '../utils/helpers.js';

// Archived/trashed notes do not own live link names. Source spelling stays intact.
export function activeIdentityKeys(note) {
  if (!note || note.deletedAt != null || note.archivedAt != null) return [];
  return [...new Set([note.title, ...(Array.isArray(note.aliases) ? note.aliases : [])].map(normalizeTitle))]
    .filter(Boolean)
    .sort();
}

export function introducedIdentityClaims(writes, current) {
  const claims = new Map();
  writes.forEach((write, index) => {
    if (write.allowIdentityConflicts === true) return;
    const previous = new Set(activeIdentityKeys(current[index]?.value));
    for (const name of activeIdentityKeys(write.value)) {
      if (previous.has(name)) continue;
      if (!claims.has(name)) claims.set(name, []);
      claims.get(name).push(write.id);
    }
  });
  return claims;
}

export function identityCollisionsFor(claims, id, value) {
  const conflicts = [];
  for (const name of activeIdentityKeys(value)) {
    for (const claimant of claims.get(name) ?? []) {
      if (claimant !== id)
        conflicts.push({ kind: 'identity', id: claimant, name, ownerId: id, ownerTitle: value.title });
    }
  }
  return conflicts;
}
