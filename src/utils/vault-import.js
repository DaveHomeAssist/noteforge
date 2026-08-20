import { parseFrontmatter } from './frontmatter.js';
import { normalizeTitle } from './helpers.js';

export const VAULT_IMPORT_MAX_FILES = 1_000;
export const VAULT_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

export async function hashVaultSource(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable; folder reconciliation cannot verify source bytes.');
  const hash = await subtle.digest('SHA-256', encoder.encode(String(value ?? '')));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeVaultPath(value) {
  const source = String(value ?? '').replace(/\\/g, '/');
  if (!source || source.startsWith('/') || /^[A-Za-z]:\//.test(source) || source.includes('\0')) throw new TypeError('Folder paths must be safe relative paths.');
  const segments = source.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new TypeError('Folder paths cannot contain empty, current, or parent segments.');
  return segments.join('/');
}

const fileTitle = (path) => path.split('/').at(-1).replace(/\.md$/i, '').trim() || 'Untitled';
const validExternalId = (value) => typeof value === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/u.test(value.trim());
const mappingCandidates = (mappings, path, externalId) => {
  const values = Object.values(mappings && typeof mappings === 'object' ? mappings : {});
  return values.filter((entry) => entry && (externalId
    ? entry.externalId === externalId
    : entry.relativePath === path));
};
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function conflict(item, ...reasons) {
  return { ...item, status: 'Conflict', reasons: reasons.flat().filter(Boolean) };
}

/**
 * Build a deterministic, read-only reconciliation plan.
 * entries: [{relativePath,text,size?,read?}], notes: Note JSON, mappings: config.
 */
export async function planVaultImport(entries, notes, { mappings = {} } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('Folder entries must be an array.');
  if (entries.length > VAULT_IMPORT_MAX_FILES) throw new TypeError(`A folder scan is limited to ${VAULT_IMPORT_MAX_FILES} Markdown files.`);
  const normalized = [];
  for (const entry of entries) {
    const text = String(entry?.text ?? '');
    const actualBytes = encoder.encode(text).byteLength;
    const declaredBytes = Number(entry?.size);
    const tooLarge = actualBytes > VAULT_IMPORT_MAX_FILE_BYTES
      || (Number.isFinite(declaredBytes) && declaredBytes > VAULT_IMPORT_MAX_FILE_BYTES);
    let relativePath;
    try { relativePath = normalizeVaultPath(entry?.relativePath); } catch (error) {
      normalized.push({
        relativePath: String(entry?.relativePath || ''),
        text: tooLarge ? '' : text,
        pathError: [error.message, tooLarge ? `File exceeds ${VAULT_IMPORT_MAX_FILE_BYTES.toLocaleString()} bytes.` : ''].filter(Boolean).join(' '),
      });
      continue;
    }
    if (!/\.md$/i.test(relativePath)) continue;
    if (tooLarge) {
      normalized.push({ relativePath, text: '', pathError: `File exceeds ${VAULT_IMPORT_MAX_FILE_BYTES.toLocaleString()} bytes.` });
      continue;
    }
    normalized.push({ ...entry, relativePath, text });
  }

  const vault = Array.isArray(notes) ? notes : [];
  const noteById = new Map(vault.map((note) => [note.id, note]));
  const noteInfo = [];
  for (const note of vault) {
    const parsed = await parseFrontmatter(note.content);
    const value = parsed.status === 'valid' ? parsed.properties.get('noteforge_id') : null;
    noteInfo.push({ note, externalId: validExternalId(value) ? value.trim() : null, hash: await hashVaultSource(note.content) });
  }
  const files = [];
  for (const entry of normalized) {
    const sourceHash = await hashVaultSource(entry.text);
    const parsed = entry.pathError ? null : await parseFrontmatter(entry.text);
    const externalValue = parsed?.status === 'valid' ? parsed.properties.get('noteforge_id') : null;
    files.push({
      entry,
      sourceHash,
      parsed,
      externalId: validExternalId(externalValue) ? externalValue.trim() : null,
      invalidExternalId: externalValue !== undefined && externalValue !== null && !validExternalId(externalValue),
      title: fileTitle(entry.relativePath || ''),
    });
  }
  const externalIdCounts = new Map();
  const pathCounts = new Map();
  for (const file of files) {
    if (file.externalId) externalIdCounts.set(file.externalId, (externalIdCounts.get(file.externalId) || 0) + 1);
    pathCounts.set(file.entry.relativePath, (pathCounts.get(file.entry.relativePath) || 0) + 1);
  }
  const duplicateFileIds = new Set([...externalIdCounts].filter(([, count]) => count > 1).map(([id]) => id));

  const items = [];
  for (const file of files) {
    const base = {
      key: `${file.entry.relativePath}:${file.sourceHash}`,
      relativePath: file.entry.relativePath,
      title: file.title,
      externalId: file.externalId,
      destinationNoteId: null,
      sourceHash: file.sourceHash,
      destinationHash: null,
      source: file.entry.text,
      reasons: [],
    };
    if (file.entry.pathError) { items.push(conflict(base, file.entry.pathError)); continue; }
    if (pathCounts.get(file.entry.relativePath) > 1) { items.push(conflict(base, 'The selected folder contains the same normalized relative path more than once.')); continue; }
    if (file.parsed?.status === 'invalid') { items.push(conflict(base, file.parsed.diagnostics[0]?.message || 'Invalid YAML frontmatter.')); continue; }
    if (file.invalidExternalId) { items.push(conflict(base, 'noteforge_id must be a non-empty text value of at most 128 characters.')); continue; }
    if (file.externalId && duplicateFileIds.has(file.externalId)) { items.push(conflict(base, 'Duplicate noteforge_id in the selected folder.')); continue; }

    let candidates = [];
    if (file.externalId) {
      candidates = noteInfo.filter((info) => info.note.id === file.externalId || info.externalId === file.externalId);
      if (candidates.length > 1) { items.push(conflict(base, 'The stable ID maps to more than one vault note.')); continue; }
    }
    const priors = mappingCandidates(mappings, file.entry.relativePath, file.externalId);
    let prior = candidates.length === 1
      ? priors.find((entry) => entry.noteId === candidates[0].note.id) || null
      : null;
    if (!candidates.length && priors.length > 1) {
      items.push(conflict(base, 'More than one prior folder mapping matches this file.'));
      continue;
    }
    if (!candidates.length && priors.length === 1) {
      prior = priors[0];
      if (!file.externalId && prior.title && normalizeTitle(prior.title) !== normalizeTitle(file.title)) {
        items.push(conflict(base, 'The prior path mapping has a different title.'));
        continue;
      }
      if (!prior.noteId || !noteById.has(prior.noteId)) {
        items.push(conflict(base, 'The prior folder mapping points to a note that is no longer in the vault.'));
        continue;
      }
      candidates = [noteInfo.find((info) => info.note.id === prior.noteId)].filter(Boolean);
    }
    if (!candidates.length) {
      const titleMatches = noteInfo.filter((info) => normalizeTitle(info.note.title) === normalizeTitle(file.title));
      if (titleMatches.length) { items.push(conflict(base, 'Title/path identity is uncertain without a matching prior export mapping.')); continue; }
      const proposedHash = await hashVaultSource(`${file.entry.relativePath}\0${file.sourceHash}`);
      const proposedNoteId = `import-${proposedHash.slice(0, 20)}`;
      if (noteById.has(proposedNoteId)) { items.push(conflict(base, 'The deterministic imported note ID collides with an existing vault note.')); continue; }
      items.push({ ...base, status: 'Add', proposedNoteId, reasons: ['No existing stable identity matched.'] });
      continue;
    }

    const destination = candidates[0];
    const matched = { ...base, destinationNoteId: destination.note.id, destinationHash: destination.hash };
    if (destination.note.deletedAt) { items.push(conflict(matched, 'The stable identity belongs to a note in Trash. Restore it before reconciling.')); continue; }
    if (file.sourceHash === destination.hash) {
      items.push({ ...matched, status: 'Unchanged', reasons: [file.externalId ? 'Stable ID and Markdown match.' : 'Mapped path and Markdown match.'] });
      continue;
    }
    if (prior) {
      const sourceChanged = prior.sourceHash && prior.sourceHash !== file.sourceHash;
      const destinationChanged = (prior.destinationHash && prior.destinationHash !== destination.hash)
        || (prior.title && normalizeTitle(prior.title) !== normalizeTitle(destination.note.title));
      if (sourceChanged && destinationChanged) { items.push(conflict(matched, 'The file and vault note both changed since the previous mapping.')); continue; }
      if (!sourceChanged && destinationChanged) {
        items.push({ ...matched, status: 'Unchanged', reasons: ['Only the vault note changed; no external update will overwrite it.'] });
        continue;
      }
    }
    const titleCollision = noteInfo.some((info) => info.note.id !== destination.note.id && normalizeTitle(info.note.title) === normalizeTitle(file.title));
    if (titleCollision) { items.push(conflict(matched, 'The imported title collides with another vault identity.')); continue; }
    items.push({ ...matched, status: 'Update', reasons: [file.externalId ? 'Stable ID matched and Markdown differs.' : 'Prior path mapping matched and only the file changed.'] });
  }
  items.sort((left, right) => compareText(left.relativePath, right.relativePath) || compareText(left.key, right.key));
  return {
    version: 1,
    items,
    counts: Object.fromEntries(['Add', 'Update', 'Conflict', 'Unchanged'].map((status) => [status, items.filter((item) => item.status === status).length])),
  };
}

async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > VAULT_IMPORT_MAX_FILE_BYTES) throw new TypeError(`File exceeds ${VAULT_IMPORT_MAX_FILE_BYTES.toLocaleString()} bytes.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new TypeError('Markdown files must be encoded as UTF-8.', { cause: error });
  }
}

export async function readVaultFileList(fileList) {
  const files = [...(fileList || [])];
  if (files.length > VAULT_IMPORT_MAX_FILES) throw new TypeError(`A folder scan is limited to ${VAULT_IMPORT_MAX_FILES} files.`);
  const entries = [];
  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    if (!/\.md$/i.test(relativePath)) continue;
    entries.push({ relativePath, size: file.size, text: await decodeFile(file), read: () => decodeFile(file) });
  }
  return entries;
}

export async function readVaultDirectory(handle) {
  const entries = [];
  async function walk(directory, prefix = '') {
    for await (const [name, child] of directory.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'directory') await walk(child, relativePath);
      else if (/\.md$/i.test(name)) {
        if (entries.length >= VAULT_IMPORT_MAX_FILES) throw new TypeError(`A folder scan is limited to ${VAULT_IMPORT_MAX_FILES} Markdown files.`);
        const read = async () => decodeFile(await child.getFile());
        const file = await child.getFile();
        entries.push({ relativePath, size: file.size, text: await decodeFile(file), read });
      }
    }
  }
  await walk(handle);
  return entries;
}
