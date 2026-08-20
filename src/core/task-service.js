import { Note } from './note.js';
import { extractTasks, mutateTaskSource } from '../utils/tasks.js';

export class TaskService {
  constructor(db) {
    this.db = db;
  }

  list() {
    return this.db.getAllNotes().flatMap((note) => extractTasks(note.content, {
      noteId: note.id,
      noteTitle: note.title,
      noteTags: note.tags,
    }));
  }

  async update(reference, patch) {
    const current = this.db.getNote(reference?.noteId);
    if (!current) throw new Error('The source note is no longer active. Refresh the task dashboard.');
    const mutation = mutateTaskSource(current.content, reference, patch);
    if (!mutation.changed) return { changed: false, note: current, task: reference };
    const next = Note.fromJSON(current.toJSON());
    next.update({ content: mutation.content });
    await this.db.commitPlannedNotes([next.toJSON()], [current], 'pre_task_change');
    const task = extractTasks(next.content, { noteId: next.id, noteTitle: next.title, noteTags: next.tags })
      .find((candidate) => candidate.occurrence === reference.occurrence) || null;
    return { changed: true, note: this.db.getNote(next.id), task };
  }
}
