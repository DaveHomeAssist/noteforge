import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { Note } from './note.js';
import { downloadText } from '../utils/download.js';
import { hashVaultSource, planVaultImport } from '../utils/vault-import.js';

const MUTABLE_STATUSES = new Set(['Add', 'Update', 'Conflict']);
const APPLYABLE_STATUSES = new Set(['Add', 'Update']);

function detached(value) {
  return structuredClone(value);
}

function itemSignature(item) {
  return JSON.stringify({
    key: item.key,
    relativePath: item.relativePath,
    externalId: item.externalId,
    destinationNoteId: item.destinationNoteId,
    proposedNoteId: item.proposedNoteId,
    status: item.status,
    sourceHash: item.sourceHash,
    destinationHash: item.destinationHash,
    reasons: item.reasons,
  });
}

function planSignature(plan) {
  return JSON.stringify({
    version: plan?.version,
    counts: plan?.counts,
    items: Array.isArray(plan?.items) ? plan.items.map(itemSignature) : null,
  });
}

function defineMapping(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function reportItem(item, decision, noteId = null) {
  return {
    key: item.key,
    relativePath: item.relativePath,
    title: item.title,
    status: item.status,
    decision,
    noteId: noteId || item.destinationNoteId || item.proposedNoteId || null,
    reasons: [...item.reasons],
  };
}

export class ReconciliationService {
  constructor({ db, recovery, now = () => new Date(), download = downloadText, planner = planVaultImport }) {
    if (!db || !recovery) throw new TypeError('Folder reconciliation requires database and recovery services.');
    this.db = db;
    this.recovery = recovery;
    this.now = now;
    this.download = download;
    this.planner = planner;
    this.entries = [];
    this.planResult = null;
    this.planVersion = 0;
  }

  async plan(entries) {
    const version = ++this.planVersion;
    const nextEntries = Array.isArray(entries) ? [...entries] : [];
    const result = await this.planner(nextEntries, [...this.db.notes.values()].map((note) => note.toJSON()), {
      mappings: this.db.config.folderMappings,
    });
    if (version !== this.planVersion) {
      const error = new Error('A newer folder scan replaced this plan.');
      error.code = 'reconciliation_scan_superseded';
      throw error;
    }
    this.entries = nextEntries;
    this.planResult = result;
    return detached(result);
  }

  async #reread() {
    const entries = [];
    for (const entry of this.entries) {
      const text = typeof entry.read === 'function' ? await entry.read() : entry.text;
      entries.push({ ...entry, text });
    }
    return entries;
  }

  #validateDecisions(plan, decisions) {
    const selected = [];
    for (const item of plan.items) {
      if (!MUTABLE_STATUSES.has(item.status)) continue;
      const decision = decisions?.[item.key];
      if (!['apply', 'skip'].includes(decision)) throw new Error(`Choose Apply or Skip for ${item.relativePath}.`);
      if (decision === 'apply' && !APPLYABLE_STATUSES.has(item.status)) throw new Error(`Resolve the conflict for ${item.relativePath} before applying it.`);
      if (decision === 'apply') selected.push(item);
    }
    return selected;
  }

  async apply({ plan, decisions, confirmed = false } = {}) {
    if (confirmed !== true || !plan?.items) throw new Error('Review the reconciliation plan and confirm it before applying changes.');
    if (!this.planResult || planSignature(plan) !== planSignature(this.planResult)) {
      throw new Error('This reconciliation plan is not the latest completed scan. Scan the folder again.');
    }
    const selected = this.#validateDecisions(plan, decisions);
    if (!selected.length) return this.#completionReport(plan, decisions, [], 'No folder changes were selected.');

    await this.recovery.downloadBackup();

    const freshEntries = await this.#reread();
    const freshPlan = await planVaultImport(freshEntries, [...this.db.notes.values()].map((note) => note.toJSON()), {
      mappings: this.db.config.folderMappings,
    });
    const freshByKey = new Map(freshPlan.items.map((item) => [item.key, item]));
    for (const item of selected) {
      const fresh = freshByKey.get(item.key);
      if (!fresh || itemSignature(fresh) !== itemSignature(item)) {
        throw new Error(`${item.relativePath} or its destination changed after preview. Scan the folder again.`);
      }
    }

    const captures = selected
      .filter((item) => item.status === 'Update')
      .map((item) => this.db.notes.get(item.destinationNoteId)?.toJSON())
      .filter(Boolean);
    if (captures.length && !await this.db.captureRevisionBoundary(captures, 'pre_reconcile')) {
      throw new Error('Browser-local revision history is unavailable, so folder changes were not applied.');
    }

    const appliedAt = this.now().toISOString();
    const sourceByKey = new Map(freshPlan.items.map((item) => [item.key, item]));
    const replacementById = new Map();
    const added = [];
    for (const selectedItem of selected) {
      const item = sourceByKey.get(selectedItem.key);
      if (item.status === 'Add') {
        const created = new Note({
          id: item.proposedNoteId,
          title: item.title,
          content: item.source,
          createdAt: appliedAt,
          updatedAt: appliedAt,
        });
        replacementById.set(created.id, created.toJSON());
        added.push(created.id);
      } else {
        const current = this.db.notes.get(item.destinationNoteId);
        if (!current || current.isTrashed) throw new Error(`${item.relativePath} no longer has the reviewed destination.`);
        const replacement = Note.fromJSON(current.toJSON());
        replacement.update({ content: item.source });
        replacement.updatedAt = appliedAt;
        replacementById.set(replacement.id, replacement.toJSON());
      }
    }

    const currentNotes = [...this.db.notes.values()].map((note) => note.toJSON());
    const nextNotes = currentNotes.map((note) => replacementById.get(note.id) || note);
    for (const id of added) nextNotes.push(replacementById.get(id));
    const nextMappings = detached(this.db.config.folderMappings && typeof this.db.config.folderMappings === 'object'
      ? this.db.config.folderMappings
      : {});
    for (const item of freshPlan.items) {
      const decision = decisions?.[item.key];
      if (decision !== 'apply' && item.status !== 'Unchanged') continue;
      const noteId = item.destinationNoteId || item.proposedNoteId;
      if (!noteId) continue;
      const destination = replacementById.get(noteId) || this.db.notes.get(noteId)?.toJSON();
      const destinationHash = destination ? await hashVaultSource(destination.content) : item.destinationHash;
      defineMapping(nextMappings, noteId, {
        noteId,
        relativePath: item.relativePath,
        title: destination?.title || item.title,
        externalId: item.externalId || null,
        sourceHash: item.sourceHash,
        destinationHash,
        reconciledAt: appliedAt,
      });
    }
    const nextConfig = { ...detached(this.db.config), folderMappings: nextMappings };
    const saved = await this.db.replaceVault({ notes: nextNotes, config: nextConfig, schemaVersion: CURRENT_SCHEMA_VERSION });
    if (!saved) throw new Error('The folder batch was not saved; the current vault remains unchanged.');
    return this.#completionReport(freshPlan, decisions, [...replacementById.keys()], 'Folder reconciliation completed without deleting notes.');
  }

  #completionReport(plan, decisions, appliedIds, message) {
    const applied = new Set(appliedIds);
    const items = plan.items.map((item) => reportItem(
      item,
      item.status === 'Unchanged' ? 'unchanged' : decisions?.[item.key] || 'skip',
      applied.has(item.destinationNoteId || item.proposedNoteId) ? item.destinationNoteId || item.proposedNoteId : null,
    ));
    const count = (status, decision = null) => items.filter((item) => item.status === status && (!decision || item.decision === decision)).length;
    return {
      version: 1,
      completedAt: this.now().toISOString(),
      message,
      summary: {
        added: count('Add', 'apply'),
        updated: count('Update', 'apply'),
        unchanged: count('Unchanged'),
        skipped: items.filter((item) => item.decision === 'skip').length,
        conflicted: count('Conflict'),
        failed: 0,
        deleted: 0,
      },
      items,
    };
  }

  downloadReport(report) {
    const date = this.now().toISOString().slice(0, 10);
    this.download(`${JSON.stringify(report, null, 2)}\n`, `noteforge-folder-reconciliation-${date}.json`, 'application/json');
  }
}
