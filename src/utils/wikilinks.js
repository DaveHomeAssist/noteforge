// Source-aware, DOM-free wikilink and mention utilities. Every consumer uses
// these ranges so rendering, graph edges, backlinks, rename rewrites, and
// mention conversion agree about code/URL/escape exclusions.

import { normalizeTitle } from './helpers.js';
import { splitFrontmatterSource } from './frontmatter-boundary.js';

// Kept for the marked inline tokenizer. Anchored consumers should check index 0.
export const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/giu;

function escapedAt(source, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes += 1;
  return slashes % 2 === 1;
}

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

function rangeContains(ranges, index) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (index < range.start) high = mid - 1;
    else if (index >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}

/** Fenced code, inline code, and URL ranges that source transforms must skip. */
export function markdownExclusionRanges(markdown) {
  const source = String(markdown ?? '');
  const leading = splitFrontmatterSource(source);
  const ranges = leading.hasFrontmatter ? [{ start: 0, end: leading.bodyStart, kind: 'frontmatter' }] : [];
  const lines = source.split('\n');
  let offset = 0;
  let fence = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineEnd = offset + line.length + (lineIndex < lines.length - 1 ? 1 : 0);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = { start: offset, char: marker[1][0], length: marker[1].length };
      offset = lineEnd;
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        ranges.push({ start: fence.start, end: lineEnd, kind: 'fence' });
        fence = null;
      }
      offset = lineEnd;
      continue;
    }
    {
      URL_RE.lastIndex = 0;
      let match;
      while ((match = URL_RE.exec(line)) !== null) {
        ranges.push({ start: offset + match.index, end: offset + match.index + match[0].length, kind: 'url' });
      }
    }
    offset = lineEnd;
  }
  if (fence) ranges.push({ start: fence.start, end: source.length, kind: 'fence' });
  const fenced = mergeRanges(ranges.filter((range) => range.kind === 'fence'));
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] !== '`' || escapedAt(source, cursor) || rangeContains(fenced, cursor)) {
      cursor += 1;
      continue;
    }
    let run = 1;
    while (source[cursor + run] === '`') run += 1;
    const delimiter = '`'.repeat(run);
    let close = source.indexOf(delimiter, cursor + run);
    while (close >= 0) {
      if (rangeContains(fenced, close)) {
        const enclosing = fenced.find((range) => close >= range.start && close < range.end);
        close = source.indexOf(delimiter, enclosing?.end ?? close + run);
        continue;
      }
      if (source[close - 1] === '`' || source[close + run] === '`') {
        close = source.indexOf(delimiter, close + 1);
        continue;
      }
      break;
    }
    if (close < 0) { cursor += run; continue; }
    ranges.push({ start: cursor, end: close + run, kind: 'inline-code' });
    cursor = close + run;
  }
  return mergeRanges(ranges);
}

function splitTarget(rawTarget) {
  const hash = rawTarget.indexOf('#');
  const titlePart = hash < 0 ? rawTarget : rawTarget.slice(0, hash);
  const fragmentRaw = hash < 0 ? null : rawTarget.slice(hash + 1);
  const leading = titlePart.length - titlePart.trimStart().length;
  const trailing = titlePart.length - titlePart.trimEnd().length;
  return {
    target: titlePart.trim(),
    fragment: fragmentRaw === null ? null : fragmentRaw.trim(),
    fragmentRaw,
    leading,
    trailing,
  };
}

/**
 * Ordered source tokens for normal/display/fragment/embed links. Ranges are
 * half-open UTF-16 offsets, matching String.slice and contenteditable text.
 */
export function parseWikilinks(markdown) {
  const source = String(markdown ?? '');
  const excluded = markdownExclusionRanges(source);
  const tokens = [];
  let open = source.indexOf('[[', 0);
  while (open >= 0) {
    if (escapedAt(source, open) || rangeContains(excluded, open)) {
      open = source.indexOf('[[', open + 2);
      continue;
    }
    const embedded = open > 0 && source[open - 1] === '!' && !escapedAt(source, open - 1);
    const start = embedded ? open - 1 : open;
    if (embedded && rangeContains(excluded, start)) {
      open = source.indexOf('[[', open + 2);
      continue;
    }
    const close = source.indexOf(']]', open + 2);
    if (close < 0) break;
    const body = source.slice(open + 2, close);
    if (body.includes('\n')) {
      open = source.indexOf('[[', close + 2);
      continue;
    }
    const pipe = body.indexOf('|');
    const rawTarget = pipe < 0 ? body : body.slice(0, pipe);
    const displayRaw = pipe < 0 ? null : body.slice(pipe + 1);
    const parsed = splitTarget(rawTarget);
    if (!parsed.target || parsed.target.includes('[') || parsed.target.includes(']')) {
      open = source.indexOf('[[', close + 2);
      continue;
    }
    const bodyStart = open + 2;
    const targetStart = bodyStart + parsed.leading;
    const hash = rawTarget.indexOf('#');
    const titlePartLength = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).length;
    const targetEnd = bodyStart + titlePartLength - parsed.trailing;
    tokens.push(Object.freeze({
      start,
      end: close + 2,
      targetStart,
      targetEnd,
      target: parsed.target,
      display: displayRaw === null ? null : displayRaw.trim(),
      displayRaw,
      fragment: parsed.fragment,
      fragmentRaw: parsed.fragmentRaw,
      embedded,
      raw: source.slice(start, close + 2),
    }));
    open = source.indexOf('[[', close + 2);
  }
  return tokens;
}

/** Distinct base targets, in first source order. */
export function extractWikilinks(content) {
  const seen = new Set();
  const targets = [];
  for (const token of parseWikilinks(content)) {
    const key = normalizeTitle(token.target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push(token.target);
  }
  return targets;
}

/** Rewrite only each selected token's canonical-title bytes. */
export function rewriteWikilinkTargets(content, shouldRewrite, newTitle) {
  const source = String(content ?? '');
  const edits = parseWikilinks(source)
    .filter((token) => shouldRewrite(token))
    .map((token) => ({ start: token.targetStart, end: token.targetEnd, text: String(newTitle) }));
  let result = source;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { content: result, edits };
}
