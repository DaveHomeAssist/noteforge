import { Note } from './note.js';
import { appendCapturedMarkdown } from '../utils/capture.js';
import { normalizeTitle } from '../utils/helpers.js';

function occurrences(text, block) {
  let count = 0;
  for (let index = text.indexOf(block); index !== -1; index = text.indexOf(block, index + block.length)) count++;
  return count;
}

// A later save of the same note may supersede the capture before it commits.
// It acknowledges the capture only if it still contains every captured copy.
function containing(block, submitted) {
  const expected = occurrences(submitted, block);
  return (value) => typeof value?.content === 'string' && occurrences(value.content, block) >= expected;
}

export class CaptureService {
  constructor(db) {
    this.db = db;
    // The caller retains one request object until its capture is acknowledged.
    // Retrying that request must not append its Markdown a second time.
    this.submissions = new WeakMap();
  }

  #findActiveTitle(title) {
    const key = normalizeTitle(title);
    return this.db.getAllNotes().find((note) => normalizeTitle(note.title) === key) || null;
  }

  #submit({ destination = 'inbox', noteId = null, newTitle = '', markdown = '' }) {
    if (!String(markdown).trim()) throw new TypeError('Add text, a URL, clipboard content, or an image before saving.');
    let note = null;
    let title = null;
    if (destination === 'existing') {
      note = this.db.getNote(noteId);
      if (!note) throw new Error('The selected destination note is no longer active.');
    } else if (destination === 'new') {
      title = this.db.availableTitle(String(newTitle).trim() || 'Quick capture');
    } else {
      note = this.#findActiveTitle('Inbox');
      if (!note) {
        const hidden = this.db.getNotesInScope('all').find((candidate) => normalizeTitle(candidate.title) === 'inbox');
        if (hidden) throw new Error('Inbox is in Archive or Trash. Restore it or choose another destination.');
        title = 'Inbox';
      }
    }
    const options = { captureRevision: true, reason: 'quick_capture' };
    if (title !== null) {
      const content = String(markdown);
      const submission = this.db.createNoteWithReceipt(
        { title, content },
        { ...options, contains: containing(content.trim(), content) },
      );
      return { ...submission, created: true };
    }
    const next = Note.fromJSON(structuredClone(note.toJSON()));
    next.update({ content: appendCapturedMarkdown(next.content, markdown) });
    const added = next.content.startsWith(note.content) ? next.content.slice(note.content.length) : String(markdown);
    return {
      ...this.db.saveNoteWithReceipt(next, { ...options, contains: containing(added.trim(), next.content) }),
      created: false,
    };
  }

  async save(input = {}) {
    let submission = this.submissions.get(input);
    if (!submission) {
      submission = this.#submit(input);
      this.submissions.set(input, submission);
    } else if (submission.receipt && submission.receipt.status !== 'committed') {
      const raw = submission.receipt.note;
      const current = this.db.getNote(raw.id);
      if (!current || JSON.stringify(current.toJSON()) !== JSON.stringify(raw))
        throw new Error('The capture destination changed. Review the saved note and recovery drafts before retrying.');
      submission.completion = this.db.saveNoteWithReceipt(Note.fromJSON(structuredClone(raw)), {
        reason: 'quick_capture',
      }).completion;
      submission.receipt = null;
    }
    const receipt = await submission.completion;
    submission.receipt = receipt;
    if (receipt.status !== 'committed')
      throw new Error('Capture is still pending. Retry this capture, or review and export recovery drafts.');
    // Return precisely the acknowledged version, not a newer mutable destination.
    return {
      note: Note.fromJSON(structuredClone(receipt.note)),
      created: submission.created,
      receipt: structuredClone(receipt),
    };
  }
}
