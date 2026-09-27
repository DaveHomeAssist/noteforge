// Command palette (Ctrl/⌘+P) — the app's keyboard spine. Blends notes and
// commands by default; `>` restricts to commands, `#` searches headings across
// notes. Fuzzy-ranked with match highlighting; results sit under labelled
// groups (the best-scoring group first), commands show their shortcut keys, and
// wide screens preview the active result. Focus/inert/Esc come from Modal.

import { fuzzyMatch, fuzzyHighlight } from '../utils/fuzzy.js';
import { escapeHtml, formatDate } from '../utils/helpers.js';
import { splitFrontmatterSource } from '../utils/frontmatter-boundary.js';
import { Modal } from './modal.js';
import { extractHeadings } from '../utils/headings.js';
import './command-palette.css';
import { icon, isIconName } from '../ui/icons.js';

const RECENT_LIMIT = 6;
const MAX_RESULTS = 50;
const PREVIEW_CHARS = 480;
const GROUP_LABELS = {
  recent: 'Recent',
  notes: 'Notes',
  tags: 'Tags',
  views: 'Views',
  commands: 'Commands',
  headings: 'Headings',
};

const keyChips = (keys) => keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join('');

/** Inline Markdown to plain text: links, wikilinks, emphasis, and code marks. */
const plainInline = (text) =>
  text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2');

/**
 * Readable text for a preview: no frontmatter or block markers, and soft line
 * breaks inside a paragraph joined as the rendered note would show them.
 */
function plainPreview(markdown) {
  const lines = [];
  let continues = false; // the last line is paragraph or list text a plain line may continue
  for (const raw of splitFrontmatterSource(markdown).body.split('\n')) {
    const marker = /^[ \t]*(#{1,6}|>|[-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/.exec(raw);
    const line = plainInline(marker ? raw.slice(marker[0].length) : raw).trim();
    if (!line) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continues = false;
      continue;
    }
    if (!marker && continues) lines[lines.length - 1] += ` ${line}`;
    else lines.push(line);
    continues = !marker?.[1].startsWith('#');
  }
  const text = lines.join('\n').trim();
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '')}…`;
}

export function createCommandPaletteElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal palette';
  overlay.id = 'palette-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel palette__panel" role="dialog" aria-modal="true" aria-label="Command palette" tabindex="-1"><input id="palette-input" class="palette__input" type="text" autocomplete="off" spellcheck="false" placeholder="Search notes…   ·   &gt; commands   ·   # headings" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"><div class="palette__body"><div id="palette-list" class="palette__list" role="listbox" aria-label="Results"></div><aside class="palette__preview" aria-hidden="true"></aside></div></div>`;
  root.appendChild(overlay);
  return {
    overlay,
    input: overlay.querySelector('#palette-input'),
    list: overlay.querySelector('#palette-list'),
    preview: overlay.querySelector('.palette__preview'),
  };
}

export class CommandPalette {
  /**
   * @param {{ overlay:HTMLElement, input:HTMLInputElement, list:HTMLElement, preview?:HTMLElement }} els
   * @param {{ getNotes:()=>object[], getRecentNotes?:()=>object[], getCommands:()=>object[],
   *   onOpenNote:(id:string)=>void, onOpenHeading?:(id:string,anchor:string)=>void,
   *   getTags?:()=>Array<[string, number]>, onOpenTag?:(tag:string)=>void }} opts
   */
  constructor(els, { getNotes, getRecentNotes, getCommands, onOpenNote, onOpenHeading, getTags, onOpenTag }) {
    this.els = els;
    this.getNotes = getNotes;
    this.getCommands = getCommands;
    this.onOpenNote = onOpenNote;
    this.getRecentNotes = getRecentNotes || (() => []);
    this.onOpenHeading = onOpenHeading || ((id) => this.onOpenNote(id));
    this.getTags = getTags || (() => []);
    this.onOpenTag = onOpenTag || (() => {});
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
    return grouped(this.#mixedItems(q));
  }

  #mixedItems(q) {
    const notes = this.getNotes();
    const cmds = this.getCommands();
    if (!q) {
      const persistedRecent = this.getRecentNotes();
      const recent = (
        persistedRecent.length
          ? persistedRecent
          : [...notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      )
        .slice(0, RECENT_LIMIT)
        .map((n) => ({ ...this.#noteItem(n, [], 'Recent note'), group: 'recent' }));
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
    for (const [tag, count] of this.getTags()) {
      const m = fuzzyMatch(q.replace(/^#/, ''), tag);
      if (m) scored.push({ score: m.score - 2, item: this.#tagItem(tag, count, m.positions) }); // below exact notes
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
      for (const heading of extractHeadings(n.content)) {
        out.push({ noteId: n.id, noteTitle: n.title || 'Untitled', note: n, ...heading });
      }
    }
    return out;
  }

  // --- item factories -----------------------------------------------------

  #noteItem(note, positions, sub = null) {
    return {
      group: 'notes',
      icon: note.pinned ? 'pin' : 'file-text',
      labelHtml: fuzzyHighlight(note.title || 'Untitled', positions),
      sub: sub || (note.tags.length ? note.tags.map((t) => '#' + t).join(' ') : 'Note'),
      note,
      run: () => this.onOpenNote(note.id),
    };
  }

  #tagItem(tag, count, positions) {
    return {
      group: 'tags',
      icon: 'hash',
      labelHtml: fuzzyHighlight(tag, positions),
      title: `#${tag}`,
      sub: `${count} note${count === 1 ? '' : 's'}`,
      run: () => this.onOpenTag(tag),
    };
  }

  #cmdItem(cmd, positions) {
    return {
      group: cmd.group || 'commands',
      icon: cmd.icon || 'zap',
      labelHtml: fuzzyHighlight(cmd.title, positions),
      title: cmd.title,
      sub: cmd.hint || 'Command',
      keys: cmd.keys || [],
      run: cmd.run,
    };
  }

  #headingItem(h, positions) {
    return {
      group: 'headings',
      icon: `heading-${Math.min(6, Math.max(1, h.level))}`,
      labelHtml: fuzzyHighlight(h.text, positions),
      sub: h.noteTitle,
      note: h.note,
      run: () => this.onOpenHeading(h.noteId, h.anchor),
    };
  }

  // --- rendering ----------------------------------------------------------

  #render(raw) {
    if (this.items.length === 0) {
      const hint = raw.trim().startsWith('#') ? 'No matching headings.' : 'No matches.';
      this.els.list.innerHTML = `<p class="muted palette__empty">${hint}</p>`;
      this.els.input.removeAttribute('aria-activedescendant');
      this.#renderPreview();
      return;
    }
    const option = (it, i) => `
        <button type="button" id="palette-opt-${i}" class="palette__item${i === this.active ? ' palette__item--active' : ''}" data-index="${i}" role="option" aria-selected="${i === this.active}">
          <span class="palette__icon">${isIconName(it.icon) ? icon(it.icon) : escapeHtml(it.icon)}</span>
          <span class="palette__label">${it.labelHtml}</span>
          <span class="palette__sub">${escapeHtml(it.sub)}</span>
          ${it.keys?.length ? `<span class="palette__keys">${keyChips(it.keys)}</span>` : ''}
        </button>`;
    // Consecutive items of one group render under that group's label.
    const runs = [];
    this.items.forEach((it, i) => {
      if (runs.at(-1)?.group !== it.group) runs.push({ group: it.group, entries: [] });
      runs.at(-1).entries.push(option(it, i));
    });
    this.els.list.innerHTML = runs
      .map(
        ({ group, entries }) => `<div class="palette__group" role="group" aria-labelledby="palette-group-${group}">
          <div class="palette__group-label" id="palette-group-${group}" aria-hidden="true">${GROUP_LABELS[group]}</div>
          ${entries.join('')}
        </div>`,
      )
      .join('');
    this.els.input.setAttribute('aria-activedescendant', `palette-opt-${this.active}`);
    this.#renderPreview();
  }

  /** Preview of the active result (hidden below 1024 px by CSS). */
  #renderPreview() {
    const pane = this.els.preview;
    if (!pane) return;
    const item = this.items[this.active];
    if (!item) {
      pane.innerHTML = '';
      return;
    }
    if (item.note) {
      const note = item.note;
      const body = plainPreview(note.content);
      const tags = note.tags?.length ? ` · ${note.tags.map((t) => '#' + t).join(' ')}` : '';
      pane.innerHTML = `<h3 class="palette__preview-title">${escapeHtml(note.title || 'Untitled')}</h3>
        <p class="palette__preview-meta">Edited ${escapeHtml(formatDate(note.updatedAt))}${escapeHtml(tags)}</p>
        <p class="palette__preview-text">${escapeHtml(body) || '<span class="muted">Empty note</span>'}</p>`;
      return;
    }
    pane.innerHTML = `<h3 class="palette__preview-title">${escapeHtml(item.title || '')}</h3>
      <p class="palette__preview-meta">${escapeHtml(item.sub)}</p>
      ${item.keys?.length ? `<p class="palette__preview-keys">${keyChips(item.keys)}</p>` : ''}
      <p class="palette__preview-text muted">Press Enter to run.</p>`;
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
    this.#renderPreview();
  }

  #onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.#setActive(Math.min(this.active + 1, this.items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.#setActive(Math.max(this.active - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.#setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      this.#setActive(this.items.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.#activate(this.active);
    }
  }

  #activate(i) {
    const item = this.items[i];
    if (!item) return;
    this.close(); // restore focus first; the action may move focus itself
    item.run?.();
  }
}

/**
 * Stable-group scored results: groups appear in the order of their best result
 * (the input is already sorted by score) and keep their internal order.
 */
function grouped(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.values()].flat();
}
