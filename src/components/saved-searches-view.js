import './saved-searches-view.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import {
  createSavedSearch,
  moveSavedSearch,
  normalizeSavedSearches,
  removeSavedSearch,
  updateSavedSearch,
} from '../utils/saved-searches.js';

export function createSavedSearchElements({ sidebarAnchor = document.getElementById('tag-filter'), root = document.body } = {}) {
  const section = document.createElement('section');
  section.className = 'saved-searches';
  section.setAttribute('aria-labelledby', 'saved-searches-title');
  section.innerHTML = `<header><h2 id="saved-searches-title">Saved views</h2><button type="button" class="btn btn--ghost" data-saved-manage aria-label="Manage saved views">Manage</button></header><div class="saved-searches__list"></div><button type="button" class="saved-searches__save" data-saved-create>＋ Save current search</button><span class="saved-searches__status sr-only" role="status" aria-live="polite"></span>`;
  sidebarAnchor?.parentNode?.insertBefore(section, sidebarAnchor);

  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'saved-searches-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel saved-searches-modal" role="dialog" aria-modal="true" aria-labelledby="saved-searches-modal-title" tabindex="-1">
    <header class="modal__header"><div><h2 class="modal__title" id="saved-searches-modal-title">Manage saved views</h2><p class="muted">Saved views keep query, sort, and active tag together.</p></div><button class="btn btn--ghost" data-close aria-label="Close saved views">✕</button></header>
    <div class="saved-searches-modal__body"><form class="saved-searches-form"><label>Name<input name="name" required maxlength="80"></label><label>Icon<input name="icon" value="🔎" maxlength="8"></label><label>Query<input name="query" maxlength="500"></label><label>Sort<select name="sortMode"><option value="updated">Updated</option><option value="created">Created</option><option value="title">Title</option></select></label><label>Active tag<input name="activeTag" maxlength="80" placeholder="Optional"></label><button class="btn btn--primary" type="submit">Save view</button></form><div class="saved-searches-manage" role="list" aria-label="Saved views"></div></div>
    <footer class="saved-searches-modal__footer"><span role="status" aria-live="polite"></span><button class="btn btn--ghost" data-close>Close</button></footer>
  </div>`;
  root.appendChild(overlay);
  return {
    section,
    list: section.querySelector('.saved-searches__list'),
    sectionStatus: section.querySelector('.saved-searches__status'),
    overlay,
    form: overlay.querySelector('.saved-searches-form'),
    manageList: overlay.querySelector('.saved-searches-manage'),
    status: overlay.querySelector('.saved-searches-modal__footer [role=status]'),
  };
}

export class SavedSearchesView {
  constructor(els, db, noteList, { onRun = () => {}, onChange = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.noteList = noteList;
    this.onRun = onRun;
    this.onChange = onChange;
    const normalized = normalizeSavedSearches(db.config.savedSearches);
    this.records = normalized.records;
    if (normalized.rejected.length || JSON.stringify(this.records) !== JSON.stringify(db.config.savedSearches || [])) {
      db.setConfig({ savedSearches: this.records });
    }
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.form.elements.name });
    this.els.section.addEventListener('click', (event) => this.#onSectionClick(event));
    this.els.form.addEventListener('submit', (event) => this.#create(event));
    this.els.manageList.addEventListener('click', (event) => this.#onManageClick(event));
    this.els.manageList.addEventListener('change', (event) => this.#onManageChange(event));
    this.unsubscribe = db.subscribe(() => {
      const next = normalizeSavedSearches(db.config.savedSearches).records;
      if (JSON.stringify(next) === JSON.stringify(this.records)) return;
      this.records = next;
      this.render();
      this.els.sectionStatus.textContent = 'Saved views were refreshed from the restored vault.';
    });
    this.render();
    if (normalized.rejected.length) this.els.sectionStatus.textContent = `${normalized.rejected.length} malformed saved view${normalized.rejected.length === 1 ? '' : 's'} ignored.`;
  }

  get open() {
    return this.modal.isOpen;
  }

  commands() {
    return this.records.map((record) => ({
      id: `saved-search-${record.id}`,
      title: `Run saved view: ${record.name}`,
      hint: record.query || 'All active notes',
      icon: record.icon,
      run: () => this.run(record.id),
    }));
  }

  show({ seedCurrent = false } = {}) {
    if (seedCurrent) this.#fillFormFromCurrent();
    this.#renderManage();
    this.modal.open();
  }

  run(id) {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) return 0;
    const count = this.noteList.applySearchState(record);
    const message = `${record.name}: ${count} result${count === 1 ? '' : 's'}.`;
    this.els.sectionStatus.textContent = message;
    this.els.status.textContent = message;
    this.onRun(record, count);
    if (this.open) this.modal.close();
    return count;
  }

  render() {
    this.els.list.innerHTML = this.records.length
      ? this.records.map((record) => `<button type="button" data-saved-run="${escapeHtml(record.id)}" title="${escapeHtml(record.query || 'All active notes')}"><span aria-hidden="true">${escapeHtml(record.icon)}</span><span>${escapeHtml(record.name)}</span></button>`).join('')
      : '<p class="muted">No saved views yet.</p>';
    this.#renderManage();
  }

  #persist(records, message) {
    this.records = normalizeSavedSearches(records).records;
    this.db.setConfig({ savedSearches: this.records });
    this.render();
    this.els.status.textContent = message;
    this.onChange(this.records);
  }

  #onSectionClick(event) {
    const run = event.target.closest('[data-saved-run]');
    if (run) this.run(run.dataset.savedRun);
    else if (event.target.closest('[data-saved-manage]')) this.show();
    else if (event.target.closest('[data-saved-create]')) this.show({ seedCurrent: true });
  }

  #fillFormFromCurrent() {
    const state = this.noteList.getSearchState();
    this.els.form.reset();
    this.els.form.elements.icon.value = '🔎';
    this.els.form.elements.query.value = state.query;
    this.els.form.elements.sortMode.value = state.sortMode;
    this.els.form.elements.activeTag.value = state.activeTag || '';
  }

  #create(event) {
    event.preventDefault();
    const data = new FormData(this.els.form);
    try {
      this.#persist(createSavedSearch(this.records, {
        name: data.get('name'),
        icon: data.get('icon'),
        query: data.get('query'),
        sortMode: data.get('sortMode'),
        activeTag: data.get('activeTag') || null,
      }), `Saved “${data.get('name')}”.`);
      this.els.form.elements.name.value = '';
      this.els.form.elements.name.focus();
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
    }
  }

  #renderManage() {
    if (!this.els.manageList) return;
    this.els.manageList.innerHTML = this.records.length
      ? this.records.map((record, index) => `<div class="saved-search-row" role="listitem" data-id="${escapeHtml(record.id)}"><span aria-hidden="true">${escapeHtml(record.icon)}</span><label><span class="sr-only">Name</span><input data-saved-name value="${escapeHtml(record.name)}" maxlength="80"></label><code>${escapeHtml(record.query || 'All active notes')}</code><div class="saved-search-row__actions"><button type="button" class="btn btn--ghost" data-saved-run-manage>Run</button><button type="button" class="btn btn--ghost" data-saved-up aria-label="Move ${escapeHtml(record.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn btn--ghost" data-saved-down aria-label="Move ${escapeHtml(record.name)} down" ${index === this.records.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn btn--danger-ghost" data-saved-delete>Delete</button></div></div>`).join('')
      : '<p class="muted">No saved views yet.</p>';
  }

  #onManageClick(event) {
    const row = event.target.closest('.saved-search-row');
    if (!row) return;
    if (event.target.closest('[data-saved-run-manage]')) this.run(row.dataset.id);
    else if (event.target.closest('[data-saved-up]')) this.#persist(moveSavedSearch(this.records, row.dataset.id, -1), 'Saved view moved up.');
    else if (event.target.closest('[data-saved-down]')) this.#persist(moveSavedSearch(this.records, row.dataset.id, 1), 'Saved view moved down.');
    else if (event.target.closest('[data-saved-delete]')) this.#persist(removeSavedSearch(this.records, row.dataset.id), 'Saved view deleted.');
  }

  #onManageChange(event) {
    const row = event.target.closest('.saved-search-row');
    if (!row || !event.target.matches('[data-saved-name]')) return;
    try {
      this.#persist(updateSavedSearch(this.records, row.dataset.id, { name: event.target.value }), 'Saved view renamed.');
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
      this.#renderManage();
    }
  }
}
