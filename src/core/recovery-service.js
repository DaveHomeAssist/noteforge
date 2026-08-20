import { downloadText } from '../utils/download.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { Note } from './note.js';

// Portable backup parsing and hashing is loaded only when Backup center opens;
// everyday editing keeps that code out of the initial application shell.
const loadBackupCore = () => import('./backup.js');

function fileDate(now) {
  return now.toISOString().slice(0, 10);
}

function detached(value) {
  return structuredClone(value);
}

export class RecoveryService {
  constructor({ db, revisionStore, storage, now = () => new Date(), download = downloadText }) {
    if (!db || !revisionStore || !storage) throw new TypeError('RecoveryService requires database, revision store, and storage.');
    this.db = db;
    this.revisions = revisionStore;
    this.storage = storage;
    this.now = now;
    this.download = download;
    const handlers = {
      onNotesPersisted: (captures) => this.capturePersisted(captures),
      onNotesPurged: (noteIds) => this.revisions.deleteNoteHistories(noteIds),
    };
    const connected = typeof this.db.connectHistoryHandlers === 'function'
      ? this.db.connectHistoryHandlers(handlers)
      : Promise.resolve(Object.assign(this.db, handlers));
    this.ready = connected.then(async () => {
      const status = await this.revisions.getStatus();
      if (status.available && typeof this.revisions.reconcileVaultNoteIds === 'function') {
        await this.revisions.reconcileVaultNoteIds([...this.db.notes.keys()]);
      }
      return this;
    });
  }

  vaultState() {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      notes: [...this.db.notes.values()].map((note) => note.toJSON()),
      config: detached(this.db.config),
    };
  }

  async capturePersisted(captures) {
    const results = [];
    for (const capture of captures) {
      results.push(await this.revisions.capture(capture.note, { reason: capture.reason }));
    }
    return results;
  }

  async getStatus() {
    return this.revisions.getStatus();
  }

  async listRevisions(noteId) {
    return this.revisions.listRevisions(noteId);
  }

  async previewRevision({ noteId, revisionId }) {
    const current = this.db.notes.get(noteId);
    if (!current) throw new Error('The current note no longer exists.');
    const revision = await this.revisions.materialize(revisionId);
    if (revision.noteId !== noteId) throw new Error('The selected revision belongs to another note.');
    return {
      revision,
      snapshot: { ...detached(revision.metadata), content: revision.content },
      currentNote: current.toJSON(),
    };
  }

  async restore({ noteId, revisionId }) {
    const current = this.db.notes.get(noteId);
    if (!current) throw new Error('The note to restore no longer exists.');
    const prepared = await this.revisions.prepareRestore(current, revisionId, { restoredAt: this.now() });
    const restored = Note.fromJSON(prepared.payload);
    this.db.saveNote(restored, { captureRevision: false });
    if (!await this.db.flushCurrentWrites()) throw new Error('The safety revision was kept, but the restored note could not be saved.');
    return { note: restored, safetyRevision: prepared.safetyCapture.revision };
  }

  async restoreAsCopy({ noteId, revisionId }) {
    const revision = await this.revisions.materialize(revisionId);
    if (revision.noteId !== noteId) throw new Error('The selected revision belongs to another note.');
    const payload = await this.revisions.buildRestoreCopyPayload(revision, {
      createdAt: this.now(),
      existingTitles: this.db.getAllNotes().map((note) => note.title),
    });
    const copy = Note.fromJSON(payload);
    this.db.saveNote(copy, { captureRevision: false });
    if (!await this.db.flushCurrentWrites()) throw new Error('The restored copy could not be saved.');
    return { note: copy };
  }

  async getStorageHealth() {
    const [backend, history] = await Promise.all([
      this.storage.getStatus?.() ?? this.storage.status?.() ?? {},
      this.revisions.getStatus(),
    ]);
    const persistence = this.db.getPersistenceStatus();
    const pendingWrites = Number.isInteger(persistence.pendingWrites) ? persistence.pendingWrites : 0;
    const pendingHistory = Number.isInteger(persistence.pendingHistory) ? persistence.pendingHistory : 0;
    const pendingWriteError = pendingWrites > 0
      ? `${pendingWrites} current-note write${pendingWrites === 1 ? ' is' : 's are'} still pending. Changes are not yet durably saved.`
      : null;
    return {
      ...backend,
      ...history,
      quota: backend.quota ?? history.quota ?? null,
      historyAvailable: history.available,
      lastPersistedAt: persistence.lastPersistedAt,
      lastRevisionAt: history.lastRevisionAt ?? persistence.lastRevisionAt,
      lastLocalSnapshotAt: history.lastLocalSnapshotAt,
      lastPortableBackupAt: this.db.config.lastPortableBackupAt ?? null,
      pendingWrites,
      pendingHistory,
      degraded: Boolean(backend.degraded || history.degraded || pendingWriteError),
      error: pendingWriteError || history.lastError || backend.lastError || null,
    };
  }

  async ensureRollingSnapshots() {
    const state = this.vaultState();
    const daily = await this.revisions.createSnapshot(state, { kind: 'daily', createdAt: this.now() });
    const weekly = await this.revisions.createSnapshot(state, { kind: 'weekly', createdAt: this.now() });
    return { daily, weekly };
  }

  async createLocalSnapshot() {
    return this.revisions.createSnapshot(this.vaultState(), { kind: 'daily', createdAt: this.now() });
  }

  async listLocalSnapshots() {
    return this.revisions.listSnapshots();
  }

  async createBackup() {
    const { createBackup, serializeBackup, verifyBackup } = await loadBackupCore();
    const envelope = await createBackup(this.vaultState(), { createdAt: this.now().toISOString() });
    await verifyBackup(envelope);
    return {
      envelope,
      text: serializeBackup(envelope),
      filename: `noteforge-backup-${fileDate(this.now())}.json`,
      summary: {
        noteCount: envelope.manifest.noteCount,
        trashCount: envelope.manifest.trashedNoteIds.length,
        schemaVersion: envelope.schemaVersion,
      },
    };
  }

  async downloadBackup() {
    const result = await this.createBackup();
    this.download(result.text, result.filename, 'application/json');
    const timestamp = this.now().toISOString();
    this.db.setConfig({ lastPortableBackupAt: timestamp });
    await this.db.flushCurrentWrites();
    return { ...result, message: 'Portable JSON backup verified and downloaded.' };
  }

  async verifyBackup(source) {
    const { verifyBackup } = await loadBackupCore();
    const text = typeof source === 'string' ? source : await source.text();
    const envelope = await verifyBackup(text);
    return {
      valid: true,
      text,
      envelope,
      summary: {
        noteCount: envelope.manifest.noteCount,
        trashCount: envelope.manifest.trashedNoteIds.length,
        schemaVersion: envelope.schemaVersion,
      },
    };
  }

  async previewRestore(source) {
    const { createRestorePreview } = await loadBackupCore();
    const verified = source?.verified;
    if (!verified?.envelope) throw new Error('Verify the portable backup before previewing it.');
    return createRestorePreview(this.vaultState(), verified.envelope);
  }

  async previewLocalSnapshot({ snapshotId }) {
    const { createBackup, createRestorePreview } = await loadBackupCore();
    const snapshot = await this.revisions.materializeSnapshot(snapshotId);
    const snapshotState = {
      schemaVersion: snapshot.vaultSchemaVersion ?? CURRENT_SCHEMA_VERSION,
      notes: snapshot.notes,
      config: snapshot.config ?? {},
    };
    const envelope = await createBackup(snapshotState, { createdAt: snapshot.createdAt });
    const plan = await createRestorePreview(this.vaultState(), envelope);
    return { ...plan, verified: { valid: true, local: true } };
  }

  async restoreBackup({ confirmed, plan, type, file, verified, snapshotId }) {
    if (confirmed !== true || !plan?.restoreState) throw new Error('A verified restore preview and explicit confirmation are required.');
    // Never trust a mutable preview object at the commit boundary. Re-read and
    // verify the chosen source, then build a fresh plan against current memory.
    let freshPlan;
    if (type === 'portable') {
      const freshVerification = await this.verifyBackup(file ?? verified?.text);
      freshPlan = await this.previewRestore({ verified: freshVerification });
    } else if (type === 'local') {
      freshPlan = await this.previewLocalSnapshot({ snapshotId });
    } else {
      throw new Error('The recovery source is missing or unsupported.');
    }
    // A portable safety artifact is generated immediately before replacement.
    // This is independent of browser-local history and survives site-data loss.
    const safety = await this.createBackup();
    this.download(safety.text, `noteforge-pre-restore-${fileDate(this.now())}.json`, 'application/json');
    const restored = await this.db.replaceVault(freshPlan.restoreState);
    if (!restored) throw new Error('The current vault was left in memory because the restore batch could not be saved.');
    return { restored: true, summary: freshPlan.summary };
  }
}
