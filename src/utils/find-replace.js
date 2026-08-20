const WORD_BEFORE = /[\p{L}\p{N}_]$/u;
const WORD_AFTER = /^[\p{L}\p{N}_]/u;

function escapedLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ordered UTF-16 source ranges for a literal query. */
export function findLiteralMatches(source, query, { caseSensitive = false, wholeWord = false } = {}) {
  const text = String(source ?? '');
  const needle = String(query ?? '');
  if (!needle) return [];
  const expression = new RegExp(escapedLiteral(needle), caseSensitive ? 'gu' : 'giu');
  const matches = [];
  let match;
  while ((match = expression.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!wholeWord || (!WORD_BEFORE.test(text.slice(0, start)) && !WORD_AFTER.test(text.slice(end)))) {
      matches.push(Object.freeze({ start, end, text: match[0] }));
    }
    if (expression.lastIndex === match.index) expression.lastIndex += 1;
  }
  return matches;
}

/** Replace literal ranges from the end so `$&`, backslashes, and Markdown stay literal. */
export function replaceLiteral(source, query, replacement, options = {}) {
  const text = String(source ?? '');
  const matches = findLiteralMatches(text, query, options);
  let result = text;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    result = result.slice(0, match.start) + String(replacement ?? '') + result.slice(match.end);
  }
  return { source: text, result, matches, count: matches.length, changed: result !== text };
}
