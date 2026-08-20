// Rebuildable contextual-link index. It is not authoritative data and loads
// after the first usable note so a large vault never delays the app shell.

import { parseWikilinks } from '../utils/wikilinks.js';
import { createMentionScanner, occurrenceContext } from '../utils/link-analysis.js';

export class KnowledgeIndex {
  constructor(db) {
    this.db = db;
    this.backlinks = new Map();
    this.mentions = new Map();
    this.sourceBacklinks = new Map();
    this.sourceMentions = new Map();
    this.rebuild();
  }

  #removeSource(sourceId) {
    for (const occurrence of this.sourceBacklinks.get(sourceId) || []) {
      const next = (this.backlinks.get(occurrence.targetId) || []).filter((entry) => entry.sourceId !== sourceId);
      if (next.length) this.backlinks.set(occurrence.targetId, next);
      else this.backlinks.delete(occurrence.targetId);
    }
    for (const occurrence of this.sourceMentions.get(sourceId) || []) {
      const next = (this.mentions.get(occurrence.targetId) || []).filter((entry) => entry.sourceId !== sourceId);
      if (next.length) this.mentions.set(occurrence.targetId, next);
      else this.mentions.delete(occurrence.targetId);
    }
    this.sourceBacklinks.delete(sourceId);
    this.sourceMentions.delete(sourceId);
  }

  #indexSource(note, candidates = this.db.linkCandidates(), scanner = null) {
    if (!note || note.isTrashed) return;
    const links = [];
    for (const token of parseWikilinks(note.content)) {
      const resolved = this.db.resolveTitleResult(token.target);
      if (resolved.status !== 'resolved' || resolved.note.id === note.id) continue;
      const occurrence = Object.freeze({
        sourceId: note.id,
        sourceTitle: note.title,
        targetId: resolved.note.id,
        targetTitle: resolved.note.title,
        via: resolved.via,
        start: token.start,
        end: token.end,
        target: token.target,
        display: token.display,
        fragment: token.fragment,
        embedded: token.embedded,
        ...occurrenceContext(note.content, token.start, token.end),
      });
      links.push(occurrence);
      const targetEntries = this.backlinks.get(occurrence.targetId) || [];
      targetEntries.push(occurrence);
      this.backlinks.set(occurrence.targetId, targetEntries);
    }
    this.sourceBacklinks.set(note.id, links);

    const mentions = (scanner || createMentionScanner(candidates))(note.content, { sourceId: note.id })
      .map((mention) => Object.freeze({ ...mention, sourceId: note.id, sourceTitle: note.title }));
    this.sourceMentions.set(note.id, mentions);
    for (const occurrence of mentions) {
      const targetEntries = this.mentions.get(occurrence.targetId) || [];
      targetEntries.push(occurrence);
      this.mentions.set(occurrence.targetId, targetEntries);
    }
  }

  rebuild() {
    this.backlinks.clear();
    this.mentions.clear();
    this.sourceBacklinks.clear();
    this.sourceMentions.clear();
    const candidates = this.db.linkCandidates();
    const scanner = createMentionScanner(candidates);
    for (const note of this.db.getAllNotes()) this.#indexSource(note, candidates, scanner);
  }

  refreshSource(note) {
    this.#removeSource(note.id);
    this.#indexSource(note);
  }

  backlinkOccurrencesFor(id) {
    return [...(this.backlinks.get(id) || [])];
  }

  unlinkedMentionsFor(id) {
    return [...(this.mentions.get(id) || [])];
  }

  graphEdges() {
    const edges = [];
    for (const note of this.db.getAllNotes()) {
      const targets = new Set((this.sourceBacklinks.get(note.id) || []).map((entry) => entry.targetId));
      for (const targetId of targets) if (targetId !== note.id) edges.push({ source: note.id, target: targetId });
    }
    return edges;
  }
}
