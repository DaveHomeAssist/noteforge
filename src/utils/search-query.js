// Pure scoped-search parsing + note ranking. Supports free text plus filter
// tokens: `tag:<name>` (repeatable), `in:title`, `has:banner`, `is:pinned`.
// Unknown `word:word` tokens are treated as plain text so the box never eats a
// query. No DOM dependency — unit-testable in Node.

import { fuzzyMatch } from './fuzzy.js';

const FILTER_RE = /(?:^|\s)(tag|in|has|is):([^\s]+)/gi;

/**
 * @param {string} raw
 * @returns {{ text:string, filters:{ tags:string[], inTitle:boolean, hasBanner:boolean|null, pinned:boolean|null } }}
 */
export function parseQuery(raw) {
  const filters = { tags: [], inTitle: false, hasBanner: null, pinned: null };
  let text = String(raw ?? '');
  text = text.replace(FILTER_RE, (match, key, val) => {
    const k = key.toLowerCase();
    const v = val.toLowerCase();
    if (k === 'tag') filters.tags.push(v);
    else if (k === 'in' && v === 'title') filters.inTitle = true;
    else if (k === 'has' && v === 'banner') filters.hasBanner = true;
    else if (k === 'is' && v === 'pinned') filters.pinned = true;
    else return match; // unknown filter — leave it as searchable text
    return ' ';
  });
  return { text: text.trim().replace(/\s+/g, ' '), filters };
}

/** Does a note satisfy the structural filters (independent of the free text)? */
export function noteMatchesFilters(note, filters) {
  if (filters.tags.length) {
    const lc = note.tags.map((t) => t.toLowerCase());
    if (!filters.tags.every((t) => lc.includes(t))) return false;
  }
  if (filters.hasBanner === true && !note.banner) return false;
  if (filters.pinned === true && !note.pinned) return false;
  return true;
}

/**
 * Score a single note against free text. Title matches (fuzzy) outrank body
 * matches (substring). Returns null when there's no match.
 * @returns {{ score:number, titlePositions:number[] } | null}
 */
export function scoreNote(text, note, { inTitle = false } = {}) {
  const q = text.trim();
  if (!q) return { score: 0, titlePositions: [] };

  const titleM = fuzzyMatch(q, note.title || '');
  let score = titleM ? titleM.score + 100 : null;

  if (!inTitle) {
    const ql = q.toLowerCase();
    const bodyIdx = (note.content || '').toLowerCase().indexOf(ql);
    if (bodyIdx !== -1) {
      const bodyScore = 30 - Math.min(20, bodyIdx * 0.002);
      score = Math.max(score ?? -Infinity, bodyScore);
    }
    const tagHit = note.tags.some((t) => t.toLowerCase().includes(ql));
    if (tagHit) score = Math.max(score ?? -Infinity, 25);
  }

  if (score === null) return null;
  return { score, titlePositions: titleM ? titleM.positions : [] };
}

/**
 * Filter + rank notes for a raw query. Results are sorted by relevance, then by
 * most-recently-updated. When the query is empty, returns the filtered notes
 * unranked (caller decides ordering).
 * @returns {{ note:object, score:number, titlePositions:number[] }[]}
 */
export function rankNotes(raw, notes) {
  const { text, filters } = parseQuery(raw);
  const out = [];
  for (const note of notes) {
    if (!noteMatchesFilters(note, filters)) continue;
    const scored = scoreNote(text, note, { inTitle: filters.inTitle });
    if (!scored) continue;
    out.push({ note, score: scored.score, titlePositions: scored.titlePositions });
  }
  if (text.trim()) {
    out.sort((a, b) => b.score - a.score || new Date(b.note.updatedAt) - new Date(a.note.updatedAt));
  }
  return out;
}
