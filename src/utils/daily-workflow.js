import { normalizeTitle } from './helpers.js';
import { isCalendarDate } from './local-date.js';

export function resolveDailyNote(notes, dateKey) {
  if (!isCalendarDate(dateKey)) throw new TypeError('Daily notes require a valid local YYYY-MM-DD date.');
  const key = normalizeTitle(dateKey);
  const matches = (notes || []).filter((note) => normalizeTitle(note?.title) === key);
  const active = matches.filter((note) => !note.isTrashed && !note.isArchived);
  if (active.length === 1) return { status: 'active', note: active[0], matches };
  if (active.length > 1) return { status: 'ambiguous', note: null, matches };
  const archived = matches.filter((note) => !note.isTrashed && note.isArchived);
  if (archived.length === 1) return { status: 'archived', note: archived[0], matches };
  if (archived.length > 1) return { status: 'ambiguous', note: null, matches };
  const trashed = matches.filter((note) => note.isTrashed);
  if (trashed.length === 1) return { status: 'trashed', note: trashed[0], matches };
  if (trashed.length > 1) return { status: 'ambiguous', note: null, matches };
  return { status: 'missing', note: null, matches: [] };
}
