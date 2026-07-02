// Pure, DOM-free wikilink parsing. Lives apart from markdown.js (which pulls in
// marked + DOMPurify) so the data layer — Note, Database backlinks/graph — can
// extract links without depending on the browser renderer. Also unit-testable
// in plain Node.

export const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

/**
 * Extract the distinct wikilink targets referenced in `content`, in order of
 * first appearance (case-insensitive de-dup, preserving first-seen casing).
 */
export function extractWikilinks(content) {
  const re = new RegExp(WIKILINK_RE.source, 'g');
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(content || '')) !== null) {
    const target = m[1].trim();
    const key = target.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}
