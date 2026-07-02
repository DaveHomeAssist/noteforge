// Notion-style block editor. Owns the `.editor__blocks` canvas: one
// contenteditable row per block. The block being edited shows RAW markdown
// (a single flat text node — trivial caret math); blurred blocks render through
// the existing renderMarkdown pipeline (so wikilinks stay clickable & XSS-safe).
//
// Markdown is never the in-memory model — blocks are — but parse()/serialize()
// keep note.content a markdown string, so backlinks/search/graph/export are
// untouched. See src/utils/blocks.js.

import { parse, serialize, makeBlock, numberedLabels, LIST_TYPES } from '../utils/blocks.js';
import { renderInline, renderMarkdown, setKnownTitles } from '../utils/markdown.js';
import { escapeHtml } from '../utils/helpers.js';
import { fileToBannerDataURL } from '../utils/image.js';

const MULTILINE = new Set(['code', 'raw']); // edited as plain multi-line text
const NONTEXT = new Set(['divider', 'date', 'image']); // not text-editable: select & delete
// Image src allowlist — same policy as banners: web + image data URLs only, so a
// crafted note can't turn an <img src> into a tracking beacon or odd scheme.
const SAFE_IMG = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);)/i;
const MAX_INDENT = 6;
const UNDO_LIMIT = 100;

const SLASH_ITEMS = [
  { key: 'paragraph', label: 'Text', hint: 'Plain paragraph', apply: { type: 'paragraph' } },
  { key: 'h1', label: 'Heading 1', hint: 'Big section heading', apply: { type: 'heading', meta: { level: 1 } } },
  { key: 'h2', label: 'Heading 2', hint: 'Medium heading', apply: { type: 'heading', meta: { level: 2 } } },
  { key: 'h3', label: 'Heading 3', hint: 'Small heading', apply: { type: 'heading', meta: { level: 3 } } },
  { key: 'bullet', label: 'Bulleted list', hint: 'Simple bullet list', apply: { type: 'bullet' } },
  { key: 'numbered', label: 'Numbered list', hint: 'Ordered list', apply: { type: 'numbered' } },
  { key: 'todo', label: 'To-do', hint: 'Checkbox task', apply: { type: 'todo', meta: { checked: false } } },
  { key: 'quote', label: 'Quote', hint: 'Callout / quote', apply: { type: 'quote' } },
  { key: 'code', label: 'Code', hint: 'Code block', apply: { type: 'code', meta: { lang: '' } } },
  { key: 'date', label: 'Date', hint: "Insert today's date", apply: { type: 'date' } },
  { key: 'divider', label: 'Divider', hint: 'Horizontal rule', apply: { type: 'divider' } },
  { key: 'image', label: 'Image', hint: 'Upload a picture', apply: { type: 'image' } },
  { key: 'callout', label: 'Callout', hint: 'Highlighted note box', apply: { type: 'quote', text: '[!note] ' } },
  { key: 'table', label: 'Table', hint: 'Editable table', apply: { type: 'table' } },
  { key: 'toggle', label: 'Toggle', hint: 'Collapsible section', apply: { type: 'raw', text: '<details>\n<summary>Toggle</summary>\n\nHidden content\n\n</details>' } },
];

const CALLOUTS = {
  note: { icon: 'ℹ️', label: 'Note' },
  tip: { icon: '💡', label: 'Tip' },
  info: { icon: 'ℹ️', label: 'Info' },
  important: { icon: '❗', label: 'Important' },
  warning: { icon: '⚠️', label: 'Warning' },
  caution: { icon: '🛑', label: 'Caution' },
};

/** Parse a GitHub-style callout header `[!kind] rest` from a quote's text. */
function parseCallout(text) {
  const m = /^\[!(\w+)\]\s*(.*)$/s.exec(text || '');
  if (!m) return null;
  const kind = m[1].toLowerCase();
  if (!CALLOUTS[kind]) return null;
  return { kind, body: m[2] };
}

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Format an ISO date (YYYY-MM-DD) as a friendly label, parsed as local time.
 * Rejects calendar-invalid values (e.g. 2026-02-30) that JS would silently roll
 * over to a different day — showing the raw value instead of a misleading label.
 */
const formatDateLabel = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  const d = m && new Date(`${iso}T00:00:00`);
  if (
    !m || Number.isNaN(d.getTime()) ||
    d.getFullYear() !== +m[1] || d.getMonth() + 1 !== +m[2] || d.getDate() !== +m[3]
  ) {
    return iso || 'No date';
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

export class BlockEditor {
  /**
   * @param {HTMLElement} host  the `.editor__blocks` container
   * @param {{ initialMarkdown?:string, onChange?:()=>void,
   *           onOpenWikilink?:(t:string)=>void, getTitles?:()=>string[] }} opts
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.host.tabIndex = -1; // focusable so multi-select keyboard ops reach #onKeydown
    this.onChange = opts.onChange || (() => {});
    this.onOpenWikilink = opts.onOpenWikilink || (() => {});
    this.getTitles = opts.getTitles || (() => []);

    this.blocks = parse(opts.initialMarkdown || '');
    this.focusedId = null;
    this.selectedId = null; // for non-editable blocks (divider/date/image)
    this.selectedIds = new Set(); // multi-block selection (shift-click range)
    this._selectAnchor = null;
    this.isComposing = false;
    this.datePickerOpen = false; // native date <input> is open
    this.imageBusy = false; // an image file is being picked / downscaled
    this.destroyed = false; // set on teardown; late async work becomes a no-op
    this.rendering = false;
    this.dragId = null;
    this.tableEditing = false; // a table cell holds focus (keep isEditing() true)
    this.lastSnapshotAt = 0;

    this.undoStack = [];
    this.redoStack = [];
    this.baseline = this.#clone(this.blocks); // state before the pending edit
    // Preserve undo/redo history when the editor is rebuilt for the SAME note
    // (e.g. a metadata change triggers a re-render) so an unrelated edit doesn't
    // wipe the user's in-editor history.
    if (opts.history) {
      if (Array.isArray(opts.history.undoStack)) this.undoStack = opts.history.undoStack;
      if (Array.isArray(opts.history.redoStack)) this.redoStack = opts.history.redoStack;
    }

    this.menu = null; // { kind:'slash'|'link', el, items, index, blockId, from, to }

    this.#render();
    this.#bind();
  }

  // === public API (used by editor.js) =====================================

  serialize() {
    this.#syncFocused();
    return serialize(this.blocks);
  }

  /** True while an edit/selection is in flight — editor.js must not re-render then. */
  isEditing() {
    return !!this.focusedId || !!this.selectedId || this.selectedIds.size > 0 || this.isComposing || !!this.menu || this.datePickerOpen || this.imageBusy || this.tableEditing;
  }

  /** Snapshot the undo/redo stacks so a same-note re-render can carry history over. */
  exportHistory() {
    return { undoStack: this.undoStack, redoStack: this.redoStack };
  }

  setMarkdown(md) {
    this.blocks = parse(md || '');
    this.baseline = this.#clone(this.blocks);
    this.undoStack = [];
    this.redoStack = [];
    this.#render();
  }

  focusFirst() {
    const first = this.blocks.find((b) => !NONTEXT.has(b.type));
    if (first) this.#focusBlock(first.id, 'start');
  }

  destroy() {
    this.destroyed = true; // any in-flight image insert resolving later becomes a no-op
    this.imageBusy = false;
    this.#cleanupImagePicker();
    this.#closeMenu();
    window.removeEventListener('resize', this.__onWinChange, true);
    window.removeEventListener('scroll', this.__onWinChange, true);
  }

  #cleanupImagePicker() {
    if (this.__imgOnFocus) { window.removeEventListener('focus', this.__imgOnFocus); this.__imgOnFocus = null; }
    if (this.__imgInput) { this.__imgInput.remove(); this.__imgInput = null; }
  }

  // === rendering ==========================================================

  #render() {
    // Clearing the host detaches the focused block, which fires a synchronous
    // focusout on stale DOM. Suppress commits during that window (the model is
    // already authoritative) via the `rendering` guard in #onFocusOut. The
    // try/finally ensures a render exception can't wedge the flag true forever
    // (which would silently suppress all future blur-commits).
    this.rendering = true;
    try {
      setKnownTitles(this.getTitles());
      const numbers = numberedLabels(this.blocks);
      this.host.innerHTML = '';
      for (const block of this.blocks) {
        this.host.appendChild(this.#buildRow(block, numbers));
      }
    } finally {
      this.rendering = false;
    }
  }

  #buildRow(block, numbers) {
    const row = el('div', 'blk-row');
    row.dataset.id = block.id;
    row.dataset.type = block.type;
    if (block.type === 'heading') row.dataset.level = block.meta?.level || 1;
    row.style.setProperty('--indent', block.meta?.indent || 0);
    if (block.id === this.selectedId || this.selectedIds.has(block.id)) row.classList.add('blk-row--selected');

    const gutter = el('div', 'blk-gutter');
    gutter.contentEditable = 'false';
    gutter.innerHTML =
      '<button class="blk-add" title="Insert block below" tabindex="-1">+</button>' +
      '<button class="blk-handle" title="Turn into / drag to reorder" draggable="true" tabindex="-1">⋮⋮</button>';
    row.appendChild(gutter);

    const marker = this.#buildMarker(block, numbers);
    if (marker) row.appendChild(marker);

    const content = el('div', 'blk markdown');
    content.dataset.type = block.type;
    // Tables are a non-editable shell containing individually-editable cells.
    content.contentEditable = NONTEXT.has(block.type) || block.type === 'table' ? 'false' : 'true';
    this.#fillContent(content, block, /*raw*/ false);
    row.appendChild(content);
    return row;
  }

  #buildMarker(block, numbers) {
    if (block.type === 'bullet') {
      const m = el('span', 'blk-marker blk-marker--bullet');
      m.contentEditable = 'false';
      m.textContent = '•';
      return m;
    }
    if (block.type === 'numbered') {
      const m = el('span', 'blk-marker blk-marker--num');
      m.contentEditable = 'false';
      m.textContent = (numbers.get(block.id) || 1) + '.';
      return m;
    }
    if (block.type === 'todo') {
      const m = el('span', 'blk-marker blk-marker--todo');
      m.contentEditable = 'false';
      // A real <button> so it's focusable + keyboard-operable (Space/Enter activate it
      // natively) and has an accessible name — the prior <span> was mouse-only.
      m.innerHTML = `<button type="button" class="blk-check ${block.meta?.checked ? 'is-checked' : ''}" role="checkbox" aria-checked="${!!block.meta?.checked}" aria-label="Toggle to-do"></button>`;
      return m;
    }
    return null;
  }

  /** Fill a content element with either raw text or rendered HTML. */
  #fillContent(content, block, raw) {
    content.className = 'blk markdown'; // reset per-render marker classes (callout/broken)
    if (block.type === 'divider') {
      content.innerHTML = '<hr>';
      return;
    }
    if (block.type === 'image') {
      this.#fillImage(content, block);
      return;
    }
    if (block.type === 'table') {
      this.#fillTable(content, block);
      return;
    }
    if (block.type === 'date') {
      const iso = block.meta?.date || '';
      content.innerHTML =
        `<button class="blk-date" type="button" tabindex="-1" title="Change date">` +
        `📅 ${escapeHtml(formatDateLabel(iso))}</button>`;
      return;
    }
    if (MULTILINE.has(block.type)) {
      if (raw || block.type === 'code') {
        content.textContent = block.text; // code always shows source
        content.dataset.raw = 'true';
      } else {
        // blurred raw block: render (tables/HTML display properly)
        setKnownTitles(this.getTitles());
        content.innerHTML = renderMarkdown(block.text);
        delete content.dataset.raw;
      }
      return;
    }
    if (raw) {
      content.textContent = block.text;
      content.dataset.raw = 'true';
    } else {
      delete content.dataset.raw;
      setKnownTitles(this.getTitles());
      // A blockquote beginning with `[!kind]` renders as a Notion-style callout.
      if (block.type === 'quote') {
        const callout = parseCallout(block.text);
        if (callout) { this.#fillCallout(content, callout); return; }
      }
      content.innerHTML = block.text ? renderInline(block.text) : '';
    }
  }

  #fillImage(content, block) {
    const src = block.meta?.src || '';
    content.innerHTML = '';
    if (src && SAFE_IMG.test(src)) {
      const fig = el('figure', 'blk-figure');
      const img = el('img', 'blk-img');
      img.src = src; // set as a property, only after the allowlist check
      img.alt = block.meta?.alt || '';
      img.loading = 'lazy';
      img.addEventListener('error', () => content.classList.add('blk-img--broken'));
      fig.appendChild(img);
      if (block.meta?.alt) {
        const cap = el('figcaption', 'blk-figcaption');
        cap.textContent = block.meta.alt;
        fig.appendChild(cap);
      }
      content.appendChild(fig);
    } else {
      // no/unsafe src — show the raw markdown; never load it as an <img>
      content.textContent = `![${block.meta?.alt || ''}](${src})`;
    }
  }

  #fillCallout(content, { kind, body }) {
    const meta = CALLOUTS[kind];
    content.classList.add('blk--callout', 'blk--callout-' + kind);
    const box = el('div', 'blk-callout');
    const head = el('div', 'blk-callout__head');
    head.textContent = `${meta.icon} ${meta.label}`;
    const bodyEl = el('div', 'blk-callout__body markdown');
    bodyEl.innerHTML = body ? renderInline(body) : '';
    box.append(head, bodyEl);
    content.appendChild(box);
  }

  // === tables (editable grid) =============================================

  /** Render an editable table grid into the (non-editable) block shell. */
  #fillTable(content, block) {
    const meta = block.meta || {};
    const rows = (Array.isArray(meta.rows) && meta.rows.length) ? meta.rows : [['', ''], ['', '']];
    const align = Array.isArray(meta.align) ? meta.align : [];

    const wrap = el('div', 'blk-table-wrap');
    wrap.contentEditable = 'false';
    const table = el('table', 'blk-table');
    rows.forEach((row, r) => {
      const tr = el('tr');
      row.forEach((cell, c) => {
        const td = el(r === 0 ? 'th' : 'td');
        td.contentEditable = 'true';
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        td.textContent = cell;
        if (align[c]) td.style.textAlign = align[c];
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);

    const tools = el('div', 'blk-table-tools');
    tools.contentEditable = 'false';
    tools.innerHTML =
      '<button type="button" data-tbl="addcol" tabindex="-1" title="Add column">＋ Col</button>' +
      '<button type="button" data-tbl="addrow" tabindex="-1" title="Add row">＋ Row</button>' +
      '<button type="button" data-tbl="delcol" tabindex="-1" title="Remove last column">－ Col</button>' +
      '<button type="button" data-tbl="delrow" tabindex="-1" title="Remove last row">－ Row</button>';
    wrap.appendChild(tools);

    // Clearing the old grid blurs the focused cell, firing a focusout that would
    // otherwise commit the *stale* DOM back over meta.rows. Suppress commits during
    // the swap with the same `rendering` guard #render uses (save/restore so this
    // nests safely when called from within #render).
    const prevRendering = this.rendering;
    this.rendering = true;
    try {
      content.innerHTML = '';
      content.appendChild(wrap);
    } finally {
      this.rendering = prevRendering;
    }

    table.addEventListener('input', () => this.#commitTable(block, content));
    table.addEventListener('keydown', (e) => this.#tableKeydown(e, block, content));
    table.addEventListener('focusin', () => {
      this.tableEditing = true;
      if (this.selectedId) { // editing a cell cancels a pending block-level selection
        this.selectedId = null;
        content.closest('.blk-row')?.classList.remove('blk-row--selected');
      }
    });
    table.addEventListener('focusout', (e) => {
      if (this.rendering) { this.tableEditing = false; return; } // a re-render detached us
      if (content.contains(e.relatedTarget)) return; // moving between cells — stay in edit mode
      this.tableEditing = false;
      this.#commitTable(block, content);
    });
    table.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
      document.execCommand('insertText', false, text.replace(/\r?\n/g, ' ')); // plain-text, single line
    });
    tools.addEventListener('mousedown', (e) => e.preventDefault()); // don't steal caret from the cell
    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tbl]');
      if (btn) this.#tableMutate(btn.dataset.tbl, block, content);
    });
  }

  /** Read every cell from the DOM back into block.meta.rows. */
  #commitTable(block, content) {
    const table = content.querySelector('table.blk-table');
    if (!table) return;
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent.replace(/\r?\n/g, ' ')));
    if (!rows.length) return;
    block.meta = { ...block.meta, rows, align: (block.meta?.align || []).slice(0, rows[0].length) };
    this.#snapshot(/*coalesce*/ true); // folds rapid typing; also fires onChange
  }

  /** Add/remove the last row or column, then re-render the grid. */
  #tableMutate(act, block, content) {
    const rows = (Array.isArray(block.meta?.rows) && block.meta.rows.length ? block.meta.rows : [['', '']]).map((r) => [...r]);
    const cols = rows[0]?.length || 1;
    if (act === 'addrow') rows.push(Array(cols).fill(''));
    else if (act === 'addcol') rows.forEach((r) => r.push(''));
    else if (act === 'delrow') { if (rows.length <= 1) return; rows.pop(); }
    else if (act === 'delcol') { if (cols <= 1) return; rows.forEach((r) => r.pop()); }
    else return;
    const align = (block.meta?.align || []).slice(0, rows[0].length);
    block.meta = { ...block.meta, rows, align };
    this.#fillTable(content, block);
    this.#snapshot();
  }

  #tableKeydown(e, block, content) {
    const cells = () => [...content.querySelectorAll('th, td')];
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const list = cells();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let next = i + (e.shiftKey ? -1 : 1);
      if (next >= list.length) { // past the last cell -> append a row, land on its first cell
        this.#tableMutate('addrow', block, content);
        this.#focusCell(cells()[i + 1]);
        return;
      }
      if (next < 0) next = 0;
      this.#focusCell(list[next]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const list = cells();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = block.meta?.rows?.[0]?.length || 1;
      const below = i + cols;
      if (below >= list.length) { // last row -> add one and drop into the same column
        this.#tableMutate('addrow', block, content);
        this.#focusCell(cells()[below]);
      } else {
        this.#focusCell(list[below]);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.tableEditing = false;
      this.#commitTable(block, content);
      if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    }
  }

  #focusCell(cell) {
    if (!cell) return;
    cell.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false); // caret at end of the cell
    sel.removeAllRanges();
    sel.addRange(range);
  }

  #rowEl(id) {
    return this.host.querySelector(`.blk-row[data-id="${id}"]`);
  }
  #contentEl(id) {
    const row = this.#rowEl(id);
    return row ? row.querySelector('.blk') : null;
  }
  #byId(id) {
    return this.blocks.find((b) => b.id === id) || null;
  }
  #indexOf(id) {
    return this.blocks.findIndex((b) => b.id === id);
  }

  // === focus / raw-mode swap ==============================================

  #enterRaw(block, content) {
    if (this.isComposing) return;
    if (content.dataset.raw === 'true') return;
    this.#fillContent(content, block, /*raw*/ true);
  }

  #commit(block, content) {
    if (content.dataset.raw === 'true' || MULTILINE.has(block.type)) {
      block.text = content.textContent;
    }
  }

  #syncFocused() {
    if (!this.focusedId) return;
    const block = this.#byId(this.focusedId);
    const content = this.#contentEl(this.focusedId);
    if (block && content) this.#commit(block, content);
  }

  /** Move focus+caret into a block, re-rendering to raw first. */
  #focusBlock(id, caret = 'end') {
    const block = this.#byId(id);
    const content = this.#contentEl(id);
    if (!block || !content) return;
    if (NONTEXT.has(block.type) || block.type === 'table') {
      this.selectedId = id;
      this.focusedId = null;
      this.#render();
      this.host.focus({ preventScroll: true }); // so Backspace/Delete reach #onKeydown
      return;
    }
    this.focusedId = id;
    this.#enterRaw(block, content);
    content.focus();
    const len = block.text.length;
    const offset = caret === 'end' ? len : caret === 'start' ? 0 : Math.max(0, Math.min(caret, len));
    this.#setCaret(content, offset);
  }

  // === caret helpers ======================================================

  #caretOffset(content) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!content.contains(range.endContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(content);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }

  #setCaret(content, offset) {
    const node = content.firstChild;
    const sel = window.getSelection();
    const range = document.createRange();
    if (node && node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, Math.max(0, Math.min(offset, node.textContent.length)));
    } else {
      range.setStart(content, 0);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  #selectionCollapsed() {
    const sel = window.getSelection();
    return !sel || sel.isCollapsed;
  }

  // === event binding ======================================================

  #bind() {
    const h = this.host;
    h.addEventListener('focusin', (e) => this.#onFocusIn(e));
    h.addEventListener('focusout', (e) => this.#onFocusOut(e));
    h.addEventListener('input', (e) => this.#onInput(e));
    h.addEventListener('keydown', (e) => this.#onKeydown(e));
    h.addEventListener('paste', (e) => this.#onPaste(e));
    h.addEventListener('compositionstart', () => (this.isComposing = true));
    h.addEventListener('compositionend', (e) => this.#onCompositionEnd(e));
    h.addEventListener('mousedown', (e) => this.#onMouseDown(e));
    h.addEventListener('click', (e) => this.#onClick(e));

    // drag reorder
    h.addEventListener('dragstart', (e) => this.#onDragStart(e));
    h.addEventListener('dragover', (e) => this.#onDragOver(e));
    h.addEventListener('drop', (e) => this.#onDrop(e));
    h.addEventListener('dragend', () => this.#clearDrop());

    // Close menus when the window shifts under them — but NOT when the scroll
    // happens inside the menu itself (that would break scrolling a long menu).
    this.__onWinChange = (e) => {
      if (e && e.type === 'scroll' && this.menu && this.menu.el.contains(e.target)) return;
      this.#closeMenu();
    };
    window.addEventListener('resize', this.__onWinChange, true);
    window.addEventListener('scroll', this.__onWinChange, true);
  }

  #onFocusIn(e) {
    const content = e.target.closest('.blk[contenteditable="true"]');
    if (!content || !this.host.contains(content)) return;
    const row = content.closest('.blk-row');
    const block = this.#byId(row.dataset.id);
    if (!block) return;
    if (this.selectedId) {
      this.selectedId = null;
      row.classList.remove('blk-row--selected');
    }
    if (this.selectedIds.size) this.#clearMultiSelect();
    this.focusedId = block.id;
    // If already raw (programmatic focus via #focusBlock), the caller sets the
    // caret. Otherwise this is a mouse click into a rendered block: capture the
    // click offset in the rendered text before swapping to raw so the caret
    // doesn't collapse to 0. Exact for plain text; a close approximation when
    // inline markdown syntax (e.g. **bold**) differs from the rendered length.
    if (this.isComposing || content.dataset.raw === 'true') return;
    const approx = this.#caretOffset(content);
    this.#enterRaw(block, content);
    this.#setCaret(content, approx);
  }

  #onFocusOut(e) {
    // A re-render detaches the focused block and fires a synchronous focusout on
    // stale DOM; the model is already authoritative, so never commit then.
    if (this.rendering) return;
    const content = e.target.closest('.blk[contenteditable="true"]');
    if (!content) return;
    if (!this.host.contains(content)) return;
    const row = content.closest('.blk-row');
    if (!row) return;
    const block = this.#byId(row.dataset.id);
    if (!block) return;
    // If focus is moving into our menu, keep raw mode (menu interaction).
    if (this.menu && this.menu.el.contains(e.relatedTarget)) return;
    this.#commit(block, content);
    if (this.focusedId === block.id) this.focusedId = null;
    this.#fillContent(content, block, /*raw*/ false);
    this.#closeMenu();
  }

  #onCompositionEnd(e) {
    this.isComposing = false;
    const content = e.target.closest('.blk[contenteditable="true"]');
    if (content) {
      const block = this.#byId(content.closest('.blk-row').dataset.id);
      if (block) {
        this.#commit(block, content);
        this.#afterTextChange(block, content);
      }
    }
  }

  #onInput(e) {
    const content = e.target.closest('.blk[contenteditable="true"]');
    if (!content) return;
    const block = this.#byId(content.closest('.blk-row').dataset.id);
    if (!block) return;
    if (this.isComposing) return;
    this.#commit(block, content);
    this.#afterTextChange(block, content);
  }

  /** After the text of a focused block changed: shortcuts, menus, autosave. */
  #afterTextChange(block, content) {
    this.#snapshot(/*coalesce*/ true);

    // Markdown block shortcuts (only for single-line, non-multiline blocks).
    if (!MULTILINE.has(block.type) && this.#applyShortcut(block, content)) {
      this.onChange();
      return;
    }

    // Slash menu + [[ link autocomplete both key off the pre-caret text.
    this.#updateContextMenus(block, content);
    this.onChange();
  }

  // === markdown shortcuts =================================================

  #applyShortcut(block, content) {
    const offset = this.#caretOffset(content);
    const before = block.text.slice(0, offset);

    const set = (patch, strip) => {
      Object.assign(block, { type: patch.type, meta: patch.meta ? { ...patch.meta } : {} });
      block.text = block.text.slice(strip);
      this.#rerenderRowShell(block);
      this.#focusBlock(block.id, 'start');
      this.#snapshot();
      return true;
    };

    // These only fire when the trigger is the entire pre-caret text (start of block).
    let m;
    if ((m = /^(#{1,3})\s$/.exec(before))) return set({ type: 'heading', meta: { level: m[1].length } }, m[0].length);
    if (/^[-*]\s$/.test(before)) return set({ type: 'bullet', meta: { indent: block.meta?.indent || 0 } }, 2);
    if (/^\d+\.\s$/.test(before)) return set({ type: 'numbered', meta: { indent: block.meta?.indent || 0 } }, before.length);
    if (/^\[[ ]?\]\s$/.test(before)) return set({ type: 'todo', meta: { checked: false, indent: block.meta?.indent || 0 } }, before.length);
    if (/^\[x\]\s$/i.test(before)) return set({ type: 'todo', meta: { checked: true, indent: block.meta?.indent || 0 } }, before.length);
    if (/^>\s$/.test(before)) return set({ type: 'quote' }, 2);

    // Divider: whole block is exactly ---, ***, or ___
    if (/^(?:---|\*\*\*|___)$/.test(block.text)) {
      block.type = 'divider';
      block.text = '';
      block.meta = {};
      const after = makeBlock('paragraph', '');
      this.blocks.splice(this.#indexOf(block.id) + 1, 0, after);
      this.focusedId = null;
      this.#render();
      this.#focusBlock(after.id, 'start');
      this.#snapshot();
      return true;
    }
    return false;
  }

  /** Re-render one row's shell (marker/type) without disturbing focus text. */
  #rerenderRowShell(block) {
    const row = this.#rowEl(block.id);
    if (!row) return;
    const numbers = numberedLabels(this.blocks);
    const fresh = this.#buildRow(block, numbers);
    // Swapping the focused row fires a synchronous focusout on the old (raw)
    // content; the model is already authoritative, so suppress that stale commit
    // (same guard #render uses) — otherwise it clobbers block.text just set here.
    this.rendering = true;
    try { row.replaceWith(fresh); } finally { this.rendering = false; }
    this.#renumber();
  }

  #renumber() {
    const numbers = numberedLabels(this.blocks);
    for (const b of this.blocks) {
      if (b.type !== 'numbered') continue;
      const marker = this.#rowEl(b.id)?.querySelector('.blk-marker--num');
      if (marker) marker.textContent = (numbers.get(b.id) || 1) + '.';
    }
  }

  // === keyboard ===========================================================

  #onKeydown(e) {
    // Menu navigation takes precedence.
    if (this.menu) {
      if (this.#menuKeydown(e)) return;
    }

    // Multi-block selection owns Backspace/Delete/copy/cut/Escape while active.
    if (this.selectedIds.size && this.#multiSelectKeydown(e)) return;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.#undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.#redo(); return; }

    // Divider selected: allow deletion.
    if (this.selectedId && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      this.#deleteBlock(this.selectedId, /*focusPrev*/ true);
      return;
    }

    const content = e.target.closest('.blk[contenteditable="true"]');
    if (!content) return;
    const block = this.#byId(content.closest('.blk-row').dataset.id);
    if (!block) return;
    if (this.isComposing) return;

    switch (e.key) {
      case 'Enter':
        if (e.shiftKey) return this.#insertSoftBreak(e, block, content);
        return this.#onEnter(e, block, content);
      case 'Backspace':
        return this.#onBackspace(e, block, content);
      case 'Delete':
        return this.#onDelete(e, block, content);
      case 'Tab':
        return this.#onTab(e, block, content);
      case 'ArrowUp':
      case 'ArrowLeft':
        return this.#onArrowPrev(e, block, content);
      case 'ArrowDown':
      case 'ArrowRight':
        return this.#onArrowNext(e, block, content);
      default:
        return;
    }
  }

  #onEnter(e, block, content) {
    e.preventDefault();
    const offset = this.#caretOffset(content);
    this.#commit(block, content); // sync DOM -> model before we split from block.text

    // ``` on its own -> code block
    if (block.type === 'paragraph') {
      const fence = /^```(\w*)$/.exec(block.text);
      if (fence) {
        block.type = 'code';
        block.meta = { lang: fence[1] };
        block.text = '';
        this.#rerenderRowShell(block);
        this.#focusBlock(block.id, 'start');
        this.#snapshot();
        return;
      }
    }

    if (MULTILINE.has(block.type)) {
      // Exit on a trailing blank line, else insert a newline.
      if (offset === block.text.length && block.text.endsWith('\n')) {
        block.text = block.text.replace(/\n$/, '');
        const after = makeBlock('paragraph', '');
        this.blocks.splice(this.#indexOf(block.id) + 1, 0, after);
        this.#dropFocusAndRender();
        this.#focusBlock(after.id, 'start');
        this.#snapshot();
      } else {
        this.#insertText(content, block, '\n');
      }
      return;
    }

    const before = block.text.slice(0, offset);
    const after = block.text.slice(offset);

    // Enter on an empty list item exits the list.
    if (LIST_TYPES.has(block.type) && block.text.trim() === '') {
      block.type = 'paragraph';
      block.meta = {};
      this.#rerenderRowShell(block);
      this.#focusBlock(block.id, 'start');
      this.#snapshot();
      return;
    }

    block.text = before;
    let newType = 'paragraph';
    let newMeta = {};
    if (LIST_TYPES.has(block.type)) {
      newType = block.type;
      newMeta = { ...block.meta };
      if (newType === 'todo') newMeta.checked = false;
    }
    const nb = makeBlock(newType, after, newMeta);
    this.blocks.splice(this.#indexOf(block.id) + 1, 0, nb);
    this.#dropFocusAndRender();
    this.#focusBlock(nb.id, 'start');
    this.#snapshot();
  }

  #onBackspace(e, block, content) {
    const offset = this.#caretOffset(content);
    if (offset !== 0 || !this.#selectionCollapsed()) return; // normal char delete
    e.preventDefault();

    // First Backspace demotes a styled block back to paragraph.
    if (block.type !== 'paragraph' && !MULTILINE.has(block.type)) {
      block.type = 'paragraph';
      block.meta = {};
      this.#rerenderRowShell(block);
      this.#focusBlock(block.id, 'start');
      this.#snapshot();
      return;
    }

    // Merge into previous block.
    const idx = this.#indexOf(block.id);
    if (idx <= 0) return;
    const prev = this.blocks[idx - 1];
    if (NONTEXT.has(prev.type)) {
      this.#deleteBlock(prev.id, false);
      this.#focusBlock(block.id, 'start');
      return;
    }
    if (prev.type === 'table') {
      this.#focusBlock(prev.id, 'end'); // select the table rather than merging text into it
      return;
    }
    if (MULTILINE.has(prev.type)) {
      this.#focusBlock(prev.id, 'end'); // don't merge into code
      return;
    }
    const joinAt = prev.text.length;
    prev.text = prev.text + block.text;
    this.blocks.splice(idx, 1);
    this.focusedId = null;
    this.#render();
    this.#focusBlock(prev.id, joinAt);
    this.#snapshot();
  }

  #onDelete(e, block, content) {
    const offset = this.#caretOffset(content);
    if (offset !== block.text.length || !this.#selectionCollapsed()) return;
    const idx = this.#indexOf(block.id);
    if (idx >= this.blocks.length - 1) return;
    const next = this.blocks[idx + 1];
    if (NONTEXT.has(next.type)) {
      e.preventDefault();
      this.#deleteBlock(next.id, false);
      this.#focusBlock(block.id, offset);
      return;
    }
    if (MULTILINE.has(block.type) || MULTILINE.has(next.type)) return;
    e.preventDefault();
    const joinAt = block.text.length;
    block.text = block.text + next.text;
    this.blocks.splice(idx + 1, 1);
    this.focusedId = null;
    this.#render();
    this.#focusBlock(block.id, joinAt);
    this.#snapshot();
  }

  #onTab(e, block, content) {
    e.preventDefault();
    if (LIST_TYPES.has(block.type)) {
      const cur = block.meta?.indent || 0;
      const next = e.shiftKey ? Math.max(0, cur - 1) : Math.min(MAX_INDENT, cur + 1);
      block.meta = { ...block.meta, indent: next };
      const off = this.#caretOffset(content);
      this.#rerenderRowShell(block);
      this.#focusBlock(block.id, off);
      this.#snapshot();
    } else {
      this.#insertText(content, block, '  ');
    }
  }

  #onArrowPrev(e, block, content) {
    const offset = this.#caretOffset(content);
    const beforeCaret = block.text.slice(0, offset);
    const inFirstLine = !beforeCaret.includes('\n');
    if (e.key === 'ArrowLeft' && offset !== 0) return;
    if (e.key === 'ArrowUp' && !inFirstLine) return;
    const idx = this.#indexOf(block.id);
    if (idx <= 0) return;
    e.preventDefault();
    const prev = this.blocks[idx - 1];
    this.#focusBlock(prev.id, 'end');
  }

  #onArrowNext(e, block, content) {
    const offset = this.#caretOffset(content);
    const afterCaret = block.text.slice(offset);
    const inLastLine = !afterCaret.includes('\n');
    if (e.key === 'ArrowRight' && offset !== block.text.length) return;
    if (e.key === 'ArrowDown' && !inLastLine) return;
    const idx = this.#indexOf(block.id);
    if (idx >= this.blocks.length - 1) return;
    e.preventDefault();
    const next = this.blocks[idx + 1];
    this.#focusBlock(next.id, 'start');
  }

  #insertSoftBreak(e, block, content) {
    e.preventDefault();
    this.#insertText(content, block, '\n');
  }

  /** Insert literal text at the caret of a raw content element. */
  #insertText(content, block, text) {
    const offset = this.#caretOffset(content);
    const value = block.text.slice(0, offset) + text + block.text.slice(offset);
    block.text = value;
    content.textContent = value;
    this.#setCaret(content, offset + text.length);
    this.#snapshot(true);
    this.onChange();
  }

  // Re-render after a structural change. Does NOT re-commit the DOM: callers
  // must have already made block.text authoritative (the DOM still shows the
  // pre-split text, so committing here would clobber the split).
  #dropFocusAndRender() {
    this.focusedId = null;
    this.#render();
  }

  #deleteBlock(id, focusPrev) {
    const idx = this.#indexOf(id);
    if (idx < 0) return;
    this.blocks.splice(idx, 1);
    if (this.blocks.length === 0) this.blocks.push(makeBlock('paragraph', ''));
    this.selectedId = null;
    this.focusedId = null;
    this.#render();
    const target = this.blocks[Math.max(0, idx - (focusPrev ? 1 : 0))];
    if (target && !NONTEXT.has(target.type)) this.#focusBlock(target.id, focusPrev ? 'end' : 'start');
    this.#snapshot();
    this.onChange();
  }

  // === mouse / click ======================================================

  #onMouseDown(e) {
    // Let wikilink clicks navigate instead of entering edit mode.
    if (e.target.closest('a[data-wikilink]')) {
      e.preventDefault();
      return;
    }
    // Shift+click selects a contiguous range of blocks (multi-select).
    if (e.shiftKey && !e.target.closest('.blk-gutter')) {
      const row = e.target.closest('.blk-row');
      if (row) {
        e.preventDefault();
        this.#selectRangeTo(row.dataset.id);
        return;
      }
    }
    // A plain click elsewhere clears any multi-selection.
    if (this.selectedIds.size && !e.target.closest('.blk-gutter')) this.#clearMultiSelect();
    // Clicking a non-text block (divider/date/image) selects it — but a click on
    // the date chip opens its picker, and the gutter has its own handlers.
    const ntRow = e.target.closest('.blk-row[data-type="divider"], .blk-row[data-type="date"], .blk-row[data-type="image"]');
    if (ntRow && !e.target.closest('.blk-gutter') && !e.target.closest('.blk-date')) {
      e.preventDefault();
      this.selectedId = ntRow.dataset.id;
      this.focusedId = null;
      this.#render();
    }
  }

  #onClick(e) {
    const link = e.target.closest('a[data-wikilink]');
    if (link) {
      e.preventDefault();
      this.onOpenWikilink(link.dataset.wikilink);
      return;
    }
    const check = e.target.closest('.blk-check');
    if (check) {
      const block = this.#byId(check.closest('.blk-row').dataset.id);
      if (block) {
        block.meta = { ...block.meta, checked: !block.meta?.checked };
        check.classList.toggle('is-checked');
        check.setAttribute('aria-checked', String(!!block.meta.checked));
        this.#snapshot();
        this.onChange();
      }
      return;
    }
    const dateChip = e.target.closest('.blk-date');
    if (dateChip) {
      const row = dateChip.closest('.blk-row');
      const block = this.#byId(row.dataset.id);
      if (block) this.#openDateEditor(row, block);
      return;
    }
    const add = e.target.closest('.blk-add');
    if (add) {
      const row = add.closest('.blk-row');
      const idx = this.#indexOf(row.dataset.id);
      const nb = makeBlock('paragraph', '');
      this.blocks.splice(idx + 1, 0, nb);
      this.#render();
      this.#focusBlock(nb.id, 'start');
      const content = this.#contentEl(nb.id);
      this.#openMenu('slash', nb, content, null);
      this.#snapshot();
      return;
    }
    const handle = e.target.closest('.blk-handle');
    if (handle) {
      const row = handle.closest('.blk-row');
      const block = this.#byId(row.dataset.id);
      if (NONTEXT.has(block.type) || block.type === 'table') {
        this.#focusBlock(block.id); // selects it (non-text / table)
        return;
      }
      const content = this.#contentEl(block.id);
      this.#focusBlock(block.id, 'end');
      this.#openMenu('slash', block, content, null); // "turn into"
      return;
    }
  }

  /** Inline native date picker for a date block. */
  #openDateEditor(row, block) {
    const content = row.querySelector('.blk');
    if (!content) return;
    const input = el('input', 'blk-date-input');
    input.type = 'date';
    input.value = block.meta?.date || todayISO();
    content.innerHTML = '';
    content.appendChild(input);
    this.datePickerOpen = true; // keep isEditing() true so a refresh won't tear us down
    input.focus();
    if (input.showPicker) {
      try { input.showPicker(); } catch { /* not supported / blocked */ }
    }
    const restore = () => {
      this.datePickerOpen = false;
      this.#fillContent(content, block, false);
    };
    input.addEventListener('change', () => {
      if (input.value) {
        block.meta = { ...block.meta, date: input.value };
        this.#snapshot();
        this.onChange();
      }
      restore();
    });
    input.addEventListener('blur', () => {
      if (content.contains(input)) restore();
    });
  }

  // === slash menu + [[ autocomplete =======================================

  #updateContextMenus(block, content) {
    const offset = this.#caretOffset(content);
    const before = block.text.slice(0, offset);

    // [[ link autocomplete (unclosed [[ before caret)
    const link = /\[\[([^\]\n]*)$/.exec(before);
    if (link) {
      this.#openMenu('link', block, content, {
        query: link[1],
        from: offset - link[0].length,
        to: offset,
      });
      return;
    }

    // /slash (start-of-block or after whitespace)
    const slash = /(^|\s)\/([\w]*)$/.exec(before);
    if (slash && !MULTILINE.has(block.type)) {
      const token = '/' + slash[2];
      this.#openMenu('slash', block, content, {
        query: slash[2],
        from: offset - token.length,
        to: offset,
      });
      return;
    }

    if (this.menu) this.#closeMenu();
  }

  #openMenu(kind, block, content, range) {
    if (!this.menu || this.menu.kind !== kind || this.menu.blockId !== block.id) {
      this.#closeMenu();
      const box = el('div', 'blk-menu');
      document.body.appendChild(box);
      this.menu = { kind, el: box, blockId: block.id, index: 0, items: [], range };
    } else {
      this.menu.range = range;
    }
    this.menu.query = range?.query ?? '';
    this.menu.items = kind === 'slash' ? this.#slashItems(this.menu.query) : this.#linkItems(this.menu.query);
    if (this.menu.items.length === 0) {
      this.#closeMenu();
      return;
    }
    if (this.menu.index >= this.menu.items.length) this.menu.index = 0;
    this.#renderMenu(content);
  }

  #slashItems(query) {
    const q = (query || '').toLowerCase();
    return SLASH_ITEMS.filter((it) => !q || it.label.toLowerCase().includes(q) || it.key.includes(q));
  }

  #linkItems(query) {
    const q = (query || '').toLowerCase();
    return this.getTitles()
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 8)
      .map((t) => ({ key: t, label: t }));
  }

  #renderMenu(content) {
    const m = this.menu;
    m.el.innerHTML = m.items
      .map(
        (it, i) => `
        <button class="blk-menu__item ${i === m.index ? 'is-active' : ''}" data-i="${i}" tabindex="-1">
          <span class="blk-menu__label">${escapeHtml(it.label)}</span>
          ${it.hint ? `<span class="blk-menu__hint">${escapeHtml(it.hint)}</span>` : ''}
        </button>`
      )
      .join('');
    // Keep focus in the editable block: prevent the menu from stealing it.
    m.el.querySelectorAll('.blk-menu__item').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        m.index = Number(btn.dataset.i);
        this.#chooseMenu();
      });
    });
    this.#positionMenu();
  }

  #positionMenu() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect();
    const box = this.menu.el;
    const top = rect.bottom + 6;
    const maxLeft = window.innerWidth - box.offsetWidth - 12;
    box.style.top = `${Math.min(top, window.innerHeight - box.offsetHeight - 8)}px`;
    box.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
  }

  #menuKeydown(e) {
    const m = this.menu;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        m.index = (m.index + 1) % m.items.length;
        this.#renderMenu(this.#contentEl(m.blockId));
        return true;
      case 'ArrowUp':
        e.preventDefault();
        m.index = (m.index - 1 + m.items.length) % m.items.length;
        this.#renderMenu(this.#contentEl(m.blockId));
        return true;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        this.#chooseMenu();
        return true;
      case 'Escape':
        e.preventDefault();
        this.#closeMenu();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        // Close the menu and let the caret move within the block, but do NOT
        // fall through to cross-block navigation.
        this.#closeMenu();
        return true;
      default:
        return false;
    }
  }

  #chooseMenu() {
    const m = this.menu;
    if (!m) return;
    const block = this.#byId(m.blockId);
    const content = this.#contentEl(m.blockId);
    const item = m.items[m.index];
    if (!block || !content || !item) return this.#closeMenu();

    if (m.kind === 'link') {
      const insert = `[[${item.label}]]`;
      const text = block.text.slice(0, m.range.from) + insert + block.text.slice(m.range.to);
      block.text = text;
      content.textContent = text;
      this.#setCaret(content, m.range.from + insert.length);
      this.#closeMenu();
      this.#snapshot();
      this.onChange();
      return;
    }

    // slash: strip the /token if present, then apply the block type
    if (m.range) {
      block.text = block.text.slice(0, m.range.from) + block.text.slice(m.range.to);
    }
    this.#closeMenu();
    const spec = item.apply;

    // Image: open a file picker and insert a filled image block on choose (no
    // persistent empty block). URL images can still be typed as ![alt](url).
    if (spec.type === 'image') {
      this.#pickAndInsertImage(block);
      return;
    }

    // Table: convert this block into an editable 2×2 grid and focus the first cell.
    if (spec.type === 'table') {
      block.type = 'table';
      block.text = '';
      block.meta = { rows: [['', ''], ['', '']], align: ['', ''] };
      // Guarantee a trailing paragraph so there's somewhere to type below the table.
      if (this.#indexOf(block.id) === this.blocks.length - 1) this.blocks.push(makeBlock('paragraph', ''));
      this.focusedId = null;
      this.selectedId = null;
      this.#render();
      this.#focusCell(this.#contentEl(block.id)?.querySelector('th, td'));
      this.#snapshot();
      this.onChange();
      return;
    }

    if (NONTEXT.has(spec.type)) {
      // divider / date: non-text blocks; insert a fresh paragraph after so the
      // caret has somewhere to go.
      block.type = spec.type;
      block.text = '';
      block.meta = spec.type === 'date' ? { date: todayISO() } : {};
      const after = makeBlock('paragraph', '');
      this.blocks.splice(this.#indexOf(block.id) + 1, 0, after);
      this.focusedId = null;
      this.selectedId = null;
      this.#render();
      this.#focusBlock(after.id, 'start');
    } else {
      block.type = spec.type;
      block.meta = spec.meta ? { ...spec.meta, indent: block.meta?.indent || 0 } : {};
      if (spec.type === 'code') block.meta = { lang: '' };
      if (typeof spec.text === 'string') block.text = spec.text; // callout / table scaffold
      this.#rerenderRowShell(block);
      this.#focusBlock(block.id, spec.text ? 'end' : 'start');
    }
    this.#snapshot();
    this.onChange();
  }

  #closeMenu() {
    if (this.menu) {
      this.menu.el.remove();
      this.menu = null;
    }
  }

  // === images =============================================================

  /** First image File in a clipboard/drag DataTransfer, or null. */
  #imageFileFrom(dt) {
    if (!dt) return null;
    const files = dt.files ? [...dt.files] : [];
    const fromItems = dt.items ? [...dt.items].filter((it) => it.kind === 'file' && /^image\//.test(it.type)).map((it) => it.getAsFile()) : [];
    return files.concat(fromItems).find((f) => f && /^image\//.test(f.type)) || null;
  }

  /** Open a native file picker and insert a downscaled image block. */
  #pickAndInsertImage(block) {
    this.#cleanupImagePicker(); // never leave a prior picker/listener around
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    this.__imgInput = input;
    this.imageBusy = true; // keep isEditing() true so a background refresh won't tear us down

    const done = () => { this.imageBusy = false; this.#cleanupImagePicker(); };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { done(); return; }
      this.#insertImageFromFile(file, block).finally(done);
    });
    // Modern browsers fire 'cancel' on a dismissed file dialog; the window 'focus'
    // fallback covers browsers that don't. Either way imageBusy is released.
    input.addEventListener('cancel', () => done());
    this.__imgOnFocus = () => {
      if (this.__imgOnFocus) { window.removeEventListener('focus', this.__imgOnFocus); }
      setTimeout(() => { if (this.imageBusy && (!input.files || !input.files.length)) done(); }, 400);
    };
    window.addEventListener('focus', this.__imgOnFocus);
    input.click();
  }

  async #insertImageFromFile(file, block) {
    this.imageBusy = true;
    try {
      const src = await fileToBannerDataURL(file); // downscales to a compact data URL
      if (this.destroyed) return; // note was switched away mid-downscale — drop, don't corrupt
      this.#insertImageBlock(block, src, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      console.warn('[image] could not use that file:', err?.message || err);
    } finally {
      this.imageBusy = false;
    }
  }

  /** Insert an image block near `block` (replacing it if it's an empty paragraph). */
  #insertImageBlock(block, src, alt) {
    if (this.destroyed) return;
    // Alt must survive RE.image on reload: strip ] and newlines (they'd break the round-trip).
    const cleanAlt = String(alt || '').replace(/[\]\r\n]+/g, ' ').trim();
    const img = makeBlock('image', '', { src, alt: cleanAlt });
    const idx = this.#indexOf(block.id);
    if (idx < 0) {
      this.blocks.push(img);
    } else if (block.type === 'paragraph' && block.text.trim() === '') {
      this.blocks.splice(idx, 1, img);
    } else {
      this.blocks.splice(idx + 1, 0, img);
    }
    // Guarantee a trailing text block to continue typing in.
    if (this.#indexOf(img.id) === this.blocks.length - 1) {
      this.blocks.push(makeBlock('paragraph', ''));
    }
    this.selectedId = null;
    this.focusedId = null;
    this.#render();
    this.#snapshot();
    this.onChange();
  }

  // === paste ==============================================================

  #onPaste(e) {
    const content = e.target.closest('.blk[contenteditable="true"]');
    if (!content) return;
    const block = this.#byId(content.closest('.blk-row').dataset.id);
    if (!block) return;
    const dt = e.clipboardData || window.clipboardData;
    // Pasting an image file -> downscaled image block.
    const imgFile = this.#imageFileFrom(dt);
    if (imgFile) {
      e.preventDefault();
      this.#insertImageFromFile(imgFile, block);
      return;
    }
    e.preventDefault();
    const text = dt.getData('text/plain');
    if (!text) return;

    // Inside code/raw: paste verbatim.
    if (MULTILINE.has(block.type) || !text.includes('\n')) {
      this.#insertText(content, block, text);
      return;
    }

    // Multi-line: explode into blocks via the same parser used on open.
    const offset = this.#caretOffset(content);
    const before = block.text.slice(0, offset);
    const after = block.text.slice(offset);
    const parsed = parse(text);
    const idx = this.#indexOf(block.id);

    // first parsed block merges into current (before + firstText)
    const first = parsed.shift();
    block.text = before + first.text;
    if (first.type !== 'paragraph' && block.type === 'paragraph') {
      block.type = first.type;
      block.meta = { ...first.meta };
    }
    // trailing text becomes a final paragraph
    const tail = makeBlock('paragraph', after);
    const insert = [...parsed, tail];
    this.blocks.splice(idx + 1, 0, ...insert);
    this.focusedId = null;
    this.#render();
    const lastInserted = parsed.length ? parsed[parsed.length - 1] : block;
    this.#focusBlock(lastInserted.id, 'end');
    this.#snapshot();
    this.onChange();
  }

  // === drag reorder =======================================================

  #onDragStart(e) {
    const handle = e.target.closest('.blk-handle');
    if (!handle) return;
    const row = handle.closest('.blk-row');
    this.dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dragId);
    row.classList.add('blk-row--dragging');
  }

  #onDragOver(e) {
    if (!this.dragId) {
      // Allow an external image file to be dropped onto the canvas.
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
      return;
    }
    e.preventDefault();
    const row = e.target.closest('.blk-row');
    this.#clearDrop();
    if (row && row.dataset.id !== this.dragId) {
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.classList.add(after ? 'blk-row--drop-after' : 'blk-row--drop-before');
    }
  }

  #onDrop(e) {
    if (!this.dragId) {
      // External image file drop -> image block near the drop target.
      const file = this.#imageFileFrom(e.dataTransfer);
      if (file) {
        e.preventDefault();
        const row = e.target.closest('.blk-row');
        const block = (row && this.#byId(row.dataset.id)) || this.blocks[this.blocks.length - 1];
        this.#insertImageFromFile(file, block);
      }
      return;
    }
    e.preventDefault();
    const row = e.target.closest('.blk-row');
    if (row && row.dataset.id !== this.dragId) {
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const from = this.#indexOf(this.dragId);
      const [moved] = this.blocks.splice(from, 1);
      let to = this.#indexOf(row.dataset.id);
      if (after) to += 1;
      this.blocks.splice(to, 0, moved);
      this.#snapshot();
      this.onChange();
    }
    this.#clearDrop();
    this.dragId = null;
    this.focusedId = null;
    this.#render();
  }

  #clearDrop() {
    this.host.querySelectorAll('.blk-row--drop-before, .blk-row--drop-after, .blk-row--dragging')
      .forEach((r) => r.classList.remove('blk-row--drop-before', 'blk-row--drop-after', 'blk-row--dragging'));
  }

  // === multi-block selection ==============================================

  #selectRangeTo(id) {
    this.#syncFocused(); // don't lose the focused block's buffered text
    const anchor = this._selectAnchor || this.focusedId || this.selectedId || id;
    const a = this.#indexOf(anchor);
    const b = this.#indexOf(id);
    if (a < 0 || b < 0) return;
    this._selectAnchor = anchor;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.selectedIds = new Set(this.blocks.slice(lo, hi + 1).map((x) => x.id));
    this.focusedId = null;
    this.selectedId = null;
    this.#render();
    // Move focus to the (focusable) host so Backspace/Delete/Copy/Cut/Escape reach
    // #onKeydown — after a shift-click no contenteditable block holds focus.
    this.host.focus({ preventScroll: true });
  }

  #multiSelectKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.#deleteSelected(); return true; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this.#copySelected(); return true; }
    if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); this.#copySelected(); this.#deleteSelected(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); this.#clearMultiSelect(); return true; }
    if (mod || e.key.startsWith('Arrow') || e.key === 'Shift') return false; // let modifiers/arrows pass
    // Any other key clears the selection and proceeds normally.
    this.#clearMultiSelect();
    return false;
  }

  #selectedMarkdown() {
    const chosen = this.blocks.filter((b) => this.selectedIds.has(b.id));
    return serialize(chosen);
  }

  #copySelected() {
    const md = this.#selectedMarkdown();
    if (md && navigator.clipboard?.writeText) navigator.clipboard.writeText(md).catch(() => {});
  }

  #deleteSelected() {
    if (!this.selectedIds.size) return;
    const indices = [...this.selectedIds].map((id) => this.#indexOf(id)).filter((i) => i >= 0);
    const firstIdx = Math.min(...indices);
    this.blocks = this.blocks.filter((b) => !this.selectedIds.has(b.id));
    if (this.blocks.length === 0) this.blocks.push(makeBlock('paragraph', ''));
    this.#clearMultiSelectState();
    this.focusedId = null;
    this.#render();
    const target = this.blocks[Math.min(firstIdx, this.blocks.length - 1)];
    if (target && !NONTEXT.has(target.type)) this.#focusBlock(target.id, 'start');
    this.#snapshot();
    this.onChange();
  }

  #clearMultiSelectState() {
    this.selectedIds = new Set();
    this._selectAnchor = null;
  }

  #clearMultiSelect() {
    if (!this.selectedIds.size && !this._selectAnchor) return;
    this.#clearMultiSelectState();
    this.#render();
  }

  // === undo / redo ========================================================

  // #snapshot is called AFTER a mutation is applied, so it records the
  // PRE-mutation state (this.baseline) onto the undo stack, then advances the
  // baseline to the new current state. This keeps the undo stack holding states
  // the user was in *before* each edit (first Ctrl+Z actually reverts).
  #snapshot(coalesce = false) {
    const now = Date.now();
    if (coalesce && now - this.lastSnapshotAt < 500 && this.undoStack.length) {
      // fold rapid typing: advance the baseline but add no new undo step
      this.lastSnapshotAt = now;
      this.baseline = this.#clone(this.blocks);
    } else {
      this.lastSnapshotAt = now;
      this.undoStack.push(this.baseline);
      this.baseline = this.#clone(this.blocks);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    // Every recorded change schedules autosave. Centralizing here guarantees no
    // structural edit (Enter/Backspace/Delete/Tab/shortcut) is left unsaved.
    this.onChange();
  }

  #undo() {
    if (!this.undoStack.length) return;
    this.#syncFocused();
    const prev = this.undoStack.pop();
    this.redoStack.push(this.#clone(this.blocks));
    this.blocks = prev;
    this.baseline = this.#clone(prev);
    this.focusedId = null;
    this.selectedId = null;
    this.#clearMultiSelectState(); // else a stale selection pins isEditing() true forever
    this.#render();
    this.onChange();
  }

  #redo() {
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop();
    this.undoStack.push(this.#clone(this.blocks));
    this.blocks = next;
    this.baseline = this.#clone(next);
    this.focusedId = null;
    this.selectedId = null;
    this.#clearMultiSelectState();
    this.#render();
    this.onChange();
  }

  #clone(blocks) {
    return blocks.map((b) => ({ id: b.id, type: b.type, text: b.text, meta: { ...b.meta } }));
  }
}
