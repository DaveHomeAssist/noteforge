// Lightweight link-graph view. A tiny force-directed layout (no dependency)
// positions notes; edges are resolved [[wikilinks]]. Click a node to open it.

import { escapeHtml } from '../utils/helpers.js';
import { downloadText } from '../utils/download.js';

const WIDTH = 900;
const HEIGHT = 640;
const ITERATIONS = 260;
const NODE_BUDGET = 300; // beyond this, render only the most-connected nodes (keeps layout responsive)

// Concrete colors for the standalone SVG export (the live graph styles use CSS vars
// that won't resolve outside the app, so the exported file inlines fixed values).
const EXPORT_CSS =
  '.graph__edge{stroke:#c8ccd6;stroke-width:1.2}' +
  '.graph__node{fill:#3b6ef6;stroke:#ffffff;stroke-width:2}' +
  '.graph__node--on{fill:#dc2626}' +
  '.graph__label{fill:#5b6472;font-size:11px;text-anchor:middle;' +
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}';

export class GraphView {
  /**
   * @param {HTMLElement} container
   * @param {import('../core/database.js').Database} db
   * @param {(id:string)=>void} onOpen
   */
  constructor(container, db, onOpen) {
    this.container = container;
    this.db = db;
    this.onOpen = onOpen;
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.graph__export')) { this.#exportSvg(); return; }
      const node = e.target.closest('[data-id]');
      if (node) this.onOpen(node.dataset.id);
    });
    // Keyboard: nodes are focusable; Enter/Space opens the focused note.
    this.container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const node = e.target.closest('[data-id]');
      if (node) { e.preventDefault(); this.onOpen(node.dataset.id); }
    });
  }

  render(activeId = null) {
    let { nodes, edges } = this.db.graph();
    if (nodes.length === 0) {
      this.container.innerHTML = `<div class="graph__empty muted">
        No notes to graph yet. Link notes with <code>[[Note title]]</code> to grow the web.</div>`;
      return;
    }

    // Large vaults: keep only the most-connected nodes so the O(n²) layout and SVG
    // stay responsive. Note which subset is shown.
    const totalNotes = nodes.length;
    let notice = '';
    if (nodes.length > NODE_BUDGET) {
      const deg = new Map(nodes.map((n) => [n.id, 0]));
      for (const e of edges) { deg.set(e.source, deg.get(e.source) + 1); deg.set(e.target, deg.get(e.target) + 1); }
      const sorted = [...nodes].sort((a, b) => deg.get(b.id) - deg.get(a.id)).map((n) => n.id);
      // If the open note falls outside the top-N, reserve a slot for it so the total
      // (and the notice below) stay exactly at the budget rather than N+1.
      const reserve = activeId && deg.has(activeId) && sorted.indexOf(activeId) >= NODE_BUDGET ? 1 : 0;
      const kept = new Set(sorted.slice(0, NODE_BUDGET - reserve));
      if (reserve) kept.add(activeId); // never hide the currently-open note
      nodes = nodes.filter((n) => kept.has(n.id));
      edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
      notice = ` · showing ${nodes.length} most-connected of ${totalNotes}`;
    }

    const degree = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) {
      degree.set(e.source, degree.get(e.source) + 1);
      degree.set(e.target, degree.get(e.target) + 1);
    }

    // Reuse the previous force layout when the graph structure (nodes + edges) is
    // unchanged — re-opening the graph or switching the active note only changes the
    // highlight, which the SVG below applies per render. Skips the O(n²) relayout.
    const sig = nodes.map((n) => n.id).join('|') + '::' + edges.map((e) => e.source + '>' + e.target).join('|');
    let pos;
    if (sig === this._layoutSig && this._layoutPos) {
      pos = this._layoutPos;
    } else {
      pos = this.#layout(nodes, edges);
      this._layoutSig = sig;
      this._layoutPos = pos;
    }

    const edgeSvg = edges
      .map((e) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        return `<line class="graph__edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
      })
      .join('');

    const nodeSvg = nodes
      .map((n) => {
        const p = pos.get(n.id);
        const r = 6 + Math.min(degree.get(n.id), 8) * 2.2;
        const cls = n.id === activeId ? 'graph__node graph__node--on' : 'graph__node';
        return `
          <g class="graph__node-g" data-id="${escapeHtml(n.id)}" tabindex="0" role="button" aria-label="Open note: ${escapeHtml(n.title || 'Untitled')}" transform="translate(${p.x},${p.y})">
            <circle class="${cls}" r="${r}" />
            <text class="graph__label" x="0" y="${r + 13}">${escapeHtml(this.#short(n.title))}</text>
          </g>`;
      })
      .join('');

    this.container.innerHTML = `
      <div class="graph__toolbar">
        <span class="graph__stat">${nodes.length} notes · ${edges.length} links${notice}</span>
        <button class="graph__export" type="button" title="Download this graph as an SVG image">⬇ SVG</button>
      </div>
      <svg class="graph__svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet">
        <g class="graph__edges">${edgeSvg}</g>
        <g class="graph__nodes">${nodeSvg}</g>
      </svg>`;
  }

  /** Serialize the currently-rendered graph as a standalone, styled SVG document
   *  (returns null when there's no graph — e.g. an empty vault). */
  buildSvgExport() {
    const svg = this.container.querySelector('svg.graph__svg');
    if (!svg) return null;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', SVGNS);
    clone.removeAttribute('class');
    const style = document.createElementNS(SVGNS, 'style');
    style.textContent = EXPORT_CSS;
    const bg = document.createElementNS(SVGNS, 'rect'); // solid backdrop so it stands alone
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(WIDTH));
    bg.setAttribute('height', String(HEIGHT));
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);
    clone.insertBefore(style, clone.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  #exportSvg() {
    const doc = this.buildSvgExport();
    if (doc) downloadText(doc, 'noteforge-graph.svg', 'image/svg+xml');
  }

  #short(title) {
    const t = String(title ?? 'Untitled'); // tolerate a null/missing title (imported/legacy data)
    return t.length > 22 ? t.slice(0, 21) + '…' : t;
  }

  /**
   * Deterministic-ish force layout: seed on a circle, then apply repulsion +
   * spring attraction + centering for a fixed number of iterations.
   */
  #layout(nodes, edges) {
    this._layoutComputes = (this._layoutComputes || 0) + 1; // for perf tests / diagnostics
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    const pos = new Map();
    const n = nodes.length;

    nodes.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2;
      const radius = Math.min(WIDTH, HEIGHT) * 0.32;
      pos.set(node.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    });

    if (n === 1) return pos;

    const k = Math.sqrt((WIDTH * HEIGHT) / n); // ideal edge length
    const idList = nodes.map((node) => node.id);

    // Fewer iterations as the graph grows (layout cost is ~O(n² · iters)).
    const iterations = Math.max(40, Math.min(ITERATIONS, Math.round(60000 / n)));
    for (let iter = 0; iter < iterations; iter++) {
      const cooling = 1 - iter / iterations;

      // Repulsion between every pair.
      for (let i = 0; i < n; i++) {
        const a = pos.get(idList[i]);
        for (let j = i + 1; j < n; j++) {
          const b = pos.get(idList[j]);
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          const force = (k * k) / dist;
          dx /= dist;
          dy /= dist;
          a.vx += dx * force;
          a.vy += dy * force;
          b.vx -= dx * force;
          b.vy -= dy * force;
        }
      }

      // Spring attraction along edges.
      for (const e of edges) {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (dist * dist) / k;
        dx /= dist;
        dy /= dist;
        a.vx -= dx * force;
        a.vy -= dy * force;
        b.vx += dx * force;
        b.vy += dy * force;
      }

      // Integrate with cooling + gentle pull to center; clamp to viewport.
      const maxStep = 12 * cooling + 1;
      for (const id of idList) {
        const p = pos.get(id);
        p.vx += (cx - p.x) * 0.006;
        p.vy += (cy - p.y) * 0.006;
        const speed = Math.hypot(p.vx, p.vy) || 0.01;
        const step = Math.min(speed, maxStep);
        p.x += (p.vx / speed) * step;
        p.y += (p.vy / speed) * step;
        p.vx *= 0.85;
        p.vy *= 0.85;
        p.x = Math.max(40, Math.min(WIDTH - 40, p.x));
        p.y = Math.max(30, Math.min(HEIGHT - 30, p.y));
      }
    }
    return pos;
  }
}
