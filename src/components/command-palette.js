// Command palette (Ctrl/⌘+P) — the app's keyboard spine. Blends notes and
// commands by default; `>` restricts to commands, `#` searches headings across
// notes. Fuzzy-ranked with match highlighting. Focus/inert/Esc come from Modal.

import { fuzzyMatch, fuzzyHighlight } from '../utils/fuzzy.js';
import { escapeHtml } from '../utils/helpers.js';
import { Modal } from './modal.js';

const RECENT_LIMIT = 6;
const MAX_RESULTS = 50;

export class CommandPalette {
  /**
   * @param {{ overlay:HTMLElement, input:HTMLInputElement, list:HTMLElement }} els
   * @param {{ getNotes:()=>object[], getCommands:()=>object[], onOpenNote:(id:string)=>void }} opts
   */
  constructor(els, { getNotes, getCommands, onOpenNote }) {
    this.els = els;
    this.getNotes = getNotes;
    this.getCommands = getCommands;
    this.onOpenNote = onOpenNote;
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.input });
    this.items = [];
    this.active = 0;
    this._pointer = { x: null, y: null };

    this.els.input.addEventListener('input', () => this.#refresh());
    this.els.input.addEventListener('keydown', (e) => this.#onKey(e));
    this.els.list.addEventListener('click', (e) => {
      const row = e.target.closest('.palette__item');
      if (row) this.#activate(Number(row.dataset.index));
    });
    // Hover selects a row — but ignore the synthetic mousemove a browser fires over
    // a stationary pointer when the list scrolls during keyboard navigation (that
    // would otherwise yank the selection back to whatever row is under the cursor).
    this.els.list.addEventListener('mousemove', (e) => {
      if (e.clientX === this._pointer.x && e.clientY === this._pointer.y) return;
      this._pointer = { x: e.clientX, y: e.clientY };
      const row = e.target.closest('.palette__item');
      if (row) this.#setActive(Number(row.dataset.index));
    });
  }

  get open() {
    return this.modal.isOpen;
  }

  show(prefill = '') {
    this.els.input.value = prefill;
    this.#refresh();
    this.modal.open(); // focuses the input
    // Put the caret at the end so a prefilled prefix (e.g. "> ") is ready to type after.
    const len = this.els.input.value.length;
    this.els.input.setSelectionRange?.(len, len);
  }

  close() {
    this.modal.close();
  }

  toggle() {
    this.modal.isOpen ? this.close() : this.show();
  }

  // --- query -> results ---------------------------------------------------

  #refresh() {
    const raw = this.els.input.value;
    this.items = this.#compute(raw);
    this.active = 0;
    this.#render(raw);
  }

  #compute(raw) {
    const q = raw.trim();
    if (q.startsWith('>')) return this.#commandItems(q.slice(1).trim());
    if (q.startsWith('#')) return this.#headingItems(q.slice(1).trim());
    return this.#mixedItems(q);
  }

  #mixedItems(q) {
    const notes = this.getNotes();
    const cmds = this.getCommands();
    if (!q) {
      const recent = [...notes]
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, RECENT_LIMIT)
        .map((n) => this.#noteItem(n, []));
      return recent.concat(cmds.map((c) => this.#cmdItem(c, [])));
    }
    const scored = [];
    for (const n of notes) {
      const m = fuzzyMatch(q, n.title || 'Untitled');
      if (m) scored.push({ score: m.score + 5, item: this.#noteItem(n, m.positions) }); // gentle note bias
    }
    for (const c of cmds) {
      const m = fuzzyMatch(q, c.title);
      if (m) scored.push({ score: m.score, item: this.#cmdItem(c, m.positions) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.item);
  }

  #commandItems(q) {
    const cmds = this.getCommands();
    if (!q) return cmds.map((c) => this.#cmdItem(c, []));
    const scored = [];
    for (const c of cmds) {
      const m = fuzzyMatch(q, c.title);
      if (m) scored.push({ score: m.score, item: this.#cmdItem(c, m.positions) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }

  #headingItems(q) {
    const headings = this.#allHeadings();
    if (!q) return headings.slice(0, MAX_RESULTS).map((h) => this.#headingItem(h, []));
    const scored = [];
    for (const h of headings) {
      const m = fuzzyMatch(q, h.text);
      if (m) scored.push({ score: m.score, item: this.#headingItem(h, m.positions) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.item);
  }

  /** Markdown headings across all live notes (fenced code blocks excluded). */
  #allHeadings() {
    const out = [];
    for (const n of this.getNotes()) {
      let inFence = false;
      for (const line of String(n.content || '').split('\n')) {
        // Only a column-0 ``` is a fence (matches blocks.js); indented backticks
        // are literal text and must not toggle fence state or hide real headings.
        if (/^```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (m) out.push({ noteId: n.id, noteTitle: n.title || 'Untitled', text: m[2], level: m[1].length });
      }
    }
    return out;
  }

  // --- item factories -----------------------------------------------------

  #noteItem(note, positions) {
    return {
      icon: note.pinned ? '📌' : '📄',
      labelHtml: fuzzyHighlight(note.title || 'Untitled', positions),
      sub: note.tags.length ? note.tags.map((t) => '#' + t).join(' ') : 'Note',
      run: () => this.onOpenNote(note.id),
    };
  }

  #cmdItem(cmd, positions) {
    return {
      icon: cmd.icon || '⚡',
      labelHtml: fuzzyHighlight(cmd.title, positions),
      sub: cmd.hint || 'Command',
      run: cmd.run,
    };
  }

  #headingItem(h, positions) {
    return {
      icon: 'H' + h.level,
      labelHtml: fuzzyHighlight(h.text, positions),
      sub: h.noteTitle,
      run: () => this.onOpenNote(h.noteId),
    };
  }

  // --- rendering ----------------------------------------------------------

  #render(raw) {
    if (this.items.length === 0) {
      const hint = raw.trim().startsWith('#') ? 'No matching headings.' : 'No matches.';
      this.els.list.innerHTML = `<p class="muted palette__empty">${hint}</p>`;
      this.els.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.els.list.innerHTML = this.items
      .map(
        (it, i) => `
        <button type="button" id="palette-opt-${i}" class="palette__item${i === this.active ? ' palette__item--active' : ''}" data-index="${i}" role="option" aria-selected="${i === this.active}">
          <span class="palette__icon">${escapeHtml(it.icon)}</span>
          <span class="palette__label">${it.labelHtml}</span>
          <span class="palette__sub">${escapeHtml(it.sub)}</span>
        </button>`
      )
      .join('');
    this.els.input.setAttribute('aria-activedescendant', `palette-opt-${this.active}`);
  }

  #setActive(i) {
    if (i < 0 || i >= this.items.length || i === this.active) return;
    this.active = i;
    const rows = this.els.list.querySelectorAll('.palette__item');
    rows.forEach((row, idx) => {
      const on = idx === i;
      row.classList.toggle('palette__item--active', on);
      row.setAttribute('aria-selected', String(on));
    });
    this.els.input.setAttribute('aria-activedescendant', `palette-opt-${i}`);
    rows[i]?.scrollIntoView({ block: 'nearest' });
  }

  #onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.#setActive(Math.min(this.active + 1, this.items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.#setActive(Math.max(this.active - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); this.#setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); this.#setActive(this.items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.#activate(this.active); }
  }

  #activate(i) {
    const item = this.items[i];
    if (!item) return;
    this.close(); // restore focus first; the action may move focus itself
    item.run?.();
  }
}
