// Pure Phase 6 workspace state. Only note IDs and presentation state persist;
// note content, editor history, selections, and unsaved bytes never enter config.

export const WORKSPACE_VERSION = 1;
export const WORKSPACE_MAX_TABS = 20;
export const WORKSPACE_MAX_RECENTLY_CLOSED = 10;
export const WORKSPACE_PANES = Object.freeze(['primary', 'secondary']);

const pane = () => ({ tabs: [], activeNoteId: null, scrollTop: 0 });

export function emptyWorkspaceState() {
  return {
    version: WORKSPACE_VERSION,
    activePane: 'primary',
    panes: { primary: pane(), secondary: pane() },
    split: { enabled: false, ratio: 0.5 },
    recentlyClosed: [],
  };
}

const finiteScroll = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const ratio = (value) => Number.isFinite(Number(value)) ? Math.max(0.25, Math.min(0.75, Number(value))) : 0.5;

function noteMap(notes) {
  return new Map((notes || []).filter((note) => note && typeof note.id === 'string').map((note) => [note.id, note]));
}

function usable(note) {
  return Boolean(note && !note.deletedAt);
}

function editable(note) {
  return usable(note) && !note.archivedAt;
}

/** Normalize corrupt/stale config and enforce global note ownership. */
export function normalizeWorkspaceState(raw, notes = []) {
  const source = raw && raw.version === WORKSPACE_VERSION ? raw : {};
  const available = noteMap(notes);
  const next = emptyWorkspaceState();
  const seen = new Set();
  for (const name of WORKSPACE_PANES) {
    const input = source.panes?.[name] || {};
    for (const id of Array.isArray(input.tabs) ? input.tabs : []) {
      if (typeof id !== 'string' || seen.has(id) || !usable(available.get(id)) || seen.size >= WORKSPACE_MAX_TABS) continue;
      seen.add(id);
      next.panes[name].tabs.push(id);
    }
    next.panes[name].activeNoteId = next.panes[name].tabs.includes(input.activeNoteId) && editable(available.get(input.activeNoteId))
      ? input.activeNoteId
      : next.panes[name].tabs.find((id) => editable(available.get(id))) || null;
    next.panes[name].scrollTop = finiteScroll(input.scrollTop);
  }
  next.split.enabled = Boolean(source.split?.enabled);
  next.split.ratio = ratio(source.split?.ratio);
  next.activePane = WORKSPACE_PANES.includes(source.activePane) ? source.activePane : 'primary';
  if (!next.panes[next.activePane].activeNoteId) {
    next.activePane = next.panes.primary.activeNoteId ? 'primary'
      : next.panes.secondary.activeNoteId ? 'secondary'
        : 'primary';
  }
  next.recentlyClosed = [...new Set(Array.isArray(source.recentlyClosed) ? source.recentlyClosed : [])]
    .filter((id) => typeof id === 'string' && usable(available.get(id)) && !seen.has(id))
    .slice(0, WORKSPACE_MAX_RECENTLY_CLOSED);
  return next;
}

const copy = (state) => structuredClone(state);

export function locateWorkspaceNote(state, noteId) {
  for (const name of WORKSPACE_PANES) {
    const index = state.panes[name].tabs.indexOf(noteId);
    if (index >= 0) return { pane: name, index };
  }
  return null;
}

export function openWorkspaceNote(state, noteId, targetPane = state.activePane) {
  const next = copy(state);
  const existing = locateWorkspaceNote(next, noteId);
  if (existing) {
    next.activePane = existing.pane;
    next.panes[existing.pane].activeNoteId = noteId;
    return next;
  }
  const total = WORKSPACE_PANES.reduce((sum, name) => sum + next.panes[name].tabs.length, 0);
  if (total >= WORKSPACE_MAX_TABS) {
    const error = new Error(`A workspace can keep at most ${WORKSPACE_MAX_TABS} tabs open.`);
    error.code = 'workspace_tab_limit';
    throw error;
  }
  const name = WORKSPACE_PANES.includes(targetPane) ? targetPane : 'primary';
  next.panes[name].tabs.push(noteId);
  next.panes[name].activeNoteId = noteId;
  next.activePane = name;
  next.recentlyClosed = next.recentlyClosed.filter((id) => id !== noteId);
  return next;
}

export function activateWorkspacePane(state, name) {
  if (!WORKSPACE_PANES.includes(name)) return copy(state);
  const next = copy(state);
  next.activePane = name;
  return next;
}

export function closeWorkspaceTab(state, noteId) {
  const next = copy(state);
  const located = locateWorkspaceNote(next, noteId);
  if (!located) return next;
  const target = next.panes[located.pane];
  target.tabs.splice(located.index, 1);
  if (target.activeNoteId === noteId) {
    target.activeNoteId = target.tabs[Math.min(located.index, target.tabs.length - 1)] || null;
  }
  next.recentlyClosed = [noteId, ...next.recentlyClosed.filter((id) => id !== noteId)]
    .slice(0, WORKSPACE_MAX_RECENTLY_CLOSED);
  if (!next.panes[next.activePane].activeNoteId) {
    const other = located.pane === 'primary' ? 'secondary' : 'primary';
    if (next.panes[other].activeNoteId) next.activePane = other;
  }
  return next;
}

export function reopenWorkspaceTab(state, targetPane = state.activePane) {
  const noteId = state.recentlyClosed[0];
  return noteId ? openWorkspaceNote(state, noteId, targetPane) : copy(state);
}

export function reorderWorkspaceTab(state, paneName, noteId, targetIndex) {
  const next = copy(state);
  const target = next.panes[paneName];
  const index = target?.tabs.indexOf(noteId) ?? -1;
  if (index < 0) return next;
  target.tabs.splice(index, 1);
  target.tabs.splice(Math.max(0, Math.min(Number(targetIndex) || 0, target.tabs.length)), 0, noteId);
  return next;
}

export function moveWorkspaceTab(state, noteId, targetPane, targetIndex = null) {
  const next = copy(state);
  const located = locateWorkspaceNote(next, noteId);
  if (!located || !WORKSPACE_PANES.includes(targetPane)) return next;
  if (located.pane === targetPane) return reorderWorkspaceTab(next, targetPane, noteId, targetIndex ?? located.index);
  const from = next.panes[located.pane];
  const to = next.panes[targetPane];
  from.tabs.splice(located.index, 1);
  if (from.activeNoteId === noteId) from.activeNoteId = from.tabs[Math.min(located.index, from.tabs.length - 1)] || null;
  to.tabs.splice(targetIndex === null ? to.tabs.length : Math.max(0, Math.min(Number(targetIndex) || 0, to.tabs.length)), 0, noteId);
  to.activeNoteId = noteId;
  next.activePane = targetPane;
  next.split.enabled = true;
  return next;
}

export function setWorkspaceSplit(state, enabled) {
  const next = copy(state);
  next.split.enabled = Boolean(enabled);
  return next;
}

export function setWorkspaceRatio(state, value) {
  const next = copy(state);
  next.split.ratio = ratio(value);
  return next;
}

export function setWorkspaceScroll(state, paneName, scrollTop) {
  const next = copy(state);
  if (next.panes[paneName]) next.panes[paneName].scrollTop = finiteScroll(scrollTop);
  return next;
}
