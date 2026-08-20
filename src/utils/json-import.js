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

export function selectImportableNotes(entries) {
  return entries.filter((data) => data && typeof data.content === 'string');
}
