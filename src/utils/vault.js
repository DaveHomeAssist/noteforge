// Save the whole vault to a real folder as one Markdown file per note, using the
// File System Access API (Chromium). Files are named after the note title (so
// [[wikilinks]] stay resolvable in Obsidian/other tools) with filesystem-unsafe
// characters replaced and collisions de-duplicated.
//
// vaultFileName is pure (Node-testable); writeVaultToDir takes any directory handle
// (a real FileSystemDirectoryHandle, or a mock in tests) so the write loop is testable
// without the native picker.

// Only truly filesystem-illegal characters (+ control chars) are replaced; spaces
// and hyphens are kept so `[[My Note]]` still resolves to `My Note.md` in Obsidian.
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 control characters are illegal in file names and must be stripped
const UNSAFE = /[/\\:*?"<>|\x00-\x1f]+/g;

/**
 * A filesystem-safe `<title>.md` name, de-duplicated against `used` (a Set of
 * already-taken lowercased names). Mutates `used`.
 */
export function vaultFileName(title, used) {
  let base = String(title || '')
    .replace(UNSAFE, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '') // no leading/trailing dots or spaces
    .slice(0, 120)
    .trim();
  if (!base) base = 'Untitled';
  let name = `${base}.md`;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base} ${n}.md`;
    n++;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * Write each note's markdown into `dir` as `<title>.md`. Returns the written
 * count plus one `{ noteId, title, relativePath, content }` record per file so
 * the caller can record the export mapping that folder reconciliation later
 * uses to recognise these files as this vault's notes (see vault-import.js).
 * `dir` needs `getFileHandle(name, {create:true})` -> handle with `createWritable()`.
 */
export async function exportVaultToDir(dir, notes) {
  const used = new Set();
  const files = [];
  for (const note of notes) {
    const name = vaultFileName(note.title, used);
    const content = note.content ?? '';
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    files.push({ noteId: note.id, title: note.title, relativePath: name, content });
  }
  return { written: files.length, files };
}

/** Count-only wrapper kept for existing callers and tests. */
export async function writeVaultToDir(dir, notes) {
  return (await exportVaultToDir(dir, notes)).written;
}

/**
 * App entry point for "Save all notes to a folder": write the live vault, then
 * record each written file as a prior export mapping so "Reconcile Markdown
 * folder" can recognise this vault's own files (Update or Unchanged) instead of
 * classifying every title match as a Conflict. Lives here, not in the app
 * shell, so the initial bundle stays inside its byte budget.
 */
export async function saveVaultToFolder(dir, db) {
  const { folderMappingsAfterExport } = await import('./vault-import.js');
  await db.flushCurrentWrites();
  const { written, files } = await exportVaultToDir(dir, db.getAllNotes());
  db.setConfig({ folderMappings: await folderMappingsAfterExport(db.config.folderMappings, files) });
  return written;
}
