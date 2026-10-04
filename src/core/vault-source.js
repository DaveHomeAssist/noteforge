import { CURRENT_SCHEMA_VERSION } from './migrations.js';

// Validate before projecting source into a Map or running migrations. A recovery
// export must retain ambiguous/malformed source instead of silently normalizing it.
export function validateLegacyVault(source) {
  if (!Number.isInteger(source.schemaVersion) || source.schemaVersion < 0)
    throw new Error('The saved vault has an invalid schema version.');
  if (source.schemaVersion > CURRENT_SCHEMA_VERSION)
    throw new Error('The saved vault uses a newer, unsupported schema. Export its original source before upgrading.');
  if (
    !Array.isArray(source.notes) ||
    !source.config ||
    typeof source.config !== 'object' ||
    Array.isArray(source.config)
  )
    throw new Error('The saved notes or settings have an invalid format.');
  const ids = new Set();
  for (const note of source.notes) {
    if (
      !note ||
      typeof note !== 'object' ||
      Array.isArray(note) ||
      typeof note.id !== 'string' ||
      !note.id ||
      typeof note.title !== 'string' ||
      typeof note.content !== 'string'
    )
      throw new Error('The saved vault contains an invalid note.');
    if (ids.has(note.id))
      throw new Error('The saved vault contains duplicate note identities. Its original source must be preserved.');
    ids.add(note.id);
  }
}
