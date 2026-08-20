import { Note } from './note.js';
import { normalizeTitle } from '../utils/helpers.js';
import { isDescendant } from '../utils/tree.js';
import { replaceLiteral } from '../utils/find-replace.js';

function fingerprint(notes) {
  return JSON.stringify(notes.map((note) => note.toJSON()));
}

function storedNotes(db) {
  return [...db.notes.values()];
}

export class BulkOperations {
  constructor(db) {
    this.db = db;
  }

  planVaultReplace({ query, replacement = '', caseSensitive = false, wholeWord = false, includeArchived = false, includeTrash = false }) {
    if (!String(query ?? '')) return { valid: false, code: 'blank_query', message: 'Enter text to find.' };
    const options = { caseSensitive: Boolean(caseSensitive), wholeWord: Boolean(wholeWord) };
    const changed = [];
    const unchanged = [];
    const skipped = [];
    const replacements = [];
    const expected = [];
    const changedAt = new Date().toISOString();
    for (const note of storedNotes(this.db)) {
      if (note.isTrashed && !includeTrash) { skipped.push({ id: note.id, title: note.title, reason: 'trash' }); continue; }
      if (note.isArchived && !note.isTrashed && !includeArchived) { skipped.push({ id: note.id, title: note.title, reason: 'archive' }); continue; }
      const result = replaceLiteral(note.content, query, replacement, options);
      if (!result.changed) { unchanged.push({ id: note.id, title: note.title }); continue; }
      const next = note.toJSON();
      next.content = result.result;
      next.updatedAt = changedAt;
      expected.push(note);
      replacements.push(next);
      changed.push({ id: note.id, title: note.title, count: result.count });
    }
    return Object.freeze({
      valid: true,
      kind: 'vault_replace',
      query: String(query),
      replacement: String(replacement ?? ''),
      options: Object.freeze(options),
      includeArchived: Boolean(includeArchived),
      includeTrash: Boolean(includeTrash),
      changed: Object.freeze(changed),
      unchanged: Object.freeze(unchanged),
      skipped: Object.freeze(skipped),
      failed: Object.freeze([]),
      replacements: Object.freeze(replacements),
      expected: Object.freeze(expected.map((note) => note.toJSON())),
      fingerprint: fingerprint(expected),
      vaultFingerprint: fingerprint(storedNotes(this.db)),
    });
  }

  async applyVaultReplace(plan) {
    if (!plan?.valid || plan.kind !== 'vault_replace') throw new TypeError('A valid vault replacement preview is required.');
    const current = plan.expected.map((raw) => this.db.notes.get(raw.id)).filter(Boolean);
    if (fingerprint(storedNotes(this.db)) !== plan.vaultFingerprint
      || current.length !== plan.expected.length || fingerprint(current) !== plan.fingerprint) {
      throw new Error('Notes changed after this preview. Review the updated replacement plan before applying it.');
    }
    if (!plan.replacements.length) return { changed: [], unchanged: plan.unchanged, skipped: plan.skipped, failed: [] };
    try {
      await this.db.commitPlannedNotes(plan.replacements, current, 'pre_bulk_replace');
      return { changed: plan.changed, unchanged: plan.unchanged, skipped: plan.skipped, failed: [] };
    } catch (error) {
      error.report = { changed: [], unchanged: plan.unchanged, skipped: plan.skipped, failed: plan.changed };
      throw error;
    }
  }

  planNoteBatch(ids, action, payload = {}) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))];
    if (!uniqueIds.length) return { valid: false, code: 'empty_selection', message: 'Select at least one note.' };
    const selected = uniqueIds.map((id) => this.db.notes.get(id));
    if (selected.some((note) => !note || note.isTrashed)) return { valid: false, code: 'invalid_selection', message: 'The selection contains a missing or trashed note.' };
    const changedAt = new Date().toISOString();
    const replacements = [];
    const unchanged = [];

    if (action === 'unarchive') {
      const futureKeys = new Set();
      for (const note of selected.filter((candidate) => candidate.isArchived)) {
        const identity = this.db.validateNewLinkIdentity(note.title, note.aliases);
        if (!identity.valid) return { ...identity, valid: false };
        for (const value of [note.title, ...(note.aliases || [])]) {
          const key = normalizeTitle(value);
          if (futureKeys.has(key)) return { valid: false, code: 'identity_collision', message: 'Selected archived notes contain conflicting titles or aliases.' };
          futureKeys.add(key);
        }
      }
    }

    if (action === 'reparent') {
      const parentId = payload.parentId || null;
      if (parentId && (!this.db.getNote(parentId) || uniqueIds.includes(parentId))) {
        return { valid: false, code: 'invalid_parent', message: 'Choose a live parent outside the selection.' };
      }
      const live = storedNotes(this.db).filter((note) => !note.isTrashed);
      if (parentId && selected.some((note) => isDescendant(live, note.id, parentId))) {
        return { valid: false, code: 'parent_cycle', message: 'That move would create a parent cycle.' };
      }
    }

    const tag = typeof payload.tag === 'string' ? payload.tag.replace(/^#/, '').trim().slice(0, 80) : '';
    if (action === 'tag' && !tag) return { valid: false, code: 'blank_tag', message: 'Enter a tag to add.' };
    if (!['tag', 'archive', 'unarchive', 'reparent', 'trash'].includes(action)) {
      return { valid: false, code: 'unknown_action', message: 'That batch action is not supported.' };
    }

    for (const source of selected) {
      const note = Note.fromJSON(source.toJSON());
      if (action === 'tag') {
        if (note.tags.includes(tag)) { unchanged.push({ id: note.id, title: note.title }); continue; }
        note.addTag(tag);
      }
      else if (action === 'archive') {
        if (note.isArchived) { unchanged.push({ id: note.id, title: note.title }); continue; }
        note.archivedAt = changedAt;
        note.updatedAt = changedAt;
      } else if (action === 'unarchive') {
        if (!note.isArchived) { unchanged.push({ id: note.id, title: note.title }); continue; }
        note.archivedAt = null;
        note.updatedAt = changedAt;
      } else if (action === 'reparent') {
        const parentId = payload.parentId || null;
        if (note.parentId === parentId) { unchanged.push({ id: note.id, title: note.title }); continue; }
        note.parentId = parentId;
      } else if (action === 'trash') {
        note.deletedAt = changedAt;
      }
      replacements.push(note.toJSON());
    }
    const expected = selected.map((note) => note.toJSON());
    return Object.freeze({
      valid: true,
      kind: 'note_batch',
      action,
      payload: Object.freeze({ ...payload, tag }),
      selected: Object.freeze(uniqueIds),
      changed: Object.freeze(replacements.map((note) => ({ id: note.id, title: note.title }))),
      unchanged: Object.freeze(unchanged),
      failed: Object.freeze([]),
      replacements: Object.freeze(replacements),
      expected: Object.freeze(expected),
      fingerprint: JSON.stringify(expected),
      vaultFingerprint: fingerprint(storedNotes(this.db)),
    });
  }

  async applyNoteBatch(plan) {
    if (!plan?.valid || plan.kind !== 'note_batch') throw new TypeError('A valid note-batch preview is required.');
    const current = plan.expected.map((raw) => this.db.notes.get(raw.id)).filter(Boolean);
    if (fingerprint(storedNotes(this.db)) !== plan.vaultFingerprint
      || current.length !== plan.expected.length || fingerprint(current) !== plan.fingerprint) {
      throw new Error('Notes changed after this batch preview. Review the action again.');
    }
    if (!plan.replacements.length) return { changed: [], unchanged: plan.unchanged, failed: [] };
    try {
      const changedIds = new Set(plan.replacements.map((note) => note.id));
      await this.db.commitPlannedNotes(plan.replacements, current.filter((note) => changedIds.has(note.id)), 'pre_bulk_action');
      return { changed: plan.changed, unchanged: plan.unchanged, failed: [] };
    } catch (error) {
      error.report = { changed: [], unchanged: plan.unchanged, failed: plan.changed };
      throw error;
    }
  }
}
