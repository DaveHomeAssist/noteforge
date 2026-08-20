// Markdown rendering with Obsidian-style [[wikilinks]].
//
// - `marked` handles standard markdown (headings, lists, code, tasks, tables…).
// - A custom inline extension turns [[Target]] / [[Target|alias]] into anchors
//   carrying a `data-wikilink` attribute, styled differently when the target
//   note does not exist yet.
// - DOMPurify sanitizes the final HTML so note content can never inject script.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml, escapeAttr, normalizeTitle } from './helpers.js';
import { parseWikilinks, extractWikilinks } from './wikilinks.js';

// Re-export so existing importers of markdown.js keep working.
export { extractWikilinks };

// Titles that currently resolve to a real note (normalized). Updated by the app
// before each render so missing links can be styled/created on click.
let knownTitles = new Set();

export function setKnownTitles(titles) {
  knownTitles = new Set(Array.from(titles, normalizeTitle));
}

const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const link = src.indexOf('[[');
    if (link < 0) return undefined;
    return link > 0 && src[link - 1] === '!' ? link - 1 : link;
  },
  tokenizer(src) {
    const token = parseWikilinks(src)[0];
    if (token && token.start === 0) {
      return {
        type: 'wikilink',
        raw: token.raw,
        target: token.target,
        alias: token.display || `${token.target}${token.fragment ? `#${token.fragment}` : ''}`,
        fragment: token.fragment,
      };
    }
    return undefined;
  },
  renderer(token) {
    const exists = knownTitles.has(normalizeTitle(token.target));
    const cls = exists ? 'wikilink' : 'wikilink wikilink--missing';
    return (
      `<a href="#" class="${cls}" data-wikilink="${escapeAttr(token.target)}"${token.fragment ? ` data-fragment="${escapeAttr(token.fragment)}"` : ''}>` +
      `${escapeHtml(token.alias)}</a>`
    );
  },
};

marked.use({
  gfm: true,
  breaks: true,
  extensions: [wikilinkExtension],
});

// Keep wikilink + task-list attributes through sanitization.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('data-wikilink') !== null) {
    node.setAttribute('href', '#');
  }
  // Open real external links in a new tab, safely.
  if (node.tagName === 'A' && /^https?:\/\//i.test(node.getAttribute('href') || '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CONFIG = {
  // Allow collapsible <details>/<summary> (with the `open` state) so toggle
  // blocks render as native disclosure widgets. Everything else is sanitized.
  ADD_TAGS: ['details', 'summary'],
  ADD_ATTR: ['data-wikilink', 'data-fragment', 'target', 'rel', 'open'],
};

/** Render markdown (with wikilinks) to sanitized HTML. */
export function renderMarkdown(md) {
  const raw = marked.parse(md || '');
  return DOMPurify.sanitize(raw, PURIFY_CONFIG);
}

const BLOCK_WRAPPERS = /^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE)$/;

/**
 * Render a single block's inline markdown to sanitized HTML, stripping the
 * single outer block element that `marked` adds (so the caller's own row
 * element supplies the block semantics). Falls back to the full rendered HTML
 * when the result isn't a lone block wrapper (e.g. a table in a raw block).
 * Reuses the same marked + wikilink + DOMPurify pipeline — no new HTML paths.
 */
export function renderInline(md) {
  const html = renderMarkdown(md);
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const kids = tpl.content.children;
  if (kids.length === 1 && BLOCK_WRAPPERS.test(kids[0].tagName)) {
    return kids[0].innerHTML;
  }
  return html;
}

/** First non-empty line, stripped of markdown heading syntax — a title guess. */
export function deriveTitle(content) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').slice(0, 120);
}
