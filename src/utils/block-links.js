import { parse, serialize } from './blocks.js';

export const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TYPES = new Set(['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'quote']);

export const isValidBlockId = (value) => BLOCK_ID_RE.test(String(value ?? ''));
export const blockSupportsId = (block) => TYPES.has(block?.type);

export function blockToMarkdown(block, { includeBlockId = true } = {}) {
  const copy = includeBlockId ? block : { ...block, meta: { ...(block?.meta || {}), blockId: null } };
  return serialize([copy]);
}

export function resolveBlockId(markdown, requestedId) {
  const id = String(requestedId ?? '').replace(/^\^/, '');
  if (!isValidBlockId(id)) return { status: 'invalid', id, block: null, matches: [] };
  const matches = parse(markdown).filter((block) => block.meta?.blockId === id);
  return matches.length === 1
    ? { status: 'resolved', id, block: matches[0], matches }
    : { status: matches.length ? 'duplicate' : 'missing', id, block: null, matches };
}

export function inspectBlockIds(markdown) {
  const occurrences = [];
  const byId = new Map();
  parse(markdown).forEach((block, index) => {
    const id = block.meta?.blockId;
    if (!id) return;
    const entry = Object.freeze({ id, index, type: block.type, text: block.text });
    occurrences.push(entry);
    byId.set(id, [...(byId.get(id) || []), entry]);
  });
  return {
    occurrences,
    duplicates: [...byId].filter(([, entries]) => entries.length > 1)
      .map(([id, entries]) => Object.freeze({ id, entries: Object.freeze(entries) })),
  };
}
