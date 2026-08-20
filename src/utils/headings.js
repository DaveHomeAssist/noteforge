// Pure heading extraction and deterministic occurrence-aware anchors.

import { normalizeTitle } from './helpers.js';

function visibleHeadingText(raw) {
  return String(raw ?? '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, target, display) => display || target)
    .replace(/[*_`~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

export function headingSlug(text) {
  const slug = visibleHeadingText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function nextHeadingAnchor(text, counts) {
  const base = headingSlug(text);
  const occurrence = (counts.get(base) || 0) + 1;
  counts.set(base, occurrence);
  return `heading-${base}${occurrence === 1 ? '' : `-${occurrence}`}`;
}

export function extractHeadings(markdown) {
  const source = String(markdown ?? '');
  const lines = source.split('\n');
  const headings = [];
  const counts = new Map();
  let offset = 0;
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = { char: marker[1][0], length: marker[1].length };
    } else if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    } else {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (match) {
        const text = visibleHeadingText(match[2]);
        headings.push(Object.freeze({
          level: match[1].length,
          text,
          rawText: match[2],
          anchor: nextHeadingAnchor(text, counts),
          start: offset,
          end: offset + line.length,
          line: index + 1,
        }));
      }
    }
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
  }
  return headings;
}

export function headingContextAt(headings, offset) {
  let context = null;
  for (const heading of headings || []) {
    if (heading.start > offset) break;
    context = heading;
  }
  return context;
}

export function resolveHeadingAnchor(headings, fragment) {
  const raw = String(fragment ?? '').trim().replace(/^#/, '');
  if (!raw || raw.startsWith('^')) return null;
  const key = normalizeTitle(raw);
  return (headings || []).find((heading) => (
    normalizeTitle(heading.text) === key
    || normalizeTitle(heading.anchor.replace(/^heading-/, '')) === key
  ))?.anchor ?? null;
}
