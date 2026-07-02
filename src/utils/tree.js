// Pure helpers for the parent/child note outline. No DOM dependency, so they're
// unit-testable in Node. A note references its parent via `parentId` (null =
// top level). A note whose parent is missing from the given set (deleted /
// trashed) is promoted to a root so it never disappears.

/**
 * Build a forest of `{ note, children: [...] }` from flat notes.
 * @param {object[]} notes  the live notes to arrange
 * @param {{ sort?: (a,b)=>number }} [opts]  optional sibling comparator
 * @returns {{ note:object, children:object[] }[]}
 */
export function buildForest(notes, { sort } = {}) {
  const ids = new Set(notes.map((n) => n.id));
  const ROOT = '\0root';
  const childrenOf = new Map(); // parentId | ROOT -> notes[]
  for (const n of notes) {
    const pid = n.parentId && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : ROOT;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(n);
  }
  // Iterative build (no recursion → deep outlines can't overflow the stack; no
  // per-node Set copy → linear, not O(n²)). Each note has exactly one parent
  // bucket, so link children directly, then collect roots.
  const nodeById = new Map(notes.map((n) => [n.id, { note: n, children: [] }]));
  const orderNodes = (list) => (sort ? list.sort((a, b) => sort(a.note, b.note)) : list);
  for (const [pid, kids] of childrenOf) {
    if (pid === ROOT) continue;
    nodeById.get(pid).children = orderNodes(kids.map((n) => nodeById.get(n.id)));
  }
  const forest = orderNodes((childrenOf.get(ROOT) || []).map((n) => nodeById.get(n.id)));
  // Mark which notes are reachable from a root (iteratively). Anything stranded
  // in a cycle is promoted to a FLAT root (children dropped) so it never vanishes
  // and never re-introduces the cycle into the forest.
  const reachable = new Set();
  const stack = [...forest];
  while (stack.length) {
    const node = stack.pop();
    if (reachable.has(node.note.id)) continue;
    reachable.add(node.note.id);
    for (const c of node.children) stack.push(c);
  }
  for (const n of notes) if (!reachable.has(n.id)) forest.push({ note: n, children: [] });
  return forest;
}

/**
 * Flatten a forest into an ordered list of visible rows, honoring collapsed ids.
 * @returns {{ note:object, depth:number, hasChildren:boolean, collapsed:boolean }[]}
 */
export function flattenForest(forest, collapsed = new Set()) {
  const out = [];
  // Iterative pre-order walk (deep outlines can't overflow the stack). Push
  // siblings in reverse so they pop in document order.
  const stack = [];
  for (let i = forest.length - 1; i >= 0; i--) stack.push({ node: forest[i], depth: 0 });
  while (stack.length) {
    const { node, depth } = stack.pop();
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.note.id);
    out.push({ note: node.note, depth, hasChildren, collapsed: isCollapsed });
    if (hasChildren && !isCollapsed) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
    }
  }
  return out;
}

/**
 * Is `nodeId` inside the subtree rooted at `ancestorId`? Used to reject a
 * reparent that would create a cycle. Walks up the parent chain from `nodeId`.
 */
export function isDescendant(notes, ancestorId, nodeId) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  let cur = byId.get(nodeId);
  const seen = new Set();
  while (cur && cur.parentId != null && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** The ancestor chain of `id`, from top-most parent down to (not including) the note. */
export function ancestorChain(notes, id) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const chain = [];
  const seen = new Set([id]);
  let cur = byId.get(id);
  while (cur && cur.parentId != null && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
    chain.unshift(cur);
  }
  return chain;
}
