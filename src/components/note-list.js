// Sidebar list: search box, sort control, tag-filter chips, and the note tree.
// With no free-text query and no tag filter, notes render as a collapsible
// parent/child outline (drag to re-nest, ＋ to add a child). While searching or
// tag-filtering, results are a flat, relevance-ranked list.

import { escapeHtml, truncate, formatDate } from '../utils/helpers.js';
import { parseQuery, noteMatchesFilters, scoreNote } from '../utils/search-query.js';
import { fuzzyHighlight } from '../utils/fuzzy.js';
import { buildForest, flattenForest } from '../utils/tree.js';

const SORT_MODES = ['updated', 'created', 'title'];
const ROW_STRIDE = 72; // px per row — MUST equal the fixed .note-item height in styles.css
const VIRTUALIZE_THRESHOLD = 80; // below this many rows, just render them all
const OVERSCAN = 6; // rows rendered beyond the viewport on each side

export class NoteList {
  /**
   * @param {{ list:HTMLElement, tags:HTMLElement, count:HTMLElement, search:HTMLInputElement, sort?:HTMLSelectElement }} els
   * @param {import('../core/database.js').Database} db
   * @param {{ onOpen:(id:string)=>void, onTogglePin:(id:string)=>void,
   *           onReparent?:(id:string, parentId:string|null)=>void, onNewChild?:(parentId:string)=>void }} handlers
   */
  constructor(els, db, handlers) {
    this.els = els;
    this.db = db;
    this.onOpen = handlers.onOpen;
    this.onTogglePin = handlers.onTogglePin;
    this.onReparent = handlers.onReparent;
    this.onNewChild = handlers.onNewChild;
    this.query = '';
    this.activeTag = null;
    this.activeId = null;
    this.dragId = null;
    this.collapsed = new Set(Array.isArray(db.config.collapsed) ? db.config.collapsed : []);

    this.els.search.addEventListener('input', () => {
      this.query = this.els.search.value;
      this.#renderList();
    });
    this.els.list.addEventListener('click', (e) => this.#onListClick(e));
    this.els.tags.addEventListener('click', (e) => this.#onTagClick(e));
    this.els.list.addEventListener('dragstart', (e) => this.#onDragStart(e));
    this.els.list.addEventListener('dragover', (e) => this.#onDragOver(e));
    this.els.list.addEventListener('drop', (e) => this.#onDrop(e));
    this.els.list.addEventListener('dragend', () => this.#clearDrag());
    this.els.list.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    if (this.els.sort) {
      this.els.sort.value = this.#sortMode();
      this.els.sort.addEventListener('change', () => {
        const mode = SORT_MODES.includes(this.els.sort.value) ? this.els.sort.value : 'updated';
        this.db.setConfig({ sortMode: mode });
        this.#renderList();
      });
    }
  }

  setActive(id) {
    this.activeId = id;
    this.#markActive();
  }

  focusSearch() {
    this.els.search.focus();
    this.els.search.select();
  }

  render() {
    if (this.els.sort) this.els.sort.value = this.#sortMode();
    this.#renderTags();
    this.#renderList();
  }

  // --- tag filter ---------------------------------------------------------

  #renderTags() {
    const counts = [...this.db.tagCounts().entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (counts.length === 0) { this.els.tags.innerHTML = ''; return; }
    const chips = counts
      .map(
        ([tag, n]) => `
        <button class="tag-chip ${this.activeTag === tag ? 'tag-chip--on' : ''}" data-tag="${escapeHtml(tag)}" aria-pressed="${this.activeTag === tag}">
          #${escapeHtml(tag)}<span class="tag-chip__n">${n}</span>
        </button>`
      )
      .join('');
    const clear = this.activeTag ? `<button class="tag-chip tag-chip--clear" data-tag="">✕ clear</button>` : '';
    this.els.tags.innerHTML = chips + clear;
  }

  #onTagClick(e) {
    const btn = e.target.closest('.tag-chip');
    if (!btn) return;
    const tag = btn.dataset.tag;
    this.activeTag = tag === '' || tag === this.activeTag ? null : tag;
    this.render();
  }

  // --- ordering + rows ----------------------------------------------------

  #sortMode() {
    const m = this.db.config?.sortMode;
    return SORT_MODES.includes(m) ? m : 'updated';
  }

  #siblingComparator() {
    const base = {
      updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      created: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      title: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
    }[this.#sortMode()];
    return (a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || base(a, b);
  }

  /** @returns {{ rows:{note,depth,hasChildren,collapsed,titlePositions}[], searching:boolean }} */
  #currentRows() {
    const live = this.db.getAllNotes();
    const { text, filters } = parseQuery(this.query);
    const q = text.trim();
    // A scoped filter (tag:/has:banner/is:pinned/in:title) counts as searching even
    // with no free text — otherwise the tree view would ignore the filter.
    const hasFilters = filters.tags.length > 0 || filters.hasBanner === true || filters.pinned === true || filters.inTitle === true;
    const searching = !!q || !!this.activeTag || hasFilters;

    if (searching) {
      // Flat, relevance-ranked results (hierarchy is irrelevant while filtering).
      const filtered = live.filter(
        (n) => noteMatchesFilters(n, filters) && (!this.activeTag || n.tags.includes(this.activeTag))
      );
      const scored = filtered
        .map((n) => {
          const s = q ? scoreNote(q, n, { inTitle: filters.inTitle }) : { score: 0, titlePositions: [] };
          return s ? { note: n, titlePositions: s.titlePositions, score: s.score } : null;
        })
        .filter(Boolean);
      if (q) scored.sort((a, b) => b.score - a.score || new Date(b.note.updatedAt) - new Date(a.note.updatedAt));
      else scored.sort((a, b) => this.#siblingComparator()(a.note, b.note));
      return { searching, rows: scored.map((r) => ({ note: r.note, depth: 0, hasChildren: false, collapsed: false, titlePositions: r.titlePositions })) };
    }

    // Outline tree. First prune collapsed ids that no longer refer to a parent
    // note (deleted/purged), so config.collapsed can't grow without bound.
    if (this.collapsed.size) {
      const parentIds = new Set();
      for (const n of live) if (n.parentId) parentIds.add(n.parentId);
      let pruned = false;
      for (const id of [...this.collapsed]) if (!parentIds.has(id)) { this.collapsed.delete(id); pruned = true; }
      if (pruned) this.db.setConfig({ collapsed: [...this.collapsed] });
    }
    const forest = buildForest(live, { sort: this.#siblingComparator() });
    return { searching, rows: flattenForest(forest, this.collapsed).map((r) => ({ ...r, titlePositions: [] })) };
  }

  #renderList() {
    // Never rebuild the list mid-drag — it would detach the dragged row and
    // strand dragId. Defer and flush when the drag ends.
    if (this.dragId) { this._pendingRender = true; return; }
    const { rows, searching } = this.#currentRows();
    this._rows = rows;
    const total = this.db.getAllNotes().length;
    this.els.count.textContent = searching
      ? `${rows.length} match${rows.length === 1 ? '' : 'es'}`
      : `${total} note${total === 1 ? '' : 's'}`;

    if (rows.length === 0) {
      this.els.list.innerHTML = `<p class="muted note-list__empty">${
        searching ? 'No matching notes.' : 'No notes yet — create one!'
      }</p>`;
      this._window = null;
      return;
    }
    this.#paintWindow();
  }

  /** Render only the visible slice of rows (windowing) for large lists. Below the
   *  threshold, renders everything (keeps drag/click simple for the common case). */
  #paintWindow() {
    const rows = this._rows || [];
    const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
    let start = 0;
    let end = rows.length;
    if (virtualize) {
      const viewport = this.els.list.clientHeight || 600;
      // Clamp a stale scroll position (e.g. after collapsing a big subtree the
      // content shrank) so the window can't end up past the content -> blank list.
      const maxScroll = Math.max(0, rows.length * ROW_STRIDE - viewport);
      if (this.els.list.scrollTop > maxScroll) this.els.list.scrollTop = maxScroll;
      const scrollTop = this.els.list.scrollTop;
      start = Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - OVERSCAN);
      end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_STRIDE) + OVERSCAN);
    }
    const topPad = start * ROW_STRIDE;
    const botPad = (rows.length - end) * ROW_STRIDE;
    const freeText = parseQuery(this.query).text.trim();
    const parts = [];
    if (topPad) parts.push(`<div class="note-list__pad" style="height:${topPad}px"></div>`);
    for (let i = start; i < end; i++) parts.push(this.#rowHtml(rows[i], freeText));
    if (botPad) parts.push(`<div class="note-list__pad" style="height:${botPad}px"></div>`);
    this.els.list.innerHTML = parts.join('');
    this._window = { start, end, virtualize };
    this.#markActive();
  }

  #onScroll() {
    if (!this._window?.virtualize || this.dragId) return;
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      if (this._window?.virtualize && !this.dragId) this.#paintWindow();
    });
  }

  #rowHtml(row, freeText) {
    const { note, depth, hasChildren, collapsed, titlePositions } = row;
    const title = titlePositions.length
      ? fuzzyHighlight(note.title || 'Untitled', titlePositions)
      : this.#hlSubstring(note.title || 'Untitled', freeText);
    const twist = hasChildren
      ? `<button class="note-item__twist" data-twist aria-label="${collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>`
      : `<span class="note-item__twist note-item__twist--leaf" aria-hidden="true"></span>`;
    return `
        <div class="note-item ${note.id === this.activeId ? 'note-item--on' : ''} ${note.pinned ? 'note-item--pinned' : ''}"
             data-id="${escapeHtml(note.id)}" draggable="true" style="--depth:${depth}">
          ${twist}
          <button class="note-item__main" data-open>
            <span class="note-item__title">${title}</span>
            <span class="note-item__snippet">${this.#hlSubstring(truncate(note.content, 90), freeText)}</span>
            <span class="note-item__meta">
              ${formatDate(note.updatedAt)}
              ${note.tags.length ? `· ${note.tags.map((t) => '#' + escapeHtml(t)).join(' ')}` : ''}
            </span>
          </button>
          <button class="note-item__add" data-add title="New sub-note" aria-label="New sub-note">＋</button>
          <button class="note-item__pin" data-pin title="${note.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${note.pinned}">📌</button>
        </div>`;
  }

  #onListClick(e) {
    const item = e.target.closest('.note-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('[data-twist]')) { this.#toggleCollapse(id); return; }
    if (e.target.closest('[data-pin]')) { this.onTogglePin?.(id); return; }
    if (e.target.closest('[data-add]')) { this.onNewChild?.(id); return; }
    this.onOpen(id);
  }

  #toggleCollapse(id) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.db.setConfig({ collapsed: [...this.collapsed] });
    this.#renderList();
  }

  /** Ensure a note is visible by expanding all its ancestors. Returns whether anything changed. */
  expandTo(id) {
    let changed = false;
    for (const anc of this.db.ancestorsOf(id)) {
      if (this.collapsed.delete(anc.id)) changed = true;
    }
    if (changed) this.db.setConfig({ collapsed: [...this.collapsed] });
    return changed;
  }

  /** Reveal a note: expand collapsed ancestors AND (when virtualized) scroll it into
   *  the render window so the opened note is visible and can be highlighted. */
  reveal(id) {
    if (this.expandTo(id)) this.#renderList(); // fresh _rows incl. the revealed descendant
    if (!this._window?.virtualize) return;
    const idx = (this._rows || []).findIndex((r) => r.note.id === id);
    if (idx < 0) return;
    if (idx >= this._window.start && idx < this._window.end) return; // already rendered
    const viewport = this.els.list.clientHeight || 600;
    const max = Math.max(0, this._rows.length * ROW_STRIDE - viewport);
    this.els.list.scrollTop = Math.max(0, Math.min(idx * ROW_STRIDE, max));
    this.#paintWindow();
  }

  #markActive() {
    this.els.list.querySelectorAll('.note-item').forEach((el) => {
      el.classList.toggle('note-item--on', el.dataset.id === this.activeId);
    });
  }

  // --- drag to re-nest ----------------------------------------------------

  #onDragStart(e) {
    const item = e.target.closest('.note-item');
    if (!item) return;
    this.dragId = item.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', this.dragId); } catch { /* some browsers */ }
    item.classList.add('note-item--dragging');
  }

  #onDragOver(e) {
    if (!this.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.#clearDropMarks();
    const item = e.target.closest('.note-item');
    if (item && item.dataset.id !== this.dragId) item.classList.add('note-item--drop-into');
    else if (e.target === this.els.list || e.target.closest('.note-list__pad')) this.els.list.classList.add('note-list--drop-root');
  }

  #onDrop(e) {
    if (!this.dragId) return;
    e.preventDefault();
    const item = e.target.closest('.note-item');
    const dragged = this.dragId;
    this.#clearDrag();
    if (item) {
      if (item.dataset.id === dragged) return; // dropped on itself — no-op
      this.onReparent?.(dragged, item.dataset.id); // nest under target
    } else if (e.target === this.els.list || e.target.closest('.note-list__pad')) {
      this.onReparent?.(dragged, null); // genuine empty space or a virtualization pad — move to top level
    }
    // else: an ambiguous near-miss between rows — do nothing (don't silently un-nest)
  }

  #clearDropMarks() {
    this.els.list.classList.remove('note-list--drop-root');
    this.els.list.querySelectorAll('.note-item--drop-into').forEach((el) => el.classList.remove('note-item--drop-into'));
  }

  #clearDrag() {
    this.dragId = null;
    this.#clearDropMarks();
    this.els.list.querySelectorAll('.note-item--dragging').forEach((el) => el.classList.remove('note-item--dragging'));
    if (this._pendingRender) { this._pendingRender = false; this.#renderList(); } // flush a render deferred during the drag
  }

  /** Escape text, then highlight literal occurrences of `query`, safe against entities. */
  #hlSubstring(text, query) {
    const raw = String(text ?? '');
    const q = query.trim();
    if (!q) return escapeHtml(raw);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      out += escapeHtml(raw.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out + escapeHtml(raw.slice(last));
  }
}
