import { normalizeAliases } from '../core/note.js';
import { createBlockEditorPhase5Enhancer } from '../components/block-editor-phase5.js';
import { setTransclusionRenderer } from '../utils/markdown.js';
import { createTransclusionRenderer } from '../utils/transclusion.js';
import {
  FRONTMATTER_MIGRATION_VERSION,
  FrontmatterError,
  aliasesFromProperties,
  parseFrontmatter,
  propertySearchIndex,
  removeFrontmatterProperty,
  setFrontmatterProperty,
  splitFrontmatterSource,
} from '../utils/frontmatter.js';

const signatureOf = (note) => `${note.content}\u0000${JSON.stringify(note.aliases || [])}`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class Phase5Controller {
  constructor({ db, editor, ensureRecovery, announce = () => {}, refreshSearch = () => {} }) {
    this.db = db;
    this.editor = editor;
    this.ensureRecovery = ensureRecovery;
    this.announce = announce;
    this.refreshSearch = refreshSearch;
    this.signatures = new Map();
    this.repairReport = [];
    this.properties = null;
    this.propertiesReady = null;
    this.reconcileReady = null;
    this.refreshTimer = null;
    this.pendingNoteIds = new Set();
    this.pendingReset = false;
    this.unsubscribe = db.subscribe((_database, noteIds) => this.#scheduleDerivedRefresh(noteIds));
    setTransclusionRenderer(createTransclusionRenderer());
    editor?.enablePhase5?.(createBlockEditorPhase5Enhancer());
    this.ready = this.reconcileAliases();
  }

  async #ensureProperties() {
    if (this.properties) return this.properties;
    if (this.propertiesReady) return this.propertiesReady;
    this.propertiesReady = import('../components/properties-view.js').then(({ PropertiesView, createPropertiesElements }) => {
      this.properties = new PropertiesView(createPropertiesElements(), {
        read: (id) => this.read(id),
        set: (id, key, value, type) => this.set(id, key, value, type),
        remove: (id, key) => this.remove(id, key),
        replaceRaw: (id, raw) => this.replaceRaw(id, raw),
      });
      return this.properties;
    }).catch((error) => { this.propertiesReady = null; throw error; });
    return this.propertiesReady;
  }

  async showProperties(noteId) {
    await this.ready;
    return (await this.#ensureProperties()).show(noteId);
  }

  async read(noteId) {
    const note = this.db.notes.get(noteId);
    if (!note) throw new FrontmatterError('missing_note', 'The note no longer exists.');
    return parseFrontmatter(note.content);
  }

  async set(noteId, key, value, type) {
    const note = this.db.getNote(noteId);
    if (!note) throw new FrontmatterError('missing_note', 'The note is not available for editing.');
    const nextContent = await setFrontmatterProperty(note.content, key, value, { type });
    const parsed = await parseFrontmatter(nextContent);
    const aliases = key === 'aliases'
      ? normalizeAliases(aliasesFromProperties(parsed.properties).aliases, note.title)
      : note.aliases;
    await this.#commit(note, nextContent, aliases, 'pre_property_edit');
  }

  async remove(noteId, key) {
    const note = this.db.getNote(noteId);
    if (!note) throw new FrontmatterError('missing_note', 'The note is not available for editing.');
    const nextContent = await removeFrontmatterProperty(note.content, key);
    await this.#commit(note, nextContent, key === 'aliases' ? [] : note.aliases, 'pre_property_edit');
  }

  async replaceRaw(noteId, rawSource) {
    const note = this.db.getNote(noteId);
    if (!note) throw new FrontmatterError('missing_note', 'The note is not available for editing.');
    const current = splitFrontmatterSource(note.content);
    const raw = String(rawSource ?? '');
    let nextContent;
    if (!raw.trim()) {
      nextContent = current.body;
    } else {
      const separator = current.separator || current.newline || '\n';
      nextContent = `${raw}${separator}${current.body}`;
      if (!splitFrontmatterSource(nextContent).hasFrontmatter) {
        throw new FrontmatterError('invalid_boundary', 'Raw frontmatter must begin and end with an exact --- or ... delimiter line.');
      }
    }
    const parsed = await parseFrontmatter(nextContent);
    const aliasProperty = parsed.status === 'valid' ? aliasesFromProperties(parsed.properties) : null;
    const aliases = aliasProperty?.valid && aliasProperty.present
      ? normalizeAliases(aliasProperty.aliases, note.title)
      : note.aliases;
    await this.#commit(note, nextContent, aliases, 'pre_frontmatter_source_edit');
  }

  async #commit(note, content, aliases, reason) {
    if (content === note.content && same(aliases, note.aliases)) return false;
    this.editor?.flushPending?.();
    await this.db.flush();
    const fresh = this.db.getNote(note.id);
    if (!fresh || fresh.content !== note.content || !same(fresh.aliases, note.aliases)) {
      throw new FrontmatterError('stale_note', 'The note changed while properties were open. Review the latest source and try again.');
    }
    await this.ensureRecovery();
    const before = fresh.toJSON();
    const replacement = { ...before, content, aliases };
    await this.db.commitPlannedNotes([replacement], [before], reason);
    const updated = this.db.getNote(note.id);
    if (updated) await this.#indexNote(updated);
    if (this.editor?.currentId === note.id) {
      this.editor.open(note.id, { discardPending: true });
      // Property persistence rebuilds the editor while its modal remains open;
      // restore focus to the replacement trigger, not the detached old button.
      this.properties?.modal.setReturnFocus(this.editor.container?.querySelector('.editor__properties'));
    }
    this.refreshSearch();
    return true;
  }

  #queueDerivedRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.reconcileReady) {
        void this.reconcileReady.then(
          () => this.#queueDerivedRefresh(),
          () => this.#queueDerivedRefresh(),
        );
        return;
      }
      const reset = this.pendingReset;
      const noteIds = reset ? null : [...this.pendingNoteIds];
      this.pendingReset = false;
      this.pendingNoteIds.clear();
      if (!reset && noteIds.length === 0) return;
      void this.reconcileAliases({ changedOnly: !reset, noteIds }).catch((error) => {
        console.warn('[properties] derived index refresh unavailable:', error);
      });
    }, 0);
  }

  #scheduleDerivedRefresh(noteIds) {
    if (Array.isArray(noteIds)) {
      if (noteIds.length === 0) return;
      noteIds.forEach((id) => this.pendingNoteIds.add(id));
    } else {
      this.pendingReset = true;
      this.pendingNoteIds.clear();
    }
    this.#queueDerivedRefresh();
  }

  async #indexNote(note, parsed = null) {
    const result = parsed || await parseFrontmatter(note.content);
    Object.defineProperty(note, '_propertySearchIndex', {
      value: result.status === 'valid' ? propertySearchIndex(result.properties) : new Map(),
      writable: true,
      configurable: true,
      enumerable: false,
    });
    this.signatures.set(note.id, signatureOf(note));
    return result;
  }

  reconcileAliases({ changedOnly = false, noteIds = null } = {}) {
    if (this.reconcileReady) return this.reconcileReady;
    this.reconcileReady = this.#reconcileAliases(changedOnly, noteIds).finally(() => { this.reconcileReady = null; });
    return this.reconcileReady;
  }

  async #reconcileAliases(changedOnly, noteIds) {
    const allNotes = this.db.getNotesInScope('all');
    const liveIds = new Set(allNotes.map((note) => note.id));
    const requested = Array.isArray(noteIds) ? new Set(noteIds) : null;
    const notes = requested ? allNotes.filter((note) => requested.has(note.id)) : allNotes;
    if (requested) for (const id of requested) if (!liveIds.has(id)) this.signatures.delete(id);
    const blockedById = new Map((changedOnly ? this.repairReport : [])
      .filter((entry) => liveIds.has(entry.id))
      .map((entry) => [entry.id, entry]));
    const replacements = [];
    const captures = [];
    for (const note of notes) {
      if (changedOnly && this.signatures.get(note.id) === signatureOf(note)) continue;
      blockedById.delete(note.id);
      const before = note.toJSON();
      const parsed = await this.#indexNote(note);
      if (parsed.status === 'invalid') {
        if (note.aliases.length) blockedById.set(note.id, { id: note.id, title: note.title, message: parsed.diagnostics[0]?.message || 'Invalid YAML' });
        continue;
      }
      const property = aliasesFromProperties(parsed.properties);
      if (!property.valid) {
        blockedById.set(note.id, { id: note.id, title: note.title, message: 'aliases must be a YAML list of text values.' });
        continue;
      }
      const canonical = normalizeAliases([...(property.aliases || []), ...(note.aliases || [])], note.title);
      let content = note.content;
      if (canonical.length && (!property.present || !same(property.aliases, canonical))) {
        content = await setFrontmatterProperty(note.content, 'aliases', canonical);
      }
      if (content !== note.content || !same(canonical, note.aliases)) {
        replacements.push({ ...before, content, aliases: canonical });
        captures.push(before);
      }
    }

    if (replacements.length) {
      this.editor?.flushPending?.();
      await this.db.flush();
      const current = replacements.filter((replacement) => {
        const before = captures.find((entry) => entry.id === replacement.id);
        const fresh = this.db.notes.get(replacement.id);
        return fresh && fresh.content === before.content && same(fresh.aliases, before.aliases);
      });
      if (current.length) {
        await this.ensureRecovery();
        await this.db.commitPlannedNotes(current, captures.filter((capture) => current.some((entry) => entry.id === capture.id)), 'pre_frontmatter_alias_migration');
      }
    }

    const blocked = [...blockedById.values()];
    this.repairReport = blocked;
    const previousMarker = this.db.config.frontmatterAliasMigration;
    const markerStatus = blocked.length ? 'repair_required' : 'complete';
    if (previousMarker?.version !== FRONTMATTER_MIGRATION_VERSION || previousMarker?.status !== markerStatus || !same(previousMarker?.blocked || [], blocked)) {
      this.db.setConfig({
        frontmatterAliasMigration: {
          version: FRONTMATTER_MIGRATION_VERSION,
          status: markerStatus,
          completedAt: previousMarker?.completedAt || new Date().toISOString(),
          blocked,
        },
      });
    }
    const indexIds = requested || new Set(allNotes.map((note) => note.id));
    for (const id of indexIds) {
      const note = this.db.notes.get(id);
      if (note) await this.#indexNote(note);
    }
    this.refreshSearch();
    if (blocked.length) this.announce(`${blocked.length} note${blocked.length === 1 ? '' : 's'} need YAML repair before aliases can move to frontmatter.`);
    return { migrated: replacements.length, blocked };
  }
}
