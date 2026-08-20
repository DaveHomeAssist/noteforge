import { Note } from './note.js';
import { appendCapturedMarkdown } from '../utils/capture.js';
import { normalizeTitle } from '../utils/helpers.js';

export class CaptureService {
  constructor(db) {
    this.db = db;
  }

  #findActiveTitle(title) {
    const key = normalizeTitle(title);
    return this.db.getAllNotes().find((note) => normalizeTitle(note.title) === key) || null;
  }

  async save({ destination = 'inbox', noteId = null, newTitle = '', markdown = '' } = {}) {
    if (!String(markdown).trim()) throw new TypeError('Add text, a URL, clipboard content, or an image before saving.');
    let note = null;
    let created = false;
    if (destination === 'existing') {
      note = this.db.getNote(noteId);
      if (!note) throw new Error('The selected destination note is no longer active.');
    } else if (destination === 'new') {
      const title = this.db.availableTitle(String(newTitle).trim() || 'Quick capture');
      note = this.db.createNote({ title, content: String(markdown) });
      created = true;
    } else {
      note = this.#findActiveTitle('Inbox');
      if (!note) {
        const hidden = this.db.getNotesInScope('all').find((candidate) => normalizeTitle(candidate.title) === 'inbox');
        if (hidden) throw new Error('Inbox is in Archive or Trash. Restore it or choose another destination.');
        note = this.db.createNote({ title: 'Inbox', content: String(markdown) });
        created = true;
      }
    }

    if (!created) {
      const next = Note.fromJSON(note.toJSON());
      next.update({ content: appendCapturedMarkdown(next.content, markdown) });
      note = this.db.saveNote(next, { reason: 'quick_capture' });
    }
    if (!await this.db.flushCurrentWrites()) throw new Error('Capture is still pending because browser storage did not accept it.');
    return { note: this.db.getNote(note.id), created };
  }
}
