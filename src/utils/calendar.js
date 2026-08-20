import { isCalendarDate, monthPeriod, parseCalendarDate, weekPeriod } from './local-date.js';
import { extractTasks } from './tasks.js';

function extractDateBlocks(markdown) {
  const dates = [];
  let fence = null;
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, occurrence) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    const match = /^@date\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(line);
    if (match && isCalendarDate(match[1])) dates.push({ date: match[1], occurrence });
  });
  return dates;
}

export function buildCalendarItems(notes) {
  const items = [];
  for (const note of notes || []) {
    if (!note || note.isTrashed || note.isArchived) continue;
    const titleDate = String(note.title || '').trim();
    if (isCalendarDate(titleDate)) {
      items.push({ id: `daily:${note.id}`, type: 'daily', date: titleDate, noteId: note.id, noteTitle: note.title, label: 'Daily note' });
    }
    for (const date of extractDateBlocks(note.content)) {
      // The standard Daily template contains its own matching @date block. One
      // source note should occupy one calendar row, not duplicate itself.
      if (date.date === titleDate) continue;
      items.push({ id: `date:${note.id}:${date.occurrence}`, type: 'date', date: date.date, noteId: note.id, noteTitle: note.title, label: 'Date' });
    }
    for (const task of extractTasks(note.content, { noteId: note.id, noteTitle: note.title, noteTags: note.tags })) {
      if (!task.dueDate) continue;
      items.push({ id: `task:${task.id}`, type: 'task', date: task.dueDate, noteId: note.id, noteTitle: note.title, label: task.text || 'Untitled task', checked: task.checked, task });
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.noteTitle.localeCompare(b.noteTitle) || a.id.localeCompare(b.id));
}

export function calendarItemsByDate(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const list = grouped.get(item.date) || [];
    list.push(item);
    grouped.set(item.date, list);
  }
  return grouped;
}

export function calendarPeriod(mode, anchor) {
  if (!parseCalendarDate(anchor)) throw new TypeError('Calendar period requires a valid anchor date.');
  return mode === 'week' ? weekPeriod(anchor) : monthPeriod(anchor);
}
