// Contextual backlink and unlinked-mention analysis. This deliberately lives
// outside the core wikilink tokenizer so the larger derived index can load
// after the first usable note while the editor's link rendering stays eager.

import { normalizeTitle } from './helpers.js';
import { extractHeadings, headingContextAt } from './headings.js';
import { markdownExclusionRanges, parseWikilinks } from './wikilinks.js';

const WORD_RE = /[\p{L}\p{N}_]/u;

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** Heading-aware, plain-text context for a parsed link or mention occurrence. */
export function occurrenceContext(content, start, end) {
  const source = String(content ?? '');
  const heading = headingContextAt(extractHeadings(source), start);
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = source.indexOf('\n', end);
  const lineEnd = nextBreak < 0 ? source.length : nextBreak;
  let snippet = source.slice(lineStart, lineEnd)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (snippet.length > 180) snippet = snippet.slice(0, 177).trimEnd() + '…';
  return {
    heading: heading?.text ?? null,
    headingAnchor: heading?.anchor ?? null,
    snippet,
  };
}

function rangeOverlaps(ranges, start, end) {
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) return false;
    return true;
  }
  return false;
}

function normalizedSourceEntries(source) {
  const entries = [];
  const segmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  const segments = segmenter
    ? [...segmenter.segment(source)].map((entry) => ({ segment: entry.segment, index: entry.index }))
    : [...source].reduce((result, segment) => {
      const previous = result[result.length - 1];
      if (/^\p{M}$/u.test(segment) && previous) previous.segment += segment;
      else result.push({ segment, index: previous ? previous.index + previous.segment.length : 0 });
      return result;
    }, []);
  for (const item of segments) {
    const originalEnd = item.index + item.segment.length;
    const normalized = item.segment.normalize('NFKC').toLowerCase();
    for (const char of normalized) {
      if (/\s/u.test(char)) {
        const previous = entries[entries.length - 1];
        if (previous?.char === ' ') previous.end = originalEnd;
        else entries.push({ char: ' ', start: item.index, end: originalEnd });
      } else {
        entries.push({ char, start: item.index, end: originalEnd });
      }
    }
  }
  return entries;
}

/**
 * Find visible, unlinked occurrences of unique canonical/alias names.
 * `candidates` entries are { name, targetId, targetTitle } and must already
 * reflect canonical-first/unique-alias resolution.
 */
export function createMentionScanner(candidates) {
  const byKey = new Map();
  for (const candidate of candidates || []) {
    const key = normalizeTitle(candidate?.name);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, candidate);
  }
  if (!byKey.size) return () => [];
  const root = { children: new Map(), candidate: null };
  for (const [key, candidate] of byKey) {
    let node = root;
    for (const char of key) {
      if (!node.children.has(char)) node.children.set(char, { children: new Map(), candidate: null });
      node = node.children.get(char);
    }
    node.candidate = candidate;
  }
  return (content, { sourceId = null } = {}) => {
    const source = String(content ?? '');
    const excluded = mergeRanges([
      ...markdownExclusionRanges(source),
      ...parseWikilinks(source).map((token) => ({ start: token.start, end: token.end, kind: 'wikilink' })),
    ]);
    const results = [];
    const normalized = normalizedSourceEntries(source);
    for (let index = 0; index < normalized.length;) {
      let node = root;
      let cursor = index;
      let best = null;
      while (cursor < normalized.length && node.children.has(normalized[cursor].char)) {
        node = node.children.get(normalized[cursor].char);
        cursor += 1;
        if (node.candidate && node.candidate.targetId !== sourceId) best = { candidate: node.candidate, end: cursor };
      }
      if (!best) { index += 1; continue; }
      const start = normalized[index].start;
      const end = normalized[best.end - 1].end;
      const before = normalized[index - 1]?.char || '';
      const after = normalized[best.end]?.char || '';
      if (rangeOverlaps(excluded, start, end) || WORD_RE.test(before) || WORD_RE.test(after)) {
        index += 1;
        continue;
      }
      const candidate = best.candidate;
      results.push(Object.freeze({
        start,
        end,
        text: source.slice(start, end),
        targetId: candidate.targetId,
        targetTitle: candidate.targetTitle,
        ...occurrenceContext(source, start, end),
      }));
      index = best.end;
    }
    return results;
  };
}

export function findUnlinkedMentions(content, candidates, options = {}) {
  return createMentionScanner(candidates)(content, options);
}

export function buildMentionReplacement(mention) {
  const sameDisplay = String(mention.text) === String(mention.targetTitle);
  return `[[${mention.targetTitle}${sameDisplay ? '' : `|${mention.text}`}]]`;
}
