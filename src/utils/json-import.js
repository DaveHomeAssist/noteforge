// Pure parsing/selection helpers for the existing portable JSON *merge* import.
// This is intentionally not a backup/restore format: App still generates fresh
// note IDs and remaps imported parents. Keeping the parser DOM-free makes the
// current rejection and filtering behavior testable before Phase 1 introduces
// a separate, versioned, lossless backup envelope.

export function parseNoteMergeImport(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of notes.');
  return parsed;
}

// A hand-edited or third-party file can carry `"title": 2026` or `"tags": [7]`.
// Stored as given, those survive a save and then throw in every consumer that
// treats them as text (search, tag filters). Finite numbers become text; any
// other non-text value is dropped so the app's own defaults apply.
const importText = (value) => (typeof value === 'string' ? value : Number.isFinite(value) ? String(value) : '');
const importDate = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined);

/** Importable entries as typed shallow copies; the parsed input is never mutated. */
export function selectImportableNotes(entries) {
  return entries
    .filter((data) => data && typeof data.content === 'string')
    .map((data) => ({
      ...data,
      title: importText(data.title),
      tags: (Array.isArray(data.tags) ? data.tags : []).map(importText).filter(Boolean),
      createdAt: importDate(data.createdAt),
      updatedAt: importDate(data.updatedAt),
    }));
}
