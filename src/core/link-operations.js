// Previewed, revision-protected link mutations. This service is loaded with
// Link tools on demand; the everyday editor only needs the lightweight title
// resolver and rebuildable knowledge index.

import { normalizeAliases } from './note.js';
import { normalizeTitle } from '../utils/helpers.js';
import { rewriteWikilinkTargets } from '../utils/wikilinks.js';
import { buildMentionReplacement } from '../utils/link-analysis.js';

export class LinkOperations {
  constructor(db) {
    this.db = db;
  }

  linkIntegrityReport() {
    const titles = new Map();
    const aliases = new Map();
    const push = (map, key, note) => map.set(key, [...(map.get(key) || []), note]);
    for (const note of this.db.getAllNotes()) {
      push(titles, normalizeTitle(note.title), note);
      for (const alias of note.aliases || []) push(aliases, normalizeTitle(alias), note);
    }
    const ambiguities = [];
    const add = (kind, name, entries) => {
      const notes = [...new Map(entries.map((note) => [note.id, note])).values()];
      ambiguities.push({
        kind,
        name,
        notes: notes.map((note) => ({
          id: note.id,
          title: note.title,
          canonical: normalizeTitle(note.title) === name,
          aliases: (note.aliases || []).filter((alias) => normalizeTitle(alias) === name),
        })),
      });
    };
    for (const [name, notes] of titles) {
      if (new Set(notes.map((note) => note.id)).size > 1) add('duplicate_title', name, notes);
    }
    for (const [name, notes] of aliases) {
      if (new Set(notes.map((note) => note.id)).size > 1) add('duplicate_alias', name, notes);
      const canonical = titles.get(name) || [];
      if (canonical.length && new Set([...canonical, ...notes].map((note) => note.id)).size > 1) {
        add('title_alias_collision', name, [...canonical, ...notes]);
      }
    }
    return { healthy: ambiguities.length === 0, ambiguities };
  }

  planRename(noteId, requestedTitle) {
    const note = this.db.getNote(noteId);
    if (!note) return { valid: false, code: 'missing_note', message: 'The note no longer exists.' };
    const oldResolution = this.db.resolveTitleResult(note.title);
    const repairsDuplicateTitle = oldResolution.status === 'ambiguous'
      && oldResolution.via === 'title'
      && oldResolution.candidates.some((candidate) => candidate.id === noteId);
    if (!repairsDuplicateTitle && (oldResolution.status !== 'resolved' || oldResolution.note?.id !== noteId)) {
      return {
        valid: false,
        code: 'ambiguous_source_title',
        message: 'This title is ambiguous in the imported vault. Resolve the link integrity report before renaming it.',
      };
    }
    const nextAliases = normalizeAliases([
      ...(note.aliases || []),
      ...(repairsDuplicateTitle ? [] : [note.title]),
    ], requestedTitle);
    const identity = this.db.validateLinkIdentity(noteId, requestedTitle, nextAliases);
    if (!identity.valid) return identity;
    if (identity.title === note.title) {
      return { valid: false, code: 'unchanged_title', message: 'The new title is unchanged.' };
    }

    const oldKey = normalizeTitle(note.title);
    const replacements = new Map();
    const affected = new Map();
    const changedAt = new Date().toISOString();
    let linkCount = 0;
    for (const source of this.db.getAllNotes()) {
      const rewritten = rewriteWikilinkTargets(
        source.content,
        (token) => !repairsDuplicateTitle
          && normalizeTitle(token.target) === oldKey
          && this.db.resolveTitleResult(token.target).note?.id === noteId,
        identity.title,
      );
      if (!rewritten.edits.length) continue;
      const json = source.toJSON();
      json.content = rewritten.content;
      json.updatedAt = changedAt;
      replacements.set(source.id, json);
      affected.set(source.id, { id: source.id, title: source.title, linkCount: rewritten.edits.length });
      linkCount += rewritten.edits.length;
    }
    const renamed = replacements.get(noteId) || note.toJSON();
    renamed.title = identity.title;
    renamed.aliases = identity.aliases;
    renamed.updatedAt = changedAt;
    replacements.set(noteId, renamed);
    if (!affected.has(noteId)) affected.set(noteId, { id: noteId, title: note.title, linkCount: 0 });

    const expected = [...affected.keys()].map((id) => this.db.notes.get(id).toJSON());
    return Object.freeze({
      valid: true,
      kind: 'rename',
      repairMode: repairsDuplicateTitle,
      noteId,
      oldTitle: note.title,
      newTitle: identity.title,
      aliases: Object.freeze([...identity.aliases]),
      linkCount,
      affected: Object.freeze([...affected.values()].map((entry) => Object.freeze(entry))),
      expected: Object.freeze(expected),
      replacements: Object.freeze([...replacements.values()]),
      fingerprint: JSON.stringify(expected),
    });
  }

  async applyRenamePlan(plan) {
    if (!plan?.valid || plan.kind !== 'rename') throw new TypeError('A valid rename preview is required.');
    const fresh = this.planRename(plan.noteId, plan.newTitle);
    if (!fresh.valid || fresh.fingerprint !== plan.fingerprint) {
      throw new Error('Notes changed after this rename preview. Review the updated plan before applying it.');
    }
    const captures = fresh.expected.map((raw) => this.db.notes.get(raw.id));
    await this.db.commitPlannedNotes(fresh.replacements, captures, 'pre_rename');
    return { note: this.db.getNote(plan.noteId), affectedNotes: fresh.affected.length, linkCount: fresh.linkCount };
  }

  planAliasRemoval(noteId, alias) {
    const note = this.db.getNote(noteId);
    if (!note) return { valid: false, code: 'missing_note', message: 'The note no longer exists.' };
    const key = normalizeTitle(alias);
    const stored = (note.aliases || []).find((value) => normalizeTitle(value) === key);
    if (!key || !stored) return { valid: false, code: 'missing_alias', message: 'That alias is no longer present on the note.' };
    const expected = note.toJSON();
    const next = {
      ...expected,
      aliases: note.aliases.filter((value) => normalizeTitle(value) !== key),
      updatedAt: new Date().toISOString(),
    };
    return Object.freeze({
      valid: true,
      kind: 'alias_repair',
      noteId,
      noteTitle: note.title,
      alias: stored,
      expected,
      next,
      fingerprint: JSON.stringify(expected),
    });
  }

  async applyAliasRemovalPlan(plan) {
    if (!plan?.valid || plan.kind !== 'alias_repair') throw new TypeError('A valid alias-removal preview is required.');
    const fresh = this.planAliasRemoval(plan.noteId, plan.alias);
    if (!fresh.valid || fresh.fingerprint !== plan.fingerprint) {
      throw new Error('The note changed after this alias preview. Review the repair again.');
    }
    await this.db.commitPlannedNotes([fresh.next], [this.db.getNote(fresh.noteId)], 'pre_alias_repair');
    return { note: this.db.getNote(fresh.noteId), alias: fresh.alias };
  }

  planMentionConversion(request) {
    const source = this.db.getNote(request?.sourceId);
    const target = this.db.getNote(request?.targetId);
    if (!source || !target) return { valid: false, code: 'missing_note', message: 'The source or target note no longer exists.' };
    const occurrence = this.db.unlinkedMentionsFor(target.id).find((entry) => (
      entry.sourceId === source.id
      && entry.start === request.start
      && entry.end === request.end
      && entry.text === request.text
    ));
    if (!occurrence || source.content.slice(occurrence.start, occurrence.end) !== occurrence.text) {
      return { valid: false, code: 'stale_mention', message: 'This mention changed. Refresh the note and review it again.' };
    }
    const replacement = buildMentionReplacement(occurrence);
    const expected = source.toJSON();
    const next = {
      ...expected,
      content: source.content.slice(0, occurrence.start) + replacement + source.content.slice(occurrence.end),
      updatedAt: new Date().toISOString(),
    };
    return Object.freeze({
      valid: true,
      kind: 'mention',
      sourceId: source.id,
      sourceTitle: source.title,
      targetId: target.id,
      targetTitle: target.title,
      start: occurrence.start,
      end: occurrence.end,
      text: occurrence.text,
      heading: occurrence.heading,
      snippet: occurrence.snippet,
      replacement,
      expected,
      next,
      fingerprint: JSON.stringify(expected),
    });
  }

  async applyMentionPlan(plan) {
    if (!plan?.valid || plan.kind !== 'mention') throw new TypeError('A valid mention preview is required.');
    const fresh = this.planMentionConversion(plan);
    if (!fresh.valid || fresh.fingerprint !== plan.fingerprint) {
      throw new Error('The source note changed after this preview. Review the mention again.');
    }
    await this.db.commitPlannedNotes([fresh.next], [this.db.getNote(fresh.sourceId)], 'pre_link_conversion');
    return { source: this.db.getNote(fresh.sourceId), target: this.db.getNote(fresh.targetId) };
  }
}
