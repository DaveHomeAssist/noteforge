import { templateById } from './templates.js';

// The block editor preserves tilde fences as ordinary source blocks, while the
// task index correctly excludes their contents as fenced Markdown. Translate a
// source task to the editor's visible to-do index so source navigation remains
// exact even when an earlier tilde fence contains task-looking text.
export function editorTaskOccurrence(content, reference) {
  if (!Number.isInteger(reference?.sourceStart)) return Number(reference?.occurrence) || 0;
  const lines = String(content ?? '')
    .slice(0, reference.sourceStart)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let inBacktickFence = false;
  let occurrence = 0;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inBacktickFence = !inBacktickFence;
      continue;
    }
    if (!inBacktickFence && /^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) occurrence += 1;
  }
  return occurrence;
}

export class Phase4Controller {
  constructor({ db, editor, openNote, showStorageError, announce, confirm, toast, openCapture }) {
    this.db = db;
    this.editor = editor;
    this.openNote = openNote;
    this.showStorageError = showStorageError;
    this.announce = announce;
    this.confirm = confirm;
    this.toast = toast;
    this.openCapture = openCapture;
    this.quickCapture = null;
    this.quickCaptureReady = null;
    this.taskDashboard = null;
    this.taskDashboardReady = null;
    this.calendar = null;
    this.calendarReady = null;
  }

  // Tasks and Calendar are main-area views, not dialogs; only Quick Capture is modal.
  get open() {
    return Boolean(this.quickCapture?.open);
  }

  prepareDailyNote() {
    return Promise.all([import('../utils/daily-workflow.js'), import('../utils/local-date.js')]);
  }

  async openDailyNote(date = null, request = { current: () => true, commit: (action) => action() }) {
    const [{ resolveDailyNote }, { localDateKey }] = await this.prepareDailyNote();
    if (!request.current()) return null;
    this.editor?.flushPending();
    if (!(await this.db.flushCurrentWrites())) return this.showStorageError();
    if (!request.current()) return null;
    const dateKey = date || localDateKey();
    const resolution = resolveDailyNote([...this.db.notes.values()], dateKey);
    try {
      if (resolution.status === 'active') {
        request.commit(() => this.openNote(resolution.note.id));
        this.announce(`Opened Daily note ${dateKey}.`);
        return resolution.note;
      }
      if (resolution.status === 'ambiguous') {
        this.toast(
          `More than one note is titled ${dateKey}. Resolve the duplicate titles before opening the Daily note.`,
          {
            tone: 'error',
          },
        );
        return null;
      }
      if (resolution.status === 'trashed' || resolution.status === 'archived') {
        const archived = resolution.status === 'archived';
        const verb = archived ? 'Unarchive' : 'Restore';
        const approved = await request.commit(() =>
          this.confirm(
            {
              title: `${verb} the Daily note?`,
              message: `“${dateKey}” is ${archived ? 'archived' : 'in Trash'}. ${verb} and open it?`,
              confirmLabel: `${verb} and open`,
            },
            request,
          ),
        );
        if (!request.current()) return null;
        if (!approved) {
          this.announce(`Daily note ${verb.toLowerCase()} cancelled.`);
          return null;
        }
        const changed = archived ? this.db.unarchiveNote(resolution.note.id) : this.db.restoreNote(resolution.note.id);
        if (!changed || !(await this.db.flushCurrentWrites())) {
          this.showStorageError();
          return null;
        }
        if (!request.current()) return null;
        request.commit(() => this.openNote(resolution.note.id));
        this.announce(`${archived ? 'Unarchived' : 'Restored'} and opened Daily note ${dateKey}.`);
        return this.db.getNote(resolution.note.id);
      }
      const note = request.commit(() => this.db.createNote(templateById('daily').build({ date: dateKey })));
      if (!note) return null;
      if (!(await this.db.flushCurrentWrites())) {
        this.showStorageError();
        return null;
      }
      if (!request.current()) return null;
      request.commit(() => this.openNote(note.id, { focus: 'content' }));
      this.announce(`Created Daily note ${dateKey}.`);
      return note;
    } catch (error) {
      this.toast(error?.message || String(error), { tone: 'error' });
      return null;
    }
  }

  prepareQuickCapture() {
    if (this.quickCapture) return Promise.resolve(this.quickCapture);
    if (this.quickCaptureReady) return this.quickCaptureReady;
    this.quickCaptureReady = Promise.all([
      import('../components/quick-capture-view.js'),
      import('../core/capture-service.js'),
    ])
      .then(([{ QuickCaptureView, createQuickCaptureElements }, { CaptureService }]) => {
        this.quickCapture = new QuickCaptureView(createQuickCaptureElements(), this.db, new CaptureService(this.db), {
          onSaved: async ({ note }) => {
            if ((await this.openNote(note.id)) === false) throw new Error('Capture destination could not be opened.');
            this.announce(`Quick Capture saved to ${note.title}.`);
          },
        });
        return this.quickCapture;
      })
      .catch((error) => {
        this.quickCaptureReady = null;
        throw error;
      });
    return this.quickCaptureReady;
  }

  prepareTaskDashboard() {
    if (this.taskDashboard) return Promise.resolve(this.taskDashboard);
    if (this.taskDashboardReady) return this.taskDashboardReady;
    this.taskDashboardReady = Promise.all([
      import('../components/task-dashboard-view.js'),
      import('../core/task-service.js'),
    ])
      .then(([{ TaskDashboardView, createTaskDashboardElements }, { TaskService }]) => {
        this.taskDashboard = new TaskDashboardView(createTaskDashboardElements(), this.db, new TaskService(this.db), {
          onOpen: (task) => this.#openTask(task),
        });
        return this.taskDashboard;
      })
      .catch((error) => {
        this.taskDashboardReady = null;
        throw error;
      });
    return this.taskDashboardReady;
  }

  prepareCalendar() {
    if (this.calendar) return Promise.resolve(this.calendar);
    if (this.calendarReady) return this.calendarReady;
    this.calendarReady = import('../components/calendar-view.js')
      .then(({ CalendarView, createCalendarElements }) => {
        this.calendar = new CalendarView(createCalendarElements(), this.db, {
          onOpenItem: (item) => {
            if (item.task) this.#openTask(item.task);
            else this.openNote(item.noteId);
          },
          onOpenDaily: (day) => void this.openDailyNote(day),
        });
        return this.calendar;
      })
      .catch((error) => {
        this.calendarReady = null;
        throw error;
      });
    return this.calendarReady;
  }

  #openTask(task) {
    const occurrence = editorTaskOccurrence(this.db.getNote(task.noteId)?.content, task);
    Promise.resolve(this.openNote(task.noteId)).then(() => this.editor.focusTask(occurrence));
  }

  async showQuickCapture(options = {}) {
    if (this.openCapture) return this.openCapture(options);
    const view = await this.prepareQuickCapture();
    this.editor?.flushPending();
    // A conflict in another note must not block opening a capture draft.
    // Each submitted destination has its own acknowledgement and recovery.
    if (!(await this.db.flushCurrentWrites())) this.showStorageError();
    view.show(options);
  }

  async showTaskDashboard() {
    const view = await this.prepareTaskDashboard();
    this.editor?.flushPending();
    if (!(await this.db.flushCurrentWrites())) return this.showStorageError();
    view.show();
  }

  async showCalendar(options = {}) {
    const view = await this.prepareCalendar();
    this.editor?.flushPending();
    if (!(await this.db.flushCurrentWrites())) return this.showStorageError();
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
