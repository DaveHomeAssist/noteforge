const HISTORY_LIMIT = 100;
export const RECENT_LIMIT = 50;

export function createNavigationState(current = null) {
  return Object.freeze({ back: [], current: typeof current === 'string' ? current : null, forward: [] });
}

function bounded(ids) {
  return ids.slice(Math.max(0, ids.length - HISTORY_LIMIT));
}

export function navigate(state, noteId) {
  if (typeof noteId !== 'string' || !noteId || state.current === noteId) return state;
  return Object.freeze({
    back: bounded(state.current ? [...state.back, state.current] : [...state.back]),
    current: noteId,
    forward: [],
  });
}

export function goBack(state, valid = () => true) {
  const back = [...state.back];
  let target = null;
  while (back.length && !target) {
    const candidate = back.pop();
    if (valid(candidate)) target = candidate;
  }
  if (!target) return state;
  return Object.freeze({
    back,
    current: target,
    forward: state.current ? [state.current, ...state.forward].slice(0, HISTORY_LIMIT) : [...state.forward],
  });
}

export function goForward(state, valid = () => true) {
  const forward = [...state.forward];
  let target = null;
  while (forward.length && !target) {
    const candidate = forward.shift();
    if (valid(candidate)) target = candidate;
  }
  if (!target) return state;
  return Object.freeze({
    back: bounded(state.current ? [...state.back, state.current] : [...state.back]),
    current: target,
    forward,
  });
}

export function pruneNavigation(state, valid) {
  const current = state.current && valid(state.current) ? state.current : null;
  return Object.freeze({
    back: state.back.filter(valid).slice(-HISTORY_LIMIT),
    current,
    forward: state.forward.filter(valid).slice(0, HISTORY_LIMIT),
  });
}

export function normalizeRecentIds(ids, valid = () => true) {
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || !id || seen.has(id) || !valid(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length === RECENT_LIMIT) break;
  }
  return result;
}

export function recordRecent(ids, noteId, valid = () => true) {
  return normalizeRecentIds([noteId, ...(Array.isArray(ids) ? ids : [])], valid);
}

/** Stateful adapter loaded after the first usable note. */
export class NavigationController {
  constructor(db, { state = createNavigationState(), recentIds = [] } = {}) {
    this.db = db;
    this.state = pruneNavigation(state, (id) => Boolean(db.getNote(id)));
    this.recentIds = normalizeRecentIds(recentIds, (id) => Boolean(db.getNote(id)));
  }

  recordOpen(id, { replay = false } = {}) {
    if (!replay) this.state = navigate(this.state, id);
    const recent = recordRecent(this.recentIds, id, (noteId) => Boolean(this.db.getNote(noteId)));
    if (JSON.stringify(recent) !== JSON.stringify(this.recentIds)) {
      this.recentIds = recent;
      this.db.setConfig({ recentNoteIds: recent });
    }
  }

  replaceCurrent(id) {
    const current = typeof id === 'string' && this.db.getNote(id) ? id : null;
    this.state = Object.freeze({ ...this.state, current });
  }

  back(valid) {
    const next = goBack(this.state, valid);
    if (next === this.state) return null;
    this.state = next;
    return next.current;
  }

  forward(valid) {
    const next = goForward(this.state, valid);
    if (next === this.state) return null;
    this.state = next;
    return next.current;
  }

  prune(valid) {
    this.state = pruneNavigation(this.state, valid);
    const recent = normalizeRecentIds(this.recentIds, valid);
    if (JSON.stringify(recent) !== JSON.stringify(this.recentIds)) {
      this.recentIds = recent;
      this.db.setConfig({ recentNoteIds: recent });
    }
  }
}
