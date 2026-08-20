import './task-dashboard-view.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { calendarDateLabel, localDateKey } from '../utils/local-date.js';
import { groupTasks } from '../utils/tasks.js';

const GROUPS = [
  ['today', 'Today'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'],
  ['noDate', 'No date'], ['completed', 'Completed'],
];
const PAGE_SIZE = 50;

export function createTaskDashboardElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'task-dashboard-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel task-dashboard-modal" role="dialog" aria-modal="true" aria-labelledby="task-dashboard-title" tabindex="-1"><header class="modal__header"><div><h2 class="modal__title" id="task-dashboard-title">Tasks</h2><p class="muted">Source-verified tasks from active Markdown notes</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close Tasks">✕</button></header><div class="task-dashboard-filters"><label>Group<select id="task-group-filter"><option value="all">All groups</option>${GROUPS.map(([id,label]) => `<option value="${id}">${label}</option>`).join('')}</select></label><label>Note<select id="task-note-filter"><option value="">All notes</option></select></label><label>Tag<select id="task-tag-filter"><option value="">All tags</option></select></label></div><div id="task-dashboard-list" class="task-dashboard-list"></div><footer class="task-dashboard-footer"><span id="task-dashboard-status" role="status" aria-live="polite"></span><button type="button" class="btn btn--ghost" data-close>Close</button></footer></div>`;
  root.appendChild(overlay);
  return {
    overlay,
    list: overlay.querySelector('#task-dashboard-list'),
    status: overlay.querySelector('#task-dashboard-status'),
    group: overlay.querySelector('#task-group-filter'),
    note: overlay.querySelector('#task-note-filter'),
    tag: overlay.querySelector('#task-tag-filter'),
  };
}

export class TaskDashboardView {
  constructor(els, db, service, { onOpen = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.service = service;
    this.onOpen = onOpen;
    this.tasks = [];
    this.visibleTasks = [];
    this.pages = new Map();
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.group });
    this.els.list.addEventListener('change', (event) => void this.#onChange(event));
    this.els.list.addEventListener('click', (event) => this.#onClick(event));
    for (const filter of [els.group, els.note, els.tag]) filter.addEventListener('change', () => {
      this.pages.clear();
      this.#render();
    });
    this.unsubscribe = db.subscribe(() => { if (this.open) this.refresh(); });
  }

  get open() { return this.modal.isOpen; }

  show() {
    this.refresh();
    this.modal.open();
  }

  close() { this.modal.close(); }

  refresh() {
    const previousNote = this.els.note.value;
    const previousTag = this.els.tag.value;
    this.tasks = this.service.list();
    const notes = [...new Map(this.tasks.map((task) => [task.noteId, task.noteTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const tags = [...new Set(this.tasks.flatMap((task) => task.noteTags))].sort((a, b) => a.localeCompare(b));
    this.els.note.innerHTML = '<option value="">All notes</option>' + notes.map(([id, title]) => `<option value="${escapeHtml(id)}">${escapeHtml(title)}</option>`).join('');
    this.els.tag.innerHTML = '<option value="">All tags</option>' + tags.map((tag) => `<option value="${escapeHtml(tag)}">#${escapeHtml(tag)}</option>`).join('');
    if (notes.some(([id]) => id === previousNote)) this.els.note.value = previousNote;
    if (tags.includes(previousTag)) this.els.tag.value = previousTag;
    this.#render();
  }

  #render() {
    const grouped = groupTasks(this.tasks, localDateKey());
    const wanted = this.els.group.value;
    const noteId = this.els.note.value;
    const tag = this.els.tag.value;
    this.visibleTasks = [];
    const sections = [];
    let total = 0;
    for (const [id, label] of GROUPS) {
      if (wanted !== 'all' && wanted !== id) continue;
      const tasks = grouped[id].filter((task) => (!noteId || task.noteId === noteId) && (!tag || task.noteTags.includes(tag)));
      total += tasks.length;
      if (!tasks.length && wanted === 'all') continue;
      const pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
      const page = Math.min(this.pages.get(id) || 0, pageCount - 1);
      this.pages.set(id, page);
      const rows = tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((task) => {
        const index = this.visibleTasks.push(task) - 1;
        return `<li class="task-card" data-task-index="${index}"><label class="task-card__check"><input type="checkbox" data-task-toggle ${task.checked ? 'checked' : ''} aria-label="Mark ${escapeHtml(task.text || 'task')} ${task.checked ? 'not completed' : 'completed'}"><span>${escapeHtml(task.text || 'Untitled task')}</span></label><div class="task-card__meta"><button type="button" data-task-open>${escapeHtml(task.noteTitle)}</button>${task.heading ? `<span>${escapeHtml(task.heading)}</span>` : ''}${task.noteTags.map((value) => `<span>#${escapeHtml(value)}</span>`).join('')}</div><label class="task-card__due"><span>Due</span><input type="date" data-task-due value="${escapeHtml(task.dueDate || '')}" aria-label="Due date for ${escapeHtml(task.text || 'task')}"></label></li>`;
      }).join('');
      const pagination = pageCount > 1 ? `<nav class="task-group__pages" aria-label="${label} task pages"><button type="button" class="btn btn--ghost" data-task-page="${id}" data-page-delta="-1" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${pageCount}</span><button type="button" class="btn btn--ghost" data-task-page="${id}" data-page-delta="1" ${page === pageCount - 1 ? 'disabled' : ''}>Next</button></nav>` : '';
      sections.push(`<section class="task-group" aria-labelledby="task-group-${id}"><h3 id="task-group-${id}">${label}<span>${tasks.length}</span></h3>${rows ? `<ul>${rows}</ul>${pagination}` : '<p class="muted">No matching tasks.</p>'}</section>`);
    }
    this.els.list.innerHTML = sections.join('') || '<div class="task-dashboard-empty"><strong>No tasks match these filters.</strong><p class="muted">Add a Markdown task such as <code>- [ ] Plan release @due(2026-08-21)</code>.</p></div>';
    this.els.status.textContent = total === this.visibleTasks.length
      ? `${total} task${total === 1 ? '' : 's'} shown.`
      : `${this.visibleTasks.length} of ${total} tasks shown.`;
  }

  #taskFromEvent(event) {
    const index = Number(event.target.closest('[data-task-index]')?.dataset.taskIndex);
    return Number.isInteger(index) ? this.visibleTasks[index] : null;
  }

  #onClick(event) {
    const pageButton = event.target.closest('[data-task-page]');
    if (pageButton) {
      const group = pageButton.dataset.taskPage;
      this.pages.set(group, Math.max(0, (this.pages.get(group) || 0) + Number(pageButton.dataset.pageDelta || 0)));
      this.#render();
      this.els.list.querySelector(`[data-task-page="${group}"]:not([disabled])`)?.focus();
      return;
    }
    if (!event.target.closest('[data-task-open]')) return;
    const task = this.#taskFromEvent(event);
    if (!task) return;
    this.close();
    this.onOpen(task);
  }

  async #onChange(event) {
    const task = this.#taskFromEvent(event);
    if (!task) return;
    const patch = event.target.matches('[data-task-toggle]')
      ? { checked: event.target.checked }
      : event.target.matches('[data-task-due]')
        ? { dueDate: event.target.value || null }
        : null;
    if (!patch) return;
    this.els.status.textContent = 'Saving task source…';
    this.els.list.querySelectorAll('input').forEach((input) => { input.disabled = true; });
    try {
      const result = await this.service.update(task, patch);
      this.refresh();
      this.els.status.textContent = result.changed
        ? `Saved “${task.text || 'task'}” in ${task.noteTitle}.`
        : 'Task was already up to date.';
    } catch (error) {
      this.refresh();
      this.els.status.textContent = error?.message || String(error);
    }
  }
}
