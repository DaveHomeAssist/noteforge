// Reusable note templates for "New from template". Each `build()` returns the
// { title, content } for a fresh note; the date is resolved to today (local),
// embedded as an @date(...) block that the editor renders as a chip.

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const TEMPLATES = [
  {
    id: 'daily',
    label: 'Daily note',
    icon: '📅',
    build() {
      const day = todayISO();
      return {
        title: day,
        content: `@date(${day})\n\n## Notes\n\n\n## Tasks\n- [ ] `,
      };
    },
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
