// Reusable note templates for "New from template". Each `build()` returns the
// { title, content } for a fresh note; the date is resolved to today (local),
// embedded as an @date(...) block that the editor renders as a chip.

function todayISO() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

export function buildDailyNote(date = todayISO()) {
  if (!isCalendarDate(date)) throw new TypeError('Daily template dates must use YYYY-MM-DD.');
  return {
    title: date,
    content: `@date(${date})\n\n## Notes\n\n\n## Tasks\n- [ ] `,
  };
}

export const TEMPLATES = [
  {
    id: 'daily',
    label: 'Daily note',
    icon: '📅',
    build({ date = todayISO() } = {}) { return buildDailyNote(date); },
  },
  {
    id: 'meeting',
    label: 'Meeting note',
    icon: '🗓️',
    build() {
      const day = todayISO();
      return {
        title: `Meeting — ${day}`,
        content: `@date(${day})\n\n**Attendees:** \n\n## Agenda\n- \n\n## Notes\n\n\n## Action items\n- [ ] `,
      };
    },
  },
  {
    id: 'project',
    label: 'Project note',
    icon: '📁',
    build() {
      return {
        title: 'Project — Untitled',
        content: `# Project — Untitled\n\n**Status:** Planning\n\n## Goal\n\n\n## Milestones\n- [ ] \n\n## Notes\n`,
      };
    },
  },
];

export function templateById(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}
