import { compareCalendarDates, isCalendarDate } from './local-date.js';

const TASK_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;
const DUE_RE = /(\s+)@due\((\d{4}-\d{2}-\d{2})\)(\s*)$/;

function hashLine(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hasOpenInlineCode(text, end) {
  let open = null;
  for (let index = 0; index < end;) {
    if (text[index] !== '`' || (index > 0 && text[index - 1] === '\\')) { index += 1; continue; }
    let width = 1;
    while (text[index + width] === '`') width += 1;
    if (open === null) open = width;
    else if (open === width) open = null;
    index += width;
  }
  return open !== null;
}

export function parseTaskDueText(value) {
  const source = String(value ?? '');
  const match = DUE_RE.exec(source);
  if (!match || !isCalendarDate(match[2]) || hasOpenInlineCode(source, match.index)) {
    const trailing = /\s*$/.exec(source)?.[0] || '';
    return { text: source.slice(0, source.length - trailing.length), dueDate: null, separator: '', trailing };
  }
  return {
    text: source.slice(0, match.index),
    dueDate: match[2],
    separator: match[1],
    trailing: match[3],
  };
}

function sourceLines(markdown) {
  const source = String(markdown ?? '');
  const lines = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1;
    let next = end;
    if (source[next] === '\r') next += 1;
    if (source[next] === '\n') next += 1;
    lines.push({ text: source.slice(start, end), start, end, newline: source.slice(end, next) });
    start = next;
  }
  if (source.length === 0) return [];
  if (/\r?\n$/.test(source)) lines.push({ text: '', start: source.length, end: source.length, newline: '' });
  return lines;
}

export function extractTasks(markdown, { noteId = '', noteTitle = '', noteTags = [] } = {}) {
  const tasks = [];
  let heading = '';
  let fence = null;
  let occurrence = 0;
  for (const line of sourceLines(markdown)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!fence && marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line.text);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text);
    if (headingMatch) { heading = headingMatch[2]; continue; }
    const match = TASK_RE.exec(line.text);
    if (!match) continue;
    const due = parseTaskDueText(match[4]);
    const prefix = `${match[1]}${match[2]}${match[3]}`;
    const lineHash = hashLine(line.text);
    tasks.push(Object.freeze({
      id: `${noteId}:${occurrence}:${lineHash}`,
      noteId,
      noteTitle,
      noteTags: [...noteTags],
      occurrence,
      sourceStart: line.start,
      sourceEnd: line.end,
      sourceLine: line.text,
      lineHash,
      checked: match[2].toLowerCase() === 'x',
      markerPrefix: match[1],
      markerSuffix: match[3],
      text: due.text,
      dueDate: due.dueDate,
      dueSeparator: due.separator,
      trailingWhitespace: due.trailing,
      heading,
    }));
    occurrence += 1;
  }
  return tasks;
}

function resolveTask(content, reference) {
  const direct = String(content).slice(reference.sourceStart, reference.sourceEnd);
  if (direct === reference.sourceLine && hashLine(direct) === reference.lineHash) {
    return { ...reference };
  }
  const matches = extractTasks(content, { noteId: reference.noteId })
    .filter((task) => task.lineHash === reference.lineHash && task.sourceLine === reference.sourceLine);
  if (matches.length === 1) return matches[0];
  throw new Error('This task changed after the dashboard loaded. Refresh the task list and try again.');
}

export function mutateTaskSource(content, reference, patch = {}) {
  const source = String(content ?? '');
  const task = resolveTask(source, reference);
  const checked = patch.checked === undefined ? task.checked : Boolean(patch.checked);
  const dueDate = patch.dueDate === undefined ? task.dueDate : (patch.dueDate || null);
  if (dueDate !== null && !isCalendarDate(dueDate)) throw new TypeError('Task due dates must be valid YYYY-MM-DD dates.');
  const checkbox = checked ? 'x' : ' ';
  const due = dueDate
    ? `${task.dueDate ? task.dueSeparator : ' '}@due(${dueDate})${task.trailingWhitespace}`
    : task.trailingWhitespace;
  const nextLine = `${task.markerPrefix}${checkbox}${task.markerSuffix}${task.text}${due}`;
  return {
    changed: nextLine !== task.sourceLine,
    content: source.slice(0, task.sourceStart) + nextLine + source.slice(task.sourceEnd),
    previous: task,
    nextLine,
  };
}

export function groupTasks(tasks, today) {
  if (!isCalendarDate(today)) throw new TypeError('Task grouping requires a valid local date.');
  const groups = { today: [], overdue: [], upcoming: [], noDate: [], completed: [] };
  for (const task of tasks || []) {
    if (task.checked) groups.completed.push(task);
    else if (!task.dueDate) groups.noDate.push(task);
    else {
      const compared = compareCalendarDates(task.dueDate, today);
      if (compared === 0) groups.today.push(task);
      else if (compared < 0) groups.overdue.push(task);
      else groups.upcoming.push(task);
    }
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'))
      || String(a.noteTitle).localeCompare(String(b.noteTitle)) || a.occurrence - b.occurrence);
  }
  return groups;
}
