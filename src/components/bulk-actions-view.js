import './bulk-actions-view.css';
import { BulkOperations } from '../core/bulk-operations.js';
import { downloadText } from '../utils/download.js';
import { escapeHtml } from '../utils/helpers.js';
import { icon } from '../ui/icons.js';

export function createBulkActionElements({ anchor = document.getElementById('note-list') } = {}) {
  const bar = document.createElement('section');
  bar.className = 'bulk-actions';
  bar.hidden = true;
  bar.setAttribute('aria-labelledby', 'bulk-actions-title');
  bar.innerHTML = `<header><strong id="bulk-actions-title">0 selected</strong><button type="button" class="btn btn--ghost" data-bulk-clear aria-label="Clear note selection">${icon('x')}</button></header><div class="bulk-actions__row"><label><span class="sr-only">Tag to add</span><input data-bulk-tag placeholder="Tag"></label><button type="button" class="btn btn--ghost" data-bulk-action="tag">Add tag</button><button type="button" class="btn btn--ghost" data-bulk-action="archive">Archive</button><button type="button" class="btn btn--ghost" data-bulk-action="unarchive">Unarchive</button></div><div class="bulk-actions__row"><label class="bulk-actions__parent"><span class="sr-only">New parent</span><select data-bulk-parent><option value="">Top level</option></select></label><button type="button" class="btn btn--ghost" data-bulk-action="reparent">Move</button><button type="button" class="btn btn--ghost" data-bulk-export>Export</button><button type="button" class="btn btn--danger-ghost" data-bulk-action="trash">Move to Trash</button></div><div data-bulk-review role="region" aria-label="Reviewed bulk action" tabindex="0" hidden></div><button type="button" class="btn btn--ghost" data-bulk-refresh hidden>Refresh action preview</button><button type="button" class="btn btn--primary" data-bulk-retry hidden>Apply reviewed action</button><span class="bulk-actions__status" role="status" aria-live="polite"></span>`;
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
    review: bar.querySelector('[data-bulk-review]'),
    refresh: bar.querySelector('[data-bulk-refresh]'),
    retry: bar.querySelector('[data-bulk-retry]'),
  };
}

export class BulkActionsView {
  constructor(els, db, noteList, { confirmAction = () => false, onApplied = () => {}, refreshPreview } = {}) {
    this.els = els;
    this.db = db;
    this.noteList = noteList;
    this.bulk = new BulkOperations(db);
    this.confirmAction = confirmAction;
    this.onApplied = onApplied;
    this.refreshPreview = refreshPreview;
    this.busy = false;
    this.epoch = 0;
    this.retryIntent = null;
    this.retryPlan = null;
    this.ids = [];
    this.els.bar.addEventListener('click', (event) => this.#onClick(event));
    for (const input of [els.tag, els.parent])
      input.addEventListener('input', () => {
        this.epoch++;
        this.retryPlan = null;
        if (this.retryIntent) {
          this.retryIntent.payload = this.#payload(this.retryIntent.action);
          this.els.status.textContent = 'The action changed. Refresh its preview before applying.';
        }
        this.#syncActions();
      });
  }

  update(ids) {
    const next = [...new Set(ids || [])];
    if (JSON.stringify(next) !== JSON.stringify(this.ids)) {
      this.epoch++;
      this.retryIntent = null;
      this.retryPlan = null;
    }
    this.ids = next;
    this.#syncActions();
    this.els.bar.hidden = this.ids.length === 0;
    this.els.title.textContent = `${this.ids.length} selected`;
    if (!this.ids.length) return;
    const selected = new Set(this.ids);
    const parent = this.els.parent.value;
    this.els.parent.innerHTML =
      '<option value="">Top level</option>' +
      this.db
        .getAllNotes()
        .filter((note) => !selected.has(note.id))
        .map((note) => `<option value="${escapeHtml(note.id)}">${escapeHtml(note.title || 'Untitled')}</option>`)
        .join('');
    if ([...this.els.parent.options].some((option) => option.value === parent)) this.els.parent.value = parent;
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
    if (event.target.closest('[data-bulk-refresh]')) return this.#refreshRetry();
    if (event.target.closest('[data-bulk-retry]')) {
      if (this.retryPlan?.valid && !this.busy)
        return this.#applyPlan(this.retryPlan, this.retryIntent.action, this.retryIntent.payload);
      return;
    }
    const button = event.target.closest('[data-bulk-action]');
    if (!button || this.busy || this.retryIntent) return;
    const action = button.dataset.bulkAction;
    const payload = this.#payload(action);
    const plan = this.bulk.planNoteBatch(this.ids, action, payload);
    if (!plan.valid) {
      this.els.status.textContent = plan.message;
      return;
    }
    return this.#applyPlan(plan, action, payload);
  }

  #payload(action) {
    return action === 'tag'
      ? { tag: this.els.tag.value }
      : action === 'reparent'
        ? { parentId: this.els.parent.value || null }
        : {};
  }

  #syncActions() {
    this.els.bar.querySelectorAll('[data-bulk-action]').forEach((button) => {
      button.disabled = this.busy || Boolean(this.retryIntent);
    });
    this.els.tag.disabled = this.busy;
    this.els.parent.disabled = this.busy;
    if (this.els.refresh) {
      this.els.refresh.hidden = !this.retryIntent;
      this.els.refresh.disabled = this.busy;
    }
    if (this.els.retry) {
      this.els.retry.hidden = !this.retryPlan;
      this.els.retry.disabled = this.busy || !this.retryPlan?.valid || !this.retryPlan.changed.length;
    }
    if (this.els.review) this.els.review.hidden = !this.retryPlan;
  }

  async #refreshRetry() {
    if (!this.retryIntent || this.busy) return;
    const intent = structuredClone(this.retryIntent);
    const epoch = this.epoch;
    this.busy = true;
    this.retryPlan = null;
    this.#syncActions();
    this.els.status.textContent = 'Refreshing saved notes for the selected action…';
    try {
      await this.refreshPreview?.();
      if (epoch !== this.epoch || !this.ids.length) return;
      this.retryPlan = this.bulk.planNoteBatch(intent.ids, intent.action, intent.payload);
      const plan = this.retryPlan;
      this.els.status.textContent = plan.valid ? 'Review the updated action before applying.' : plan.message;
      if (plan.valid && this.els.review)
        this.els.review.innerHTML = `<p>${plan.changed.length} notes will change (${escapeHtml(intent.action)}); ${plan.unchanged.length} unchanged.</p><ul>${plan.changed
          .slice(0, 100)
          .map((note) => `<li>${escapeHtml(note.title)}</li>`)
          .join('')}</ul>`;
    } catch (error) {
      if (epoch === this.epoch) this.els.status.textContent = error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncActions();
    }
  }

  async #applyPlan(plan, action, payload) {
    const epoch = this.epoch;
    const selectedIds = [...this.ids];
    this.busy = true;
    this.#syncActions();
    try {
      if (action === 'trash') {
        const approved = await this.confirmAction({
          message: `Move ${plan.changed.length} selected note${plan.changed.length === 1 ? '' : 's'} to Trash?`,
          plan,
        });
        if (epoch !== this.epoch) return;
        if (!approved) {
          this.els.status.textContent = 'Move to Trash cancelled.';
          return;
        }
      }
      this.els.status.textContent = `Applying ${action} to ${plan.changed.length} note${plan.changed.length === 1 ? '' : 's'}…`;
      const report = await this.bulk.applyNoteBatch(plan);
      const message = `${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.failed.length} failed.`;
      this.els.announcer.textContent = message;
      this.onApplied({ action, report });
      if (epoch !== this.epoch) return;
      this.els.status.textContent = message;
      this.retryIntent = null;
      this.retryPlan = null;
      this.noteList.clearSelection();
      const focusId = selectedIds.find((id) => this.db.getNote(id));
      if (!this.noteList.focusSelectionControl(focusId)) this.noteList.focusSearch();
      this.els.tag.value = '';
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error?.code === 'stale_plan') {
        this.retryIntent = { ids: selectedIds, action, payload: structuredClone(payload) };
        this.retryPlan = null;
        this.els.status.textContent = 'Notes changed. Refresh the action preview and review it before applying.';
      } else {
        const report = error.report || { changed: [], unchanged: plan.unchanged, failed: plan.changed };
        this.els.status.textContent = `${error?.message || error} ${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.failed.length} failed.`;
      }
    } finally {
      this.busy = false;
      this.#syncActions();
    }
  }

  #export() {
    const notes = this.ids.map((id) => this.db.notes.get(id)?.toJSON()).filter(Boolean);
    if (!notes.length) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadText(
      JSON.stringify(
        { format: 'noteforge-selection', version: 1, exportedAt: new Date().toISOString(), notes },
        null,
        2,
      ),
      `noteforge-selection-${date}.json`,
      'application/json',
    );
    const message = `${notes.length} selected note${notes.length === 1 ? '' : 's'} exported.`;
    this.els.status.textContent = message;
    this.els.announcer.textContent = message;
  }
}
