import './calendar-view.css';
import { Modal } from './modal.js';
import { buildCalendarItems, calendarItemsByDate, calendarPeriod } from '../utils/calendar.js';
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDateLabel,
  localDateKey,
  parseCalendarDate,
  startOfWeek,
} from '../utils/local-date.js';
import { escapeHtml } from '../utils/helpers.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function createCalendarElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'calendar-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel calendar-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-title" tabindex="-1"><header class="modal__header"><div><h2 class="modal__title" id="calendar-title">Calendar</h2><p class="muted">Daily notes, date blocks, and task due dates</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close Calendar">✕</button></header><div class="calendar-toolbar"><div class="calendar-nav"><button type="button" class="btn btn--ghost" data-period="previous" aria-label="Previous period">←</button><button type="button" class="btn btn--ghost" data-period="today">Today</button><button type="button" class="btn btn--ghost" data-period="next" aria-label="Next period">→</button></div><strong id="calendar-period-label"></strong><div role="group" aria-label="Calendar view"><button type="button" class="btn btn--ghost" data-calendar-mode="month" aria-pressed="true">Month</button><button type="button" class="btn btn--ghost" data-calendar-mode="week" aria-pressed="false">Week</button></div></div><div id="calendar-grid" class="calendar-grid" role="grid" aria-label="Calendar dates"></div><div id="calendar-agenda" class="calendar-agenda" aria-label="Calendar agenda"></div><footer class="calendar-footer"><span id="calendar-status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-open-daily>Open Daily note</button><button type="button" class="btn btn--ghost" data-close>Close</button></div></footer></div>`;
  root.appendChild(overlay);
  return {
    overlay,
    grid: overlay.querySelector('#calendar-grid'),
    agenda: overlay.querySelector('#calendar-agenda'),
    label: overlay.querySelector('#calendar-period-label'),
    status: overlay.querySelector('#calendar-status'),
  };
}

export class CalendarView {
  constructor(els, db, { onOpenItem = () => {}, onOpenDaily = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.onOpenItem = onOpenItem;
    this.onOpenDaily = onOpenDaily;
    this.mode = 'month';
    this.anchor = localDateKey();
    this.activeDate = this.anchor;
    this.items = [];
    this.days = [];
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.grid.querySelector('[tabindex="0"]') || this.modal.panel });
    this.els.overlay.addEventListener('click', (event) => this.#onClick(event));
    this.els.grid.addEventListener('keydown', (event) => this.#onGridKey(event));
    this.unsubscribe = db.subscribe(() => { if (this.open) this.refresh(); });
  }

  get open() { return this.modal.isOpen; }

  show({ date = localDateKey(), mode = this.mode } = {}) {
    this.anchor = parseCalendarDate(date) ? date : localDateKey();
    this.activeDate = this.anchor;
    this.mode = mode === 'week' ? 'week' : 'month';
    this.refresh();
    this.modal.open();
  }

  close() { this.modal.close(); }

  refresh() {
    this.items = buildCalendarItems(this.db.getAllNotes());
    const period = calendarPeriod(this.mode, this.anchor);
    this.days = period.days;
    if (!this.days.includes(this.activeDate)) this.activeDate = this.mode === 'week' ? period.start : this.anchor;
    const anchor = parseCalendarDate(this.anchor);
    this.els.label.textContent = this.mode === 'week'
      ? `${calendarDateLabel(this.days[0], { month: 'short', day: 'numeric' })} – ${calendarDateLabel(this.days.at(-1), { month: 'short', day: 'numeric', year: 'numeric' })}`
      : calendarDateLabel(`${String(anchor.year).padStart(4, '0')}-${String(anchor.month).padStart(2, '0')}-01`, { month: 'long', year: 'numeric' });
    this.els.overlay.querySelectorAll('[data-calendar-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.calendarMode === this.mode)));
    this.#renderGrid();
    this.#renderAgenda();
    this.els.status.textContent = `${this.items.filter((item) => this.days.includes(item.date)).length} calendar item${this.items.filter((item) => this.days.includes(item.date)).length === 1 ? '' : 's'} in this ${this.mode}.`;
  }

  #renderGrid() {
    const grouped = calendarItemsByDate(this.items);
    const month = parseCalendarDate(this.anchor).month;
    const cells = this.days.map((date) => {
      const parsed = parseCalendarDate(date);
      const items = grouped.get(date) || [];
      const outside = this.mode === 'month' && parsed.month !== month;
      return `<div class="calendar-day${outside ? ' calendar-day--outside' : ''}" role="gridcell" data-calendar-date="${date}"><button type="button" class="calendar-day__number" data-day tabindex="${date === this.activeDate ? '0' : '-1'}" aria-label="${escapeHtml(calendarDateLabel(date))}${items.length ? `, ${items.length} item${items.length === 1 ? '' : 's'}` : ', empty, open Daily note'}"${date === localDateKey() ? ' aria-current="date"' : ''}>${parsed.day}</button><div class="calendar-day__items">${items.map((item) => `<button type="button" class="calendar-item calendar-item--${item.type}" data-calendar-item="${escapeHtml(item.id)}" title="${escapeHtml(item.noteTitle)}" aria-label="${escapeHtml(`${item.label} from ${item.noteTitle}`)}"><span>${item.type === 'task' ? (item.checked ? '✓' : '□') : item.type === 'daily' ? 'D' : '•'}</span>${escapeHtml(item.label)}</button>`).join('')}</div></div>`;
    });
    const rows = [];
    for (let index = 0; index < cells.length; index += 7) {
      rows.push(`<div class="calendar-grid__row" role="row">${cells.slice(index, index + 7).join('')}</div>`);
    }
    this.els.grid.setAttribute('aria-rowcount', String(rows.length + 1));
    this.els.grid.setAttribute('aria-colcount', '7');
    this.els.grid.innerHTML = `<div class="calendar-grid__row" role="row">${DAY_NAMES.map((name) => `<div class="calendar-grid__heading" role="columnheader">${name}</div>`).join('')}</div>${rows.join('')}`;
  }

  #renderAgenda() {
    const grouped = calendarItemsByDate(this.items);
    const populated = this.days.filter((date) => (grouped.get(date) || []).length);
    this.els.agenda.innerHTML = populated.length ? populated.map((date) => `<section class="calendar-agenda__day" data-agenda-date="${date}"><h3>${escapeHtml(calendarDateLabel(date, { weekday: 'short', month: 'short', day: 'numeric' }))}</h3><ul>${(grouped.get(date) || []).map((item) => `<li><button type="button" data-calendar-item="${escapeHtml(item.id)}"><span>${item.type === 'task' ? (item.checked ? '✓' : '□') : item.type === 'daily' ? 'Daily' : 'Date'}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.noteTitle)}</small></button></li>`).join('')}</ul></section>`).join('') : '<div class="calendar-agenda__empty"><strong>No calendar items in this period.</strong><p class="muted">Choose Open Daily note to start one for the selected date.</p></div>';
  }

  #findItem(id) { return this.items.find((item) => item.id === id) || null; }

  #onClick(event) {
    const mode = event.target.closest('[data-calendar-mode]');
    if (mode) { this.mode = mode.dataset.calendarMode; this.refresh(); this.modal.focusInitial(); return; }
    const period = event.target.closest('[data-period]');
    if (period) {
      if (period.dataset.period === 'today') this.anchor = this.activeDate = localDateKey();
      else {
        const amount = period.dataset.period === 'next' ? 1 : -1;
        this.anchor = this.mode === 'week' ? addCalendarDays(this.anchor, amount * 7) : addCalendarMonths(this.anchor, amount);
        this.activeDate = this.anchor;
      }
      this.refresh();
      this.modal.focusInitial();
      return;
    }
    const itemButton = event.target.closest('[data-calendar-item]');
    if (itemButton) {
      const item = this.#findItem(itemButton.dataset.calendarItem);
      if (!item) return;
      this.close();
      this.onOpenItem(item);
      return;
    }
    const day = event.target.closest('[data-day]');
    if (day) {
      this.activeDate = day.closest('[data-calendar-date]').dataset.calendarDate;
      const hasItems = this.items.some((item) => item.date === this.activeDate);
      if (!hasItems) this.#openDaily();
      else { this.refresh(); this.els.status.textContent = `${calendarDateLabel(this.activeDate)} selected. Choose an item or Open Daily note.`; }
      return;
    }
    if (event.target.closest('[data-open-daily]')) this.#openDaily();
  }

  #openDaily() {
    const date = this.activeDate;
    this.close();
    this.onOpenDaily(date);
  }

  #onGridKey(event) {
    const button = event.target.closest('[data-day]');
    if (!button) return;
    const date = button.closest('[data-calendar-date]').dataset.calendarDate;
    let next = null;
    if (event.key === 'ArrowLeft') next = addCalendarDays(date, -1);
    else if (event.key === 'ArrowRight') next = addCalendarDays(date, 1);
    else if (event.key === 'ArrowUp') next = addCalendarDays(date, -7);
    else if (event.key === 'ArrowDown') next = addCalendarDays(date, 7);
    else if (event.key === 'Home') next = startOfWeek(date);
    else if (event.key === 'End') next = addCalendarDays(startOfWeek(date), 6);
    else if (event.key === 'PageUp') next = this.mode === 'week' ? addCalendarDays(date, -7) : addCalendarMonths(date, -1);
    else if (event.key === 'PageDown') next = this.mode === 'week' ? addCalendarDays(date, 7) : addCalendarMonths(date, 1);
    if (!next) return;
    event.preventDefault();
    this.activeDate = next;
    if (!this.days.includes(next)) this.anchor = next;
    this.refresh();
    this.els.grid.querySelector(`[data-calendar-date="${next}"] [data-day]`)?.focus();
  }
}
