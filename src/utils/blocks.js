// Pure markdown <-> block-model bridge. This is the ONLY code that reads/writes
// note.content, so the rest of the app (backlinks, search, graph, export) keeps
// treating content as a markdown string.
//
// A block is a flat record: { id, type, text, meta }. There is no tree — list
// nesting is expressed by meta.indent. Anything the classifier can't model as a
// first-class block (tables, HTML, deep headings) is preserved verbatim in a
// `raw` block, so round-trip is lossless.
//
// Invariants (see blocks.test in smoke): parse(serialize(b)) deep-equals b, and
// serialize(parse(md)) is a fixed point.

import { uid } from './helpers.js';

export const LIST_TYPES = new Set(['bullet', 'numbered', 'todo']);

export function makeBlock(type, text = '', meta = {}) {
  return { id: uid(), type, text, meta };
}

const RE = {
  fence: /^```(.*)$/,
  detailsOpen: /^<details(?:\s[^>]*)?>\s*$/i,
  divider: /^(?:---|\*\*\*|___)\s*$/,
  date: /^@date\((\d{4}-\d{2}-\d{2})\)\s*$/,
  // A line that is solely an image becomes a block-level image (alt has no `]`,
  // src no whitespace/`)` — the common case; anything fancier stays a paragraph).
  image: /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/,
  heading: /^(#{1,6})\s+(.*)$/,
  todo: /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/,
  bullet: /^(\s*)[-*]\s+(.*)$/,
  numbered: /^(\s*)(\d+)\.\s+(.*)$/,
  quote: /^>\s?(.*)$/,
  html: /^\s*<[a-zA-Z!/]/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
};

const indentOf = (spaces) => Math.floor(spaces.replace(/\t/g, '  ').length / 2);

/**
 * Split one GFM table row into trimmed cell strings. Decodes backslash escapes
 * symmetrically with escCell: `\|` -> `|` and `\\` -> `\` (a lone backslash before
 * anything else stays literal, per CommonMark). Cell boundaries are unescaped `|`;
 * a leading/trailing border pipe is dropped without eating a cell that legitimately
 * ends in a literal backslash. Without the `\\` decode the round-trip is not
 * invertible — a cell containing a backslash would double it on every save.
 */
function splitTableRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let closedAtPipe = false; // the last char processed was an unescaped cell boundary
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && (s[k + 1] === '|' || s[k + 1] === '\\')) { cur += s[k + 1]; k++; closedAtPipe = false; }
    else if (ch === '\\') { cur += '\\'; closedAtPipe = false; }
    else if (ch === '|') { cells.push(cur); cur = ''; closedAtPipe = true; }
    else { cur += ch; closedAtPipe = false; }
  }
  cells.push(cur);
  if (cells.length > 1 && s.startsWith('|')) cells.shift(); // leading border pipe
  if (cells.length > 1 && closedAtPipe) cells.pop(); // trailing border pipe (only if unescaped)
  return cells.map((c) => c.trim());
}

/** Column alignment from a separator cell (`:--` left, `:-:` center, `--:` right). */
function alignOf(cell) {
  const c = cell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
}

const escCell = (c) => String(c ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const alignSep = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');

/** Markdown string -> Block[]. Always returns at least one block. */
export function parse(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let para = null; // buffer for consecutive plain lines

  // A blank line between two same-family list items is a real boundary (two
  // separate lists). We record it as meta.blankBefore so serialize() can re-emit
  // the blank line and numberedLabels() can restart numbering — otherwise the
  // two lists silently fuse.
  let sawBlank = false;
  const push = (b) => {
    if (sawBlank && LIST_TYPES.has(b.type)) {
      const last = blocks[blocks.length - 1];
      if (last && LIST_TYPES.has(last.type)) b.meta = { ...b.meta, blankBefore: true };
    }
    blocks.push(b);
    sawBlank = false;
  };

  const flushPara = () => {
    if (para !== null) {
      push(makeBlock('paragraph', para));
      para = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // blank line -> paragraph / list-group boundary
    if (line.trim() === '') {
      flushPara();
      sawBlank = true;
      i++;
      continue;
    }

    // fenced code block
    const fence = RE.fence.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // consume closing fence
      push(makeBlock('code', body.join('\n'), { lang }));
      continue;
    }

    // Collapsible toggle: consume a whole <details>…</details> into one raw block
    // (otherwise each HTML line would fragment). It round-trips verbatim and
    // renders as a native disclosure widget when blurred. Nesting depth is tracked
    // so a *nested* toggle closes on its OWN </details>, not the first one; fenced
    // code blocks are skipped so a literal </details> inside ``` doesn't close early.
    if (RE.detailsOpen.test(line.trim())) {
      flushPara();
      const buf = [line];
      i++;
      let depth = 1;
      while (i < lines.length && depth > 0) {
        if (RE.fence.test(lines[i])) { // consume a fenced code block verbatim
          buf.push(lines[i++]);
          while (i < lines.length && !RE.fence.test(lines[i])) buf.push(lines[i++]);
          if (i < lines.length) buf.push(lines[i++]); // closing fence
          continue;
        }
        if (RE.detailsOpen.test(lines[i].trim())) depth++;
        else if (/^\s*<\/details>\s*$/i.test(lines[i])) depth--;
        buf.push(lines[i++]);
      }
      push(makeBlock('raw', buf.join('\n')));
      continue;
    }

    // GFM table -> first-class table block (header + separator + body rows).
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(splitTableRow(lines[i++]));
      }
      const cols = Math.max(header.length, align.length, ...body.map((r) => r.length), 1);
      const pad = (r) => { const a = r.slice(0, cols); while (a.length < cols) a.push(''); return a; };
      const rows = [pad(header), ...body.map(pad)];
      const alignN = pad(align.map((a) => (a === 'center' || a === 'right' || a === 'left' ? a : ''))).map((a) => a || '');
      push(makeBlock('table', '', { rows, align: alignN }));
      continue;
    }

    // divider
    if (RE.divider.test(line)) {
      flushPara();
      push(makeBlock('divider', ''));
      i++;
      continue;
    }

    // date block — @date(YYYY-MM-DD) on its own line
    const dm = RE.date.exec(line);
    if (dm) {
      flushPara();
      push(makeBlock('date', '', { date: dm[1] }));
      i++;
      continue;
    }

    // image block — a line that is only ![alt](src)
    const im = RE.image.exec(line);
    if (im) {
      flushPara();
      push(makeBlock('image', '', { alt: im[1], src: im[2] }));
      i++;
      continue;
    }

    // heading (levels 1-3 first-class; 4-6 preserved as raw to avoid loss)
    const h = RE.heading.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      if (level <= 3) push(makeBlock('heading', h[2], { level }));
      else push(makeBlock('raw', line));
      i++;
      continue;
    }

    // todo (before bullet, since it is a bullet with a [ ] marker)
    const todo = RE.todo.exec(line);
    if (todo) {
      flushPara();
      push(
        makeBlock('todo', todo[3], {
          indent: indentOf(todo[1]),
          checked: todo[2].toLowerCase() === 'x',
        })
      );
      i++;
      continue;
    }

    const bullet = RE.bullet.exec(line);
    if (bullet) {
      flushPara();
      push(makeBlock('bullet', bullet[2], { indent: indentOf(bullet[1]) }));
      i++;
      continue;
    }

    const num = RE.numbered.exec(line);
    if (num) {
      flushPara();
      push(makeBlock('numbered', num[3], { indent: indentOf(num[1]) }));
      i++;
      continue;
    }

    // blockquote — merge consecutive `>` lines into one block
    if (RE.quote.test(line)) {
      flushPara();
      const qs = [];
      while (i < lines.length && RE.quote.test(lines[i])) {
        qs.push(RE.quote.exec(lines[i])[1]);
        i++;
      }
      push(makeBlock('quote', qs.join('\n')));
      continue;
    }

    // raw HTML line
    if (RE.html.test(line)) {
      flushPara();
      push(makeBlock('raw', line));
      i++;
      continue;
    }

    // plain text -> accumulate into a paragraph (soft breaks preserved)
    para = para === null ? line : para + '\n' + line;
    i++;
  }
  flushPara();

  if (blocks.length === 0) blocks.push(makeBlock('paragraph', ''));
  return blocks;
}

/**
 * Sequential label for each numbered block: a run resets whenever the
 * immediately-preceding block isn't a numbered block at the same indent. The
 * editor uses the same helper so on-screen numbers match what gets serialized.
 * @returns {Map<string, number>} block.id -> displayed number
 */
export function numberedLabels(blocks) {
  const nums = new Map();
  let prev = null;
  let count = 0;
  for (const b of blocks) {
    if (b.type === 'numbered') {
      const indent = b.meta?.indent || 0;
      const contiguous =
        prev && prev.type === 'numbered' && (prev.meta?.indent || 0) === indent && !b.meta?.blankBefore;
      count = contiguous ? count + 1 : 1;
      nums.set(b.id, count);
    } else {
      count = 0;
    }
    prev = b;
  }
  return nums;
}

/** Block[] -> markdown string. */
export function serialize(blocks) {
  const numbers = numberedLabels(blocks);
  const parts = blocks.map((block) => renderBlockToMd(block, numbers));

  // Join with blank lines, except keep adjacent list items contiguous so tight
  // lists survive the round-trip (two paragraphs must stay separated or they
  // merge on re-parse).
  let out = '';
  blocks.forEach((block, idx) => {
    if (idx > 0) {
      const prev = blocks[idx - 1];
      const tightList =
        LIST_TYPES.has(prev.type) && LIST_TYPES.has(block.type) && !block.meta?.blankBefore;
      out += tightList ? '\n' : '\n\n';
    }
    out += parts[idx];
  });
  return out;
}

function renderBlockToMd(block, numbers) {
  const indent = '  '.repeat(block.meta?.indent || 0);
  switch (block.type) {
    case 'heading':
      return '#'.repeat(block.meta?.level || 1) + ' ' + block.text;
    case 'bullet':
      return indent + '- ' + block.text;
    case 'numbered':
      return indent + (numbers.get(block.id) || 1) + '. ' + block.text;
    case 'todo':
      return indent + (block.meta?.checked ? '- [x] ' : '- [ ] ') + block.text;
    case 'quote':
      return block.text
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n');
    case 'code':
      return '```' + (block.meta?.lang || '') + '\n' + block.text + '\n```';
    case 'divider':
      return '---';
    case 'date':
      return `@date(${block.meta?.date || ''})`;
    case 'image':
      return `![${block.meta?.alt || ''}](${block.meta?.src || ''})`;
    case 'table': {
      const rows = Array.isArray(block.meta?.rows) && block.meta.rows.length ? block.meta.rows : [['']];
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const align = block.meta?.align || [];
      const line = (cells) => '| ' + Array.from({ length: cols }, (_, c) => escCell(cells[c] ?? '')).join(' | ') + ' |';
      const sep = '| ' + Array.from({ length: cols }, (_, c) => alignSep(align[c])).join(' | ') + ' |';
      return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
    }
    case 'raw':
      return block.text;
    case 'paragraph':
    default:
      return block.text;
  }
}
