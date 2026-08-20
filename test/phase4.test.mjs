import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { editorTaskOccurrence } from '../src/app/phase4.js';
import { buildDailyNote } from '../src/app/templates.js';
import { CaptureService } from '../src/core/capture-service.js';
import { Database } from '../src/core/database.js';
import { TaskService } from '../src/core/task-service.js';
import { REVISION_REASONS } from '../src/core/revision-store.js';
import { parse, serialize } from '../src/utils/blocks.js';
import { buildCalendarItems, calendarItemsByDate, calendarPeriod } from '../src/utils/calendar.js';
import { appendCapturedMarkdown, buildCaptureMarkdown, consumeShareTarget, normalizeCaptureUrl } from '../src/utils/capture.js';
import { resolveDailyNote } from '../src/utils/daily-workflow.js';
import {
  addCalendarDays,
  addCalendarMonths,
  compareCalendarDates,
  isCalendarDate,
  localDateKey,
  monthPeriod,
} from '../src/utils/local-date.js';
import { extractTasks, groupTasks, mutateTaskSource, parseTaskDueText } from '../src/utils/tasks.js';

function note(id, title, content = '', extra = {}) {
  return { id, title, content, tags: [], isTrashed: false, isArchived: false, ...extra };
}

function memoryBackend() {
  const values = new Map();
  return {
    values,
    fail: false,
    async load(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    async save(key, value) {
      if (this.fail) return false;
      values.set(key, structuredClone(value));
      return true;
    },
    async saveMany(entries) {
      if (this.fail) return false;
      entries.forEach(([key, value]) => values.set(key, structuredClone(value)));
      return true;
    },
    async getStatus() { return { backend: 'indexeddb' }; },
  };
}

async function database() {
  const backend = memoryBackend();
  const captures = [];
  const db = new Database({ storageBackend: backend, onNotesPersisted: async (batch) => captures.push(...structuredClone(batch)) });
  await db.init();
  return { db, backend, captures };
}

test('local calendar helpers never derive Today through UTC and cover boundary arithmetic', () => {
  const localFixture = { getFullYear: () => 2026, getMonth: () => 11, getDate: () => 31 };
  assert.equal(localDateKey(localFixture), '2026-12-31');
  assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(compareCalendarDates('2026-03-08', '2026-03-09'), -1, 'DST boundary compares tuples, not elapsed local hours');
  assert.equal(isCalendarDate('2026-02-29'), false);
  assert.equal(monthPeriod('2026-08-20').days.length, 42);
  assert.deepEqual(buildDailyNote('2024-02-29'), {
    title: '2024-02-29',
    content: '@date(2024-02-29)\n\n## Notes\n\n\n## Tasks\n- [ ] ',
  });
  assert.throws(() => buildDailyNote('2026-02-29'), /YYYY-MM-DD/);
});

test('local Today resolves the same instant independently in multiple time zones', () => {
  const moduleUrl = new URL('../src/utils/local-date.js', import.meta.url).href;
  const script = `import { localDateKey } from ${JSON.stringify(moduleUrl)}; process.stdout.write(localDateKey(new Date('2026-03-08T04:30:00.000Z')));`;
  const run = (timezone) => spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', env: { ...process.env, TZ: timezone },
  });
  const newYork = run('America/New_York');
  const kiritimati = run('Pacific/Kiritimati');
  assert.equal(newYork.status, 0, newYork.stderr);
  assert.equal(kiritimati.status, 0, kiritimati.stderr);
  assert.equal(newYork.stdout, '2026-03-07');
  assert.equal(kiritimati.stdout, '2026-03-08');
});

test('task due suffix parser accepts only valid terminal markers outside code and escapes', () => {
  assert.deepEqual(parseTaskDueText('Ship release @due(2026-08-21)'), {
    text: 'Ship release', dueDate: '2026-08-21', separator: ' ', trailing: '',
  });
  assert.equal(parseTaskDueText('Impossible @due(2026-02-30)').dueDate, null);
  assert.equal(parseTaskDueText('Escaped \\@due(2026-08-21)').dueDate, null);
  assert.equal(parseTaskDueText('`@due(2026-08-21)`').dueDate, null);
  assert.equal(parseTaskDueText('ordinary @date(2026-08-21)').dueDate, null);
});

test('task blocks preserve valid, invalid, nested, checked, whitespace, and CRLF source as fixed points', () => {
  const source = [
    '- [ ] Open @due(2026-08-21)',
    '  - [x] Done  @due(2026-08-22)  ',
    '- [ ] Invalid @due(2026-02-30)',
    '- [ ] `code @due(2026-08-23)`',
  ].join('\n');
  const blocks = parse(source);
  assert.equal(serialize(blocks), source);
  assert.deepEqual(extractTasks(source).map((task) => task.dueDate), [
    '2026-08-21', '2026-08-22', null, null,
  ]);
  assert.deepEqual(extractTasks('~~~md\n- [ ] Hidden @due(2026-08-24)\n~~~~\n- [ ] Visible after tilde fence')
    .map((task) => task.text), ['Visible after tilde fence']);
  const fenced = '~~~md\r\n- [ ] Hidden\r\n~~~\r\n```md\r\n- [ ] Hidden too\r\n```\r\n- [ ] Visible';
  assert.equal(editorTaskOccurrence(fenced, extractTasks(fenced)[0]), 1);
  const crlfTasks = extractTasks('- [ ] One\r\n- [x] Two @due(2026-08-21)\r\n', { noteId: 'crlf' });
  assert.deepEqual(crlfTasks.map((task) => [task.sourceStart, task.sourceEnd, task.checked]), [[0, 9, false], [11, 37, true]]);
});

test('exact task mutation distinguishes duplicate text and rejects ambiguous stale references', () => {
  const source = '- [ ] Duplicate\n- [ ] Duplicate\n- [ ] Unique @due(2026-08-21)';
  const tasks = extractTasks(source, { noteId: 'n' });
  const toggled = mutateTaskSource(source, tasks[1], { checked: true });
  assert.equal(toggled.content, '- [ ] Duplicate\n- [x] Duplicate\n- [ ] Unique @due(2026-08-21)');
  const moved = mutateTaskSource(`Heading\n${source}`, tasks[2], { dueDate: '2026-08-30' });
  assert.match(moved.content, /Unique @due\(2026-08-30\)$/);
  assert.throws(() => mutateTaskSource(`Heading\n${source}`, tasks[0], { checked: true }), /changed after the dashboard loaded/);
  assert.equal(mutateTaskSource(source, tasks[2], { dueDate: null }).content.endsWith('- [ ] Unique'), true);
});

test('task grouping uses local date tuples and separates completed state', () => {
  const tasks = extractTasks([
    '- [ ] Today @due(2026-08-20)',
    '- [ ] Late @due(2026-08-19)',
    '- [ ] Later @due(2026-09-01)',
    '- [ ] Someday',
    '- [x] Finished @due(2026-08-20)',
  ].join('\n'), { noteId: 'n', noteTitle: 'Tasks' });
  const groups = groupTasks(tasks, '2026-08-20');
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.map((task) => task.text)])), {
    today: ['Today'], overdue: ['Late'], upcoming: ['Later'], noDate: ['Someday'], completed: ['Finished'],
  });
});

test('Daily resolver is idempotent across active, Archive, Trash, missing, and ambiguity states', () => {
  assert.equal(resolveDailyNote([note('a', '2026-08-20')], '2026-08-20').status, 'active');
  assert.equal(resolveDailyNote([note('a', '2026-08-20', '', { isArchived: true })], '2026-08-20').status, 'archived');
  assert.equal(resolveDailyNote([note('a', '2026-08-20', '', { isTrashed: true })], '2026-08-20').status, 'trashed');
  assert.equal(resolveDailyNote([], '2026-08-20').status, 'missing');
  assert.equal(resolveDailyNote([note('a', '2026-08-20'), note('b', '2026-08-20')], '2026-08-20').status, 'ambiguous');
});

test('GET share-target intake is allowlisted, bounded, URL-safe, and one-shot', () => {
  const result = consumeShareTarget('https://example.test/noteforge/?source=share-target&title=Shared&text=Hello&url=https%3A%2F%2Fexample.com%2Fx&admin=true#keep');
  assert.equal(result.matched, true);
  assert.deepEqual(result.payload, { title: 'Shared', text: 'Hello', url: 'https://example.com/x' });
  assert.equal(result.cleanUrl, '/noteforge/#keep');
  assert.equal(consumeShareTarget('https://example.test/noteforge/?title=Ignored').matched, false);
  assert.throws(() => normalizeCaptureUrl('javascript:alert(1)'), /Only http and https/);
});

test('capture Markdown composes text, URL, and image without dropping existing source', () => {
  const markdown = buildCaptureMarkdown({
    title: 'Reference [safe]',
    text: 'Plain capture',
    url: 'https://example.com/path',
    imageDataUrl: 'data:image/png;base64,AA==',
    imageAlt: 'Local [ ] image',
  });
  assert.equal(markdown.startsWith('Plain capture\n\n[Reference \\[safe\\]](https://example.com/path)'), true);
  assert.match(markdown, /!\[Local image\]\(data:image\/png;base64,AA==\)$/);
  assert.equal(appendCapturedMarkdown('Existing\n\n', markdown), `Existing\n\n${markdown}`);
});

test('calendar aggregation combines Daily notes, date blocks, and due tasks while excluding hidden lifecycles', () => {
  const notes = [
    note('daily', '2026-08-20', '@date(2026-08-20)\n\n- [ ] Ship @due(2026-08-20)'),
    note('event', 'Planning', '@date(2026-08-21)\n\n- [x] Review @due(2026-08-22)'),
    note('fenced', 'Fenced', '~~~md\n@date(2026-08-25)\n- [ ] Hidden @due(2026-08-25)\n~~~'),
    note('archived', 'Archived', '@date(2026-08-23)', { isArchived: true }),
    note('trash', 'Trash', '- [ ] Hidden @due(2026-08-24)', { isTrashed: true }),
  ];
  const items = buildCalendarItems(notes);
  assert.deepEqual(items.map((item) => [item.type, item.date, item.noteId]), [
    ['daily', '2026-08-20', 'daily'],
    ['task', '2026-08-20', 'daily'],
    ['date', '2026-08-21', 'event'],
    ['task', '2026-08-22', 'event'],
  ]);
  assert.equal(calendarItemsByDate(items).get('2026-08-20').length, 2);
  assert.equal(calendarPeriod('week', '2026-08-20').days.length, 7);
  assert.equal(calendarPeriod('month', '2026-08-20').days.length, 42);
});

test('CaptureService creates/reuses Inbox and routes exact Markdown through durable normal saves', async () => {
  const { db, backend, captures } = await database();
  const service = new CaptureService(db);
  const first = await service.save({ destination: 'inbox', markdown: 'First capture' });
  assert.equal(first.created, true);
  assert.equal(first.note.title, 'Inbox');
  const second = await service.save({ destination: 'inbox', markdown: 'Second capture' });
  assert.equal(second.created, false);
  assert.equal(second.note.content, 'First capture\n\nSecond capture');
  assert.equal(captures.at(-1).reason, 'quick_capture');
  assert.equal(backend.values.get('notes').find((stored) => stored.id === second.note.id).content, second.note.content);
  const other = db.createNote({ id: 'other', title: 'Other', content: 'Start' });
  await db.flush();
  await service.save({ destination: 'existing', noteId: other.id, markdown: 'Finish' });
  assert.equal(db.getNote(other.id).content, 'Start\n\nFinish');
});

test('CaptureService reports failed persistence and refuses hidden Inbox ambiguity', async () => {
  const { db, backend } = await database();
  db.createNote({ id: 'archived-inbox', title: 'Inbox', archivedAt: '2026-08-20T00:00:00.000Z' });
  await db.flush();
  const service = new CaptureService(db);
  await assert.rejects(service.save({ destination: 'inbox', markdown: 'Blocked' }), /Archive or Trash/);
  const target = db.createNote({ id: 'target', title: 'Target' });
  await db.flush();
  backend.fail = true;
  await assert.rejects(service.save({ destination: 'existing', noteId: target.id, markdown: 'Pending' }), /still pending/);
  assert.equal(db.getPersistenceStatus().pendingWrites > 0, true);
});

test('TaskService excludes Archive/Trash and applies one exact task with a pre-change revision', async () => {
  assert.equal(REVISION_REASONS.includes('pre_task_change'), true);
  assert.equal(REVISION_REASONS.includes('quick_capture'), true);
  const { db, captures } = await database();
  db.createNote({ id: 'active', title: 'Active', content: '- [ ] Same\n- [ ] Same @due(2026-08-21)', tags: ['work'] });
  db.createNote({ id: 'archive', title: 'Archive', content: '- [ ] Hidden', archivedAt: '2026-08-20T00:00:00.000Z' });
  const trash = db.createNote({ id: 'trash', title: 'Trash', content: '- [ ] Hidden' });
  db.deleteNote(trash.id);
  await db.flush();
  captures.length = 0;
  const service = new TaskService(db);
  const tasks = service.list();
  assert.deepEqual(tasks.map((task) => [task.noteId, task.occurrence]), [['active', 0], ['active', 1]]);
  const result = await service.update(tasks[1], { checked: true, dueDate: '2026-08-30' });
  assert.equal(result.changed, true);
  assert.equal(db.getNote('active').content, '- [ ] Same\n- [x] Same @due(2026-08-30)');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].reason, 'pre_task_change');
  assert.equal(captures[0].note.content, '- [ ] Same\n- [ ] Same @due(2026-08-21)');
});

test('1,000-note task derivation stays within the shared interaction budget', () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => note(`n-${index}`, `Note ${index}`, `# Work\n\n- [ ] Task ${index} @due(2026-08-21)`));
  const service = new TaskService({ getAllNotes: () => notes });
  const start = performance.now();
  const tasks = service.list();
  const elapsed = performance.now() - start;
  assert.equal(tasks.length, 1_000);
  assert.ok(elapsed < 150, `task derivation took ${elapsed.toFixed(2)}ms`);
});
