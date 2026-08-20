import './bulk-actions-view.css';
import { BulkOperations } from '../core/bulk-operations.js';
import { downloadText } from '../utils/download.js';
import { escapeHtml } from '../utils/helpers.js';

export function createBulkActionElements({ anchor = document.getElementById('note-list') } = {}) {
  const bar = document.createElement('section');
  bar.className = 'bulk-actions';
  bar.hidden = true;
  bar.setAttribute('aria-labelledby', 'bulk-actions-title');
  bar.innerHTML = `<header><strong id="bulk-actions-title">0 selected</strong><button type="button" class="btn btn--ghost" data-bulk-clear aria-label="Clear note selection">✕</button></header><div class="bulk-actions__row"><label><span class="sr-only">Tag to add</span><input data-bulk-tag placeholder="Tag"></label><button type="button" class="btn btn--ghost" data-bulk-action="tag">Add tag</button><button type="button" class="btn btn--ghost" data-bulk-action="archive">Archive</button><button type="button" class="btn btn--ghost" data-bulk-action="unarchive">Unarchive</button></div><div class="bulk-actions__row"><label class="bulk-actions__parent"><span class="sr-only">New parent</span><select data-bulk-parent><option value="">Top level</option></select></label><button type="button" class="btn btn--ghost" data-bulk-action="reparent">Move</button><button type="button" class="btn btn--ghost" data-bulk-export>Export</button><button type="button" class="btn btn--danger-ghost" data-bulk-action="trash">Move to Trash</button></div><span class="bulk-actions__status" role="status" aria-live="polite"></span>`;
  const announcer = document.createElement('span');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  anchor?.parentNode?.insertBefore(bar, anchor);
  bar.parentNode?.insertBefore(announcer, anchor);
  return {
    bar,
    title: bar.querySelector('#bulk-actions-title'),
    status: bar.querySelector('.bulk-actions__status'),
    tag: bar.querySelector('[data-bulk-tag]'),
    parent: bar.querySelector('[data-bulk-parent]'),
    announcer,
  };
}

export class BulkActionsView {
  constructor(els, db, noteList, { confirmAction = () => false, onApplied = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.noteList = noteList;
    this.bulk = new BulkOperations(db);
    this.confirmAction = confirmAction;
    this.onApplied = onApplied;
    this.ids = [];
    this.els.bar.addEventListener('click', (event) => this.#onClick(event));
  }

  update(ids) {
    this.ids = [...new Set(ids || [])];
    this.els.bar.hidden = this.ids.length === 0;
    this.els.title.textContent = `${this.ids.length} selected`;
    if (!this.ids.length) return;
    const selected = new Set(this.ids);
    this.els.parent.innerHTML = '<option value="">Top level</option>' + this.db.getAllNotes()
      .filter((note) => !selected.has(note.id))
      .map((note) => `<option value="${escapeHtml(note.id)}">${escapeHtml(note.title || 'Untitled')}</option>`)
      .join('');
    const notes = this.ids.map((id) => this.db.notes.get(id)).filter(Boolean);
    this.els.bar.querySelector('[data-bulk-action="archive"]').hidden = notes.every((note) => note.isArchived);
    this.els.bar.querySelector('[data-bulk-action="unarchive"]').hidden = notes.every((note) => !note.isArchived);
  }

  async #onClick(event) {
    if (event.target.closest('[data-bulk-clear]')) {
      const focusId = this.ids[0];
      this.noteList.clearSelection();
      if (!this.noteList.focusSelectionControl(focusId)) this.noteList.focusSearch();
      return;
    }
    if (event.target.closest('[data-bulk-export]')) return this.#export();
    const button = event.target.closest('[data-bulk-action]');
    if (!button) return;
    const action = button.dataset.bulkAction;
    const payload = action === 'tag'
      ? { tag: this.els.tag.value }
      : action === 'reparent'
        ? { parentId: this.els.parent.value || null }
        : {};
    const plan = this.bulk.planNoteBatch(this.ids, action, payload);
    if (!plan.valid) {
      this.els.status.textContent = plan.message;
      return;
    }
    if (action === 'trash') {
      const approved = await this.confirmAction({ message: `Move ${plan.changed.length} selected note${plan.changed.length === 1 ? '' : 's'} to Trash?`, plan });
      if (!approved) { this.els.status.textContent = 'Move to Trash cancelled.'; return; }
    }
    this.els.status.textContent = `Applying ${action} to ${plan.changed.length} note${plan.changed.length === 1 ? '' : 's'}…`;
    const selectedIds = [...this.ids];
    try {
      const report = await this.bulk.applyNoteBatch(plan);
      const message = `${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.failed.length} failed.`;
      this.els.status.textContent = message;
      this.els.announcer.textContent = message;
      this.onApplied({ action, report });
      this.noteList.clearSelection();
      const focusId = selectedIds.find((id) => this.db.getNote(id));
      if (!this.noteList.focusSelectionControl(focusId)) this.noteList.focusSearch();
      this.els.tag.value = '';
    } catch (error) {
      const report = error.report || { changed: [], unchanged: plan.unchanged, failed: plan.changed };
      this.els.status.textContent = `${error?.message || error} ${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.failed.length} failed.`;
    }
  }

  #export() {
    const notes = this.ids.map((id) => this.db.notes.get(id)?.toJSON()).filter(Boolean);
    if (!notes.length) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadText(JSON.stringify({ format: 'noteforge-selection', version: 1, exportedAt: new Date().toISOString(), notes }, null, 2), `noteforge-selection-${date}.json`, 'application/json');
    const message = `${notes.length} selected note${notes.length === 1 ? '' : 's'} exported.`;
    this.els.status.textContent = message;
    this.els.announcer.textContent = message;
  }
}
