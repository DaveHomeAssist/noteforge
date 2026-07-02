// Pure fuzzy subsequence matcher + scorer for quick-open / command palette.
// No DOM dependency, so it's unit-testable in Node. `fuzzyMatch` returns null
// when `query` is not a subsequence of `text`; otherwise a score (higher is a
// better match) plus the matched character indices for highlighting.

import { escapeHtml } from './helpers.js';

const BOUNDARY = /[\s\-_/.,:;()[\]{}]/;

/**
 * @param {string} query
 * @param {string} text
 * @returns {{ score:number, positions:number[] } | null}
 */
export function fuzzyMatch(query, text) {
  const t = String(text ?? '');
  const q = String(query ?? '');
  if (!q) return { score: 0, positions: [] };
  const ql = q.toLowerCase();
  const tl = t.toLowerCase();
  if (ql.length > tl.length) return null;

  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  let run = 0;

  for (let qi = 0; qi < ql.length; qi++) {
    const ch = ql[qi];
    let found = -1;
    for (let i = ti; i < tl.length; i++) {
      if (tl[i] === ch) { found = i; break; }
    }
    if (found === -1) return null; // not a subsequence

    positions.push(found);
    let charScore = 1;
    if (found === prev + 1) { run += 1; charScore += run * 5; } // consecutive run
    else run = 0;

    const before = found > 0 ? t[found - 1] : '';
    if (found === 0) charScore += 10; // start of string
    else if (BOUNDARY.test(before)) charScore += 8; // start of a word
    else if (before === before.toLowerCase() && t[found] !== t[found].toLowerCase()) charScore += 5; // camelCase hump

    charScore += Math.max(0, 4 - found * 0.1); // earlier is better
    score += charScore;
    prev = found;
    ti = found + 1;
  }

  // Prefer tighter matches: fewer unmatched trailing characters.
  score += Math.max(0, 12 - (t.length - q.length) * 0.15);
  return { score, positions };
}

/**
 * Escape `text` and wrap the characters at `positions` in <mark>. Safe HTML.
 * @param {string} text
 * @param {number[]} positions  sorted, ascending indices into `text`
 */
export function fuzzyHighlight(text, positions) {
  const t = String(text ?? '');
  if (!positions || positions.length === 0) return escapeHtml(t);
  const mark = new Set(positions);
  let out = '';
  let open = false;
  for (let i = 0; i < t.length; i++) {
    const hit = mark.has(i);
    if (hit && !open) { out += '<mark>'; open = true; }
    else if (!hit && open) { out += '</mark>'; open = false; }
    out += escapeHtml(t[i]);
  }
  if (open) out += '</mark>';
  return out;
}
