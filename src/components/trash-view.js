// Trash: a modal listing soft-deleted notes with Restore / Delete-forever, plus
// Empty-trash. Notes live in the store with a `deletedAt` marker; this view is
// the only place they resurface. Keeps a count badge on the menu item in sync.
// Focus/inert/keyboard handling is delegated to the shared Modal controller.

import { escapeHtml, truncate, formatDate } from '../utils/helpers.js';
import { Modal } from './modal.js';

export class TrashView {
  /**
   * @param {{ overlay:HTMLElement, list:HTMLElement, empty:HTMLButtonElement, badge:HTMLElement }} els
   * @param {import('../core/database.js').Database} db
   * @param {(id:string)=>void} onOpenNote  called after a restore, to open the note
   */
  constructor(els, db, onOpenNote) {
    this.els = els;
    this.db = db;
    this.onOpenNote = onOpenNote;
    this.modal = new Modal(els.overlay);

    this.els.list.addEventListener('click', (e) => this.#onListClick(e));
    this.els.empty.addEventListener('click', () => this.#empty());

    // Keep the badge fresh as the store changes; re-render if the modal is open.
    // A background emit (or a purge) rebuilds the list via innerHTML and would
    // otherwise drop keyboard focus to <body> — so re-anchor focus in the dialog.
    this.db.subscribe(() => {
      this.updateBadge();
      if (this.modal.isOpen) {
        const hadFocus = this.els.overlay.contains(document.activeElement);
        this.#renderList();
        if (hadFocus && !this.els.overlay.contains(document.activeElement)) this.modal.focusInitial();
      }
    });
    this.updateBadge();
  }

  /** True while the modal is open (read by App to gate global shortcuts). */
  get open() {
    return this.modal.isOpen;
  }

  updateBadge() {
    const n = this.db.getTrash().length;
    if (!this.els.badge) return;
    this.els.badge.textContent = n ? String(n) : '';
    this.els.badge.hidden = n === 0;
  }

  show() {
    this.#renderList();
    this.modal.open();
  }

  close() {
    this.modal.close();
  }

  toggle() {
    this.modal.isOpen ? this.close() : this.show();
  }

  // --- rendering ----------------------------------------------------------

  #renderList() {
    const trashed = this.db.getTrash();
    this.els.empty.disabled = trashed.length === 0;
    if (trashed.length === 0) {
      this.els.list.innerHTML = `<p class="muted trash-empty">Trash is empty.</p>`;
      return;
    }
    this.els.list.innerHTML = trashed
      .map(
        (note) => `
        <div class="trash-item" data-id="${escapeHtml(note.id)}">
          <div class="trash-item__body">
            <span class="trash-item__title">${escapeHtml(note.title || 'Untitled')}</span>
            <span class="trash-item__snippet">${escapeHtml(truncate(note.content, 80))}</span>
            <span class="trash-item__meta muted">Deleted ${formatDate(note.deletedAt)}</span>
          </div>
          <div class="trash-item__actions">
            <button class="btn btn--ghost" data-act="restore">Restore</button>
            <button class="btn btn--danger-ghost" data-act="purge" title="Delete permanently">Delete forever</button>
          </div>
        </div>`
      )
      .join('');
  }

  // --- actions ------------------------------------------------------------

  #onListClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.trash-item')?.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'restore') {
      if (this.db.restoreNote(id)) {
        this.close();
        this.onOpenNote?.(id);
      }
    } else if (btn.dataset.act === 'purge') {
      const note = this.db.getTrash().find((n) => n.id === id);
      const label = note ? `"${note.title || 'Untitled'}"` : 'this note';
      if (confirm(`Permanently delete ${label}? This cannot be undone.`)) {
        this.db.purgeNote(id);
      }
    }
  }

  #empty() {
    const n = this.db.getTrash().length;
    if (n === 0) return;
    if (confirm(`Permanently delete ${n} note${n === 1 ? '' : 's'} in the Trash? This cannot be undone.`)) {
      this.db.emptyTrash();
    }
  }
}
