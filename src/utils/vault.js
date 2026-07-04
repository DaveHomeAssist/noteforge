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
 * Write each note's markdown into `dir` as `<title>.md`. Returns the count written.
 * `dir` needs `getFileHandle(name, {create:true})` -> handle with `createWritable()`.
 */
export async function writeVaultToDir(dir, notes) {
  const used = new Set();
  let written = 0;
  for (const note of notes) {
    const name = vaultFileName(note.title, used);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(note.content ?? '');
    await writable.close();
    written++;
  }
  return written;
}
