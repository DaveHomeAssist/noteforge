/** Recognize a byte-zero leading YAML document without loading the YAML parser. */
export function splitFrontmatterSource(markdown) {
  const source = String(markdown ?? '');
  const firstBreak = source.indexOf('\n');
  if (firstBreak < 0 || source.slice(0, firstBreak).replace(/\r$/, '') !== '---') return none(source);
  let lineStart = firstBreak + 1;
  while (lineStart <= source.length) {
    const nextBreak = source.indexOf('\n', lineStart);
    const lineEnd = nextBreak < 0 ? source.length : nextBreak;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line === '---' || line === '...') {
      const rawEnd = lineEnd - (source[lineEnd - 1] === '\r' ? 1 : 0);
      const bodyStart = nextBreak < 0 ? source.length : nextBreak + 1;
      return Object.freeze({
        hasFrontmatter: true, source, raw: source.slice(0, rawEnd),
        yaml: source.slice(firstBreak + 1, lineStart), body: source.slice(bodyStart), bodyStart,
        separator: nextBreak < 0 ? '' : source.slice(rawEnd, nextBreak + 1),
        newline: source.slice(3, firstBreak + 1) || '\n', closing: line,
      });
    }
    if (nextBreak < 0) break;
    lineStart = nextBreak + 1;
  }
  return none(source);
}

const none = (source) => Object.freeze({
  hasFrontmatter: false, source, raw: '', yaml: '', body: source, bodyStart: 0,
  separator: '', newline: source.includes('\r\n') ? '\r\n' : '\n', closing: null,
});
