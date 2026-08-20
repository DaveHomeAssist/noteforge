export function createSelection(ids = [], anchorId = null) {
  return { ids: new Set(ids), anchorId: typeof anchorId === 'string' ? anchorId : null };
}

export function toggleSelection(state, id, orderedIds = [], { range = false } = {}) {
  const ids = new Set(state?.ids || []);
  let anchorId = state?.anchorId || null;
  if (range && anchorId) {
    const from = orderedIds.indexOf(anchorId);
    const to = orderedIds.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      for (const selected of orderedIds.slice(start, end + 1)) ids.add(selected);
      return { ids, anchorId };
    }
  }
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  anchorId = id;
  return { ids, anchorId };
}

export function extendSelection(state, orderedIds, direction) {
  const anchor = state?.anchorId;
  if (!anchor || !orderedIds.length) return state;
  const selected = [...(state.ids || [])];
  const edge = selected.length ? selected[selected.length - 1] : anchor;
  const from = Math.max(0, orderedIds.indexOf(edge));
  const target = orderedIds[Math.max(0, Math.min(orderedIds.length - 1, from + (direction < 0 ? -1 : 1)))];
  return toggleSelection(state, target, orderedIds, { range: true });
}

export function pruneSelection(state, valid) {
  const ids = new Set([...(state?.ids || [])].filter(valid));
  return { ids, anchorId: state?.anchorId && valid(state.anchorId) ? state.anchorId : null };
}
