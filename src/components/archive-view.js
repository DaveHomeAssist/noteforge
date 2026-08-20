import './archive-view.css';
import { Modal } from './modal.js';
import { escapeHtml, formatDate, truncate } from '../utils/helpers.js';

export function createArchiveElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'archive-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel archive-modal" role="dialog" aria-modal="true" aria-labelledby="archive-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="archive-title">Archive</h2><p class="muted">Notes kept out of active lists without moving them to Trash</p></div><button class="btn btn--ghost" data-close aria-label="Close Archive">✕</button></header>
      <div class="archive-layout"><div id="archive-list" class="archive-list" role="list" aria-label="Archived notes"></div><article id="archive-preview" class="archive-preview" aria-live="polite"><p class="muted">Choose an archived note to preview it.</p></article></div>
      <footer class="archive-footer"><span id="archive-status" role="status" aria-live="polite"></span><button class="btn btn--ghost" data-close>Close</button></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    list: overlay.querySelector('#archive-list'),
    preview: overlay.querySelector('#archive-preview'),
    status: overlay.querySelector('#archive-status'),
  };
}

export class ArchiveView {
  constructor(els, db, { onRestored = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.onRestored = onRestored;
    this.selectedId = null;
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.list.querySelector('button') || this.modal.panel });
    this.els.list.addEventListener('click', (event) => this.#onClick(event));
    this.unsubscribe = db.subscribe(() => { if (this.open) this.refresh(); });
  }

  get open() {
    return this.modal.isOpen;
  }

  show({ selectedId = null } = {}) {
    this.selectedId = selectedId;
    this.refresh();
    this.modal.open();
  }

  close() {
    this.modal.close();
  }

  refresh() {
    const notes = this.db.getArchived();
    if (!notes.some((note) => note.id === this.selectedId)) this.selectedId = notes[0]?.id || null;
    this.els.list.innerHTML = notes.length
      ? notes.map((note) => `<div class="archive-item" role="listitem" data-id="${escapeHtml(note.id)}">
          <button type="button" class="archive-item__preview${note.id === this.selectedId ? ' is-selected' : ''}" data-preview aria-pressed="${note.id === this.selectedId}"><strong>${escapeHtml(note.title || 'Untitled')}</strong><span>${escapeHtml(formatDate(note.archivedAt))}</span></button>
          <button type="button" class="btn btn--ghost" data-unarchive>Unarchive</button>
        </div>`).join('')
      : '<p class="muted archive-empty">Archive is empty.</p>';
    this.#renderPreview();
  }

  #renderPreview() {
    const note = this.selectedId ? this.db.getArchivedNote(this.selectedId) : null;
    this.els.preview.innerHTML = note
      ? `<h3>${escapeHtml(note.title || 'Untitled')}</h3><p class="muted">Archived ${escapeHtml(formatDate(note.archivedAt))}${note.parentId ? ' · hierarchy retained' : ''}</p><pre>${escapeHtml(truncate(note.content, 2_000) || 'Empty note')}</pre><button type="button" class="btn btn--primary" data-unarchive-preview>Unarchive and open</button>`
      : '<p class="muted">Choose an archived note to preview it.</p>';
    this.els.preview.querySelector('[data-unarchive-preview]')?.addEventListener('click', () => this.#restore(this.selectedId, true));
  }

  #onClick(event) {
    const item = event.target.closest('.archive-item');
    if (!item) return;
    if (event.target.closest('[data-unarchive]')) this.#restore(item.dataset.id, false);
    else if (event.target.closest('[data-preview]')) {
      this.selectedId = item.dataset.id;
      this.refresh();
      [...this.els.list.querySelectorAll('[data-preview]')]
        .find((button) => button.closest('.archive-item')?.dataset.id === this.selectedId)
        ?.focus();
    }
  }

  async #restore(id, openAfter) {
    const note = this.db.getArchivedNote(id);
    if (!note) return;
    try {
      if (!this.db.unarchiveNote(id)) return;
      await this.db.flush();
      this.els.status.textContent = `“${note.title}” was unarchived.`;
      if (openAfter) {
        this.close();
        this.onRestored(note.id);
      } else {
        const next = this.els.list.querySelector('button');
        if (next) next.focus();
        else this.modal.focusInitial();
      }
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
    }
  }
}
