import { templateById } from './templates.js';

// The block editor preserves tilde fences as ordinary source blocks, while the
// task index correctly excludes their contents as fenced Markdown. Translate a
// source task to the editor's visible to-do index so source navigation remains
// exact even when an earlier tilde fence contains task-looking text.
export function editorTaskOccurrence(content, reference) {
  if (!Number.isInteger(reference?.sourceStart)) return Number(reference?.occurrence) || 0;
  const lines = String(content ?? '').slice(0, reference.sourceStart).replace(/\r\n?/g, '\n').split('\n');
  let inBacktickFence = false;
  let occurrence = 0;
  for (const line of lines) {
    if (/^```/.test(line)) { inBacktickFence = !inBacktickFence; continue; }
    if (!inBacktickFence && /^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) occurrence += 1;
  }
  return occurrence;
}

export class Phase4Controller {
  constructor({ db, editor, openNote, showStorageError, announce }) {
    this.db = db;
    this.editor = editor;
    this.openNote = openNote;
    this.showStorageError = showStorageError;
    this.announce = announce;
    this.quickCapture = null;
    this.quickCaptureReady = null;
    this.taskDashboard = null;
    this.taskDashboardReady = null;
    this.calendar = null;
    this.calendarReady = null;
  }

  get open() {
    return Boolean(this.quickCapture?.open || this.taskDashboard?.open || this.calendar?.open);
  }

  async openDailyNote(date = null) {
    const [{ resolveDailyNote }, { localDateKey }] = await Promise.all([
      import('../utils/daily-workflow.js'),
      import('../utils/local-date.js'),
    ]);
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.showStorageError();
    const dateKey = date || localDateKey();
    const resolution = resolveDailyNote([...this.db.notes.values()], dateKey);
    try {
      if (resolution.status === 'active') {
        this.openNote(resolution.note.id);
        this.announce(`Opened Daily note ${dateKey}.`);
        return resolution.note;
      }
      if (resolution.status === 'ambiguous') {
        alert(`More than one note is titled ${dateKey}. Resolve the duplicate titles before opening the Daily note.`);
        return null;
      }
      if (resolution.status === 'trashed' || resolution.status === 'archived') {
        const archived = resolution.status === 'archived';
        const verb = archived ? 'Unarchive' : 'Restore';
        if (!confirm(`“${dateKey}” is ${archived ? 'archived' : 'in Trash'}. ${verb} and open it?`)) {
          this.announce(`Daily note ${verb.toLowerCase()} cancelled.`);
          return null;
        }
        const changed = archived ? this.db.unarchiveNote(resolution.note.id) : this.db.restoreNote(resolution.note.id);
        if (!changed || !await this.db.flushCurrentWrites()) {
          this.showStorageError();
          return null;
        }
        this.openNote(resolution.note.id);
        this.announce(`${archived ? 'Unarchived' : 'Restored'} and opened Daily note ${dateKey}.`);
        return this.db.getNote(resolution.note.id);
      }
      const note = this.db.createNote(templateById('daily').build({ date: dateKey }));
      if (!await this.db.flushCurrentWrites()) {
        this.showStorageError();
        return null;
      }
      this.openNote(note.id, { focus: 'content' });
      this.announce(`Created Daily note ${dateKey}.`);
      return note;
    } catch (error) {
      alert(error?.message || String(error));
      return null;
    }
  }

  #ensureQuickCapture() {
    if (this.quickCapture) return Promise.resolve(this.quickCapture);
    if (this.quickCaptureReady) return this.quickCaptureReady;
    this.quickCaptureReady = Promise.all([
      import('../components/quick-capture-view.js'),
      import('../core/capture-service.js'),
    ]).then(([{ QuickCaptureView, createQuickCaptureElements }, { CaptureService }]) => {
      this.quickCapture = new QuickCaptureView(createQuickCaptureElements(), this.db, new CaptureService(this.db), {
        onSaved: ({ note }) => {
          this.openNote(note.id, { discardPending: true });
          this.announce(`Quick Capture saved to ${note.title}.`);
        },
      });
      return this.quickCapture;
    }).catch((error) => { this.quickCaptureReady = null; throw error; });
    return this.quickCaptureReady;
  }

  #ensureTaskDashboard() {
    if (this.taskDashboard) return Promise.resolve(this.taskDashboard);
    if (this.taskDashboardReady) return this.taskDashboardReady;
    this.taskDashboardReady = Promise.all([
      import('../components/task-dashboard-view.js'),
      import('../core/task-service.js'),
    ]).then(([{ TaskDashboardView, createTaskDashboardElements }, { TaskService }]) => {
      this.taskDashboard = new TaskDashboardView(createTaskDashboardElements(), this.db, new TaskService(this.db), {
        onOpen: (task) => this.#openTask(task),
      });
      return this.taskDashboard;
    }).catch((error) => { this.taskDashboardReady = null; throw error; });
    return this.taskDashboardReady;
  }

  #ensureCalendar() {
    if (this.calendar) return Promise.resolve(this.calendar);
    if (this.calendarReady) return this.calendarReady;
    this.calendarReady = import('../components/calendar-view.js').then(({ CalendarView, createCalendarElements }) => {
      this.calendar = new CalendarView(createCalendarElements(), this.db, {
        onOpenItem: (item) => {
          if (item.task) this.#openTask(item.task);
          else this.openNote(item.noteId);
        },
        onOpenDaily: (day) => void this.openDailyNote(day),
      });
      return this.calendar;
    }).catch((error) => { this.calendarReady = null; throw error; });
    return this.calendarReady;
  }

  #openTask(task) {
    const occurrence = editorTaskOccurrence(this.db.getNote(task.noteId)?.content, task);
    this.openNote(task.noteId);
    queueMicrotask(() => this.editor.focusTask(occurrence));
  }

  async showQuickCapture(options = {}) {
    const view = await this.#ensureQuickCapture();
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.showStorageError();
    view.show(options);
  }

  async showTaskDashboard() {
    const view = await this.#ensureTaskDashboard();
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.showStorageError();
    view.show();
  }

  async showCalendar(options = {}) {
    const view = await this.#ensureCalendar();
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.showStorageError();
    view.show(options);
  }

  async openShareTarget() {
    if (new URL(window.location.href).searchParams.get('source') !== 'share-target') return;
    let intake;
    try {
      const { consumeShareTarget } = await import('../utils/capture.js');
      intake = consumeShareTarget(window.location.href);
    } finally {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
    }
    if (intake?.matched) await this.showQuickCapture({ payload: intake.payload });
  }
}
