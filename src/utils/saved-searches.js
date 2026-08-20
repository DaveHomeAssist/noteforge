import { uid } from './helpers.js';

export const SAVED_SEARCH_LIMIT = 30;
export const SAVED_SEARCH_SORTS = Object.freeze(['updated', 'created', 'title']);

function cleanRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const icon = typeof input.icon === 'string' ? [...input.icon.trim()].slice(0, 4).join('') : '';
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, 500) : null;
  const sortMode = SAVED_SEARCH_SORTS.includes(input.sortMode) ? input.sortMode : null;
  const activeTag = input.activeTag === null || input.activeTag === undefined
    ? null
    : typeof input.activeTag === 'string'
      ? input.activeTag.trim().slice(0, 80) || null
      : false;
  const order = Number.isSafeInteger(input.order) && input.order >= 0 ? input.order : null;
  if (!id || id.length > 100 || !name || name.length > 80 || query === null || !sortMode || activeTag === false || order === null) return null;
  return { id, name, icon: icon || '🔎', query, sortMode, activeTag, order };
}

/** Strict config normalizer. Invalid/duplicate/overflow records are reported and excluded. */
export function normalizeSavedSearches(input) {
  const records = [];
  const rejected = [];
  const ids = new Set();
  const source = Array.isArray(input) ? input : [];
  source.forEach((value, index) => {
    const record = cleanRecord(value);
    if (!record || ids.has(record.id) || records.length >= SAVED_SEARCH_LIMIT) {
      rejected.push({ index, reason: !record ? 'malformed' : ids.has(record?.id) ? 'duplicate_id' : 'limit' });
      return;
    }
    ids.add(record.id);
    records.push(record);
  });
  records.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { records: records.map((record, order) => ({ ...record, order })), rejected };
}

export function createSavedSearch(records, input, { createId = uid } = {}) {
  const current = normalizeSavedSearches(records).records;
  if (current.length >= SAVED_SEARCH_LIMIT) throw new Error(`Saved searches are limited to ${SAVED_SEARCH_LIMIT}.`);
  const candidate = cleanRecord({
    id: createId(),
    name: input?.name,
    icon: input?.icon || '🔎',
    query: input?.query || '',
    sortMode: input?.sortMode || 'updated',
    activeTag: input?.activeTag ?? null,
    order: current.length,
  });
  if (!candidate || current.some((record) => record.id === candidate.id)) throw new Error('The saved search is malformed or has a duplicate ID.');
  return [...current, candidate];
}

export function updateSavedSearch(records, id, patch) {
  const current = normalizeSavedSearches(records).records;
  const index = current.findIndex((record) => record.id === id);
  if (index < 0) throw new Error('The saved search no longer exists.');
  const next = cleanRecord({ ...current[index], ...patch, id: current[index].id, order: current[index].order });
  if (!next) throw new Error('The saved search update is malformed.');
  return current.map((record, position) => position === index ? next : record);
}

export function moveSavedSearch(records, id, direction) {
  const current = normalizeSavedSearches(records).records;
  const from = current.findIndex((record) => record.id === id);
  const to = Math.max(0, Math.min(current.length - 1, from + (direction < 0 ? -1 : 1)));
  if (from < 0 || from === to) return current;
  const [moved] = current.splice(from, 1);
  current.splice(to, 0, moved);
  return current.map((record, order) => ({ ...record, order }));
}

export function removeSavedSearch(records, id) {
  return normalizeSavedSearches(records).records
    .filter((record) => record.id !== id)
    .map((record, order) => ({ ...record, order }));
}
