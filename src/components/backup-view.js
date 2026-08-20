// Storage health and portable-backup recovery UI. Backup serialization,
// verification, and restore writes stay in an injected service; this component
// coordinates the accessible workflow and deliberately fails closed when a
// destructive restore has no explicit confirmation handler.

import { downloadText } from '../utils/download.js';
import { escapeHtml } from '../utils/helpers.js';
import { Modal } from './modal.js';
import './recovery.css';

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Create the lazy Backup center dialog only when the feature is first opened. */
export function createBackupElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'backup-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel recovery-modal backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="backup-title">🛟 Backup center</h2><p class="muted recovery-modal__subtitle">Storage health, local recovery, and portable backups</p></div><button class="btn btn--ghost" data-close title="Close" aria-label="Close backup center">✕</button></header>
      <div class="backup-view"><div id="backup-health"></div>
        <section class="backup-actions" aria-labelledby="portable-backup-title"><h3 id="portable-backup-title">Portable JSON backup</h3><p>Download a verified, device-independent copy containing live notes, Trash, settings, IDs, and integrity data.</p><button id="backup-download" class="btn btn--primary">Download JSON backup</button></section>
        <section class="backup-actions" aria-labelledby="verify-backup-title"><h3 id="verify-backup-title">Verify or restore a backup</h3><label class="backup-file-label" for="backup-file">Choose a NoteForge JSON backup</label><input id="backup-file" type="file" accept="application/json,.json"><div class="backup-actions__buttons"><button id="backup-verify" class="btn btn--ghost" disabled>Verify backup</button><button id="backup-preview-restore" class="btn btn--ghost" disabled>Restore preview</button><button id="backup-restore" class="btn btn--danger-ghost" disabled>Restore verified backup</button></div><div id="backup-preview" class="backup-view__preview"><p class="muted">Choose a JSON backup to begin.</p></div></section>
        <section class="backup-actions" aria-labelledby="local-snapshot-title"><div class="backup-actions__heading"><div><h3 id="local-snapshot-title">Local snapshots</h3><p>Rolling browser-local recovery aids. These can be lost with site data.</p></div><button id="backup-create-snapshot" class="btn btn--ghost">Create today's snapshot</button></div><div id="backup-snapshots"></div></section>
      </div><footer class="recovery-modal__footer"><span id="backup-status" class="recovery-modal__status" role="status" aria-live="polite"></span></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    health: overlay.querySelector('#backup-health'),
    snapshots: overlay.querySelector('#backup-snapshots'),
    status: overlay.querySelector('#backup-status'),
    download: overlay.querySelector('#backup-download'),
    createSnapshot: overlay.querySelector('#backup-create-snapshot'),
    file: overlay.querySelector('#backup-file'),
    verify: overlay.querySelector('#backup-verify'),
    preview: overlay.querySelector('#backup-preview'),
    previewRestore: overlay.querySelector('#backup-preview-restore'),
    restore: overlay.querySelector('#backup-restore'),
  };
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function backendLabel(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'indexeddb' || key === 'idb') return 'IndexedDB';
  if (key === 'localstorage' || key === 'local-storage' || key === 'fallback') return 'localStorage fallback';
  return value ? String(value) : 'Unknown';
}

function countLabel(value, singular, plural = `${singular}s`) {
  const count = Number(value);
  if (!Number.isFinite(count)) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function backupSummary(result) {
  const source = result?.summary || result?.manifest || result || {};
  const parts = [
    countLabel(source.noteCount ?? source.notes, 'note'),
    countLabel(source.trashCount ?? source.trashed, 'trashed note'),
    countLabel(source.configCount, 'configuration record'),
  ].filter(Boolean);
  const schemaVersion = source.schemaVersion ?? result?.schemaVersion;
  if (schemaVersion != null) parts.push(`schema ${schemaVersion}`);
  return parts.length ? parts.join(' · ') : 'Integrity checks passed.';
}

function restoreSummary(plan) {
  const source = plan?.summary || plan || {};
  const parts = [
    countLabel(source.liveCount ?? source.liveNoteCount ?? source.notes ?? source.noteCount, 'live note'),
    countLabel(source.trashCount ?? source.trashedNoteCount ?? source.trashed, 'trashed note'),
    countLabel(source.created ?? source.addCount, 'new note'),
    countLabel(source.updated ?? source.updateCount, 'updated note'),
    countLabel(source.removed ?? source.removeCount, 'note to remove', 'notes to remove'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'The verified backup is ready for review.';
}

function restoreChangeDetails(plan, limit = 20) {
  const categories = [
    ['Added', plan?.notes?.added],
    ['Updated', plan?.notes?.updated],
    ['Removed by restore', plan?.notes?.removed],
    ['Unchanged', plan?.notes?.unchanged],
  ].filter(([, notes]) => Array.isArray(notes));
  if (categories.length === 0) return '';
  return `<div class="backup-restore-preview__changes">${categories.map(([label, notes]) => {
    const visible = notes.slice(0, limit);
    return `<section><h4>${escapeHtml(label)} (${notes.length})</h4>${visible.length
      ? `<ul>${visible.map((note) => `<li><span>${escapeHtml(note.title || 'Untitled')}</span> <code>${escapeHtml(note.id)}</code>${note.state === 'archived' ? ' <span class="muted">Archive</span>' : note.state === 'trashed' ? ' <span class="muted">Trash</span>' : ''}${note.fields?.length ? ` <span class="muted">${escapeHtml(note.fields.join(', '))}</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="muted">None</p>'}${notes.length > visible.length ? `<p class="muted">${notes.length - visible.length} more not shown.</p>` : ''}</section>`;
  }).join('')}</div>`;
}

function asTextBackup(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.json === 'string') return result.json;
  if (result?.backup != null) return JSON.stringify(result.backup, null, 2);
  if (result?.envelope != null) return JSON.stringify(result.envelope, null, 2);
  return null;
}

export class BackupView {
  /**
   * @param {{
   *   overlay:HTMLElement,
   *   health:HTMLElement,
   *   snapshots?:HTMLElement,
   *   status?:HTMLElement,
   *   download?:HTMLButtonElement,
   *   createSnapshot?:HTMLButtonElement,
   *   file?:HTMLInputElement,
   *   verify?:HTMLButtonElement,
   *   preview?:HTMLElement,
   *   previewRestore?:HTMLButtonElement,
   *   restore?:HTMLButtonElement
   * }} els
   * @param {{
   *   getStorageHealth:()=>Promise<object>|object,
   *   listLocalSnapshots?:()=>Promise<object[]>|object[],
   *   createLocalSnapshot?:()=>Promise<object>|object,
   *   createBackup?:()=>Promise<object|string>|object|string,
   *   downloadBackup?:()=>Promise<object>|object,
   *   verifyBackup?:(source:File|string|object)=>Promise<object>|object,
   *   previewRestore?:(request:object)=>Promise<object>|object,
   *   previewLocalSnapshot?:(request:{snapshotId:string})=>Promise<object>|object,
   *   restoreBackup:(request:object)=>Promise<object>|object
   * }} service
   * @param {{
   *   confirmRestore?:(details:object)=>Promise<boolean>|boolean,
   *   onRestored?:(result:object)=>void
   * }} [options]
   */
  constructor(els, service, options = {}) {
    if (!els?.overlay || !els?.health) {
      throw new TypeError('BackupView requires overlay and health elements.');
    }
    if (!service || typeof service.getStorageHealth !== 'function') {
      throw new TypeError('BackupView requires a backup service.');
    }

    this.els = els;
    this.service = service;
    this.confirmRestore = options.confirmRestore;
    this.onRestored = options.onRestored;
    this.verified = null;
    this.restorePlan = null;
    this.restoreSource = null;
    this.busy = false;
    this.loadToken = 0;
    this.snapshotAvailable = typeof service.createLocalSnapshot === 'function';

    this.modal = new Modal(els.overlay, { initialFocus: () => this.#initialFocus() });
    this.els.download?.addEventListener('click', () => this.#download());
    this.els.createSnapshot?.addEventListener('click', () => this.#createSnapshot());
    this.els.file?.addEventListener('change', () => this.#fileChanged());
    this.els.verify?.addEventListener('click', () => this.#verify());
    this.els.previewRestore?.addEventListener('click', () => this.#previewRestore());
    this.els.restore?.addEventListener('click', () => this.#restore());
    this.els.snapshots?.addEventListener('click', (event) => this.#onSnapshotClick(event));

    this.els.status?.setAttribute('role', 'status');
    this.els.status?.setAttribute('aria-live', 'polite');
    this.els.status?.setAttribute('aria-atomic', 'true');
    this.els.file?.setAttribute('accept', 'application/json,.json');
    this.#syncActions();
  }

  get open() {
    return this.modal.isOpen;
  }

  async show() {
    this.#renderLoading();
    this.modal.open();
    await this.refresh();
  }

  close() {
    this.loadToken += 1;
    this.modal.close();
  }

  async toggle() {
    if (this.modal.isOpen) this.close();
    else await this.show();
  }

  async refresh() {
    const token = ++this.loadToken;
    try {
      const health = await this.service.getStorageHealth();
      const localSnapshotsAvailable = health?.localSnapshotsAvailable
        ?? health?.historyAvailable
        ?? health?.available
        ?? true;
      let snapshots = [];
      let snapshotError = null;
      if (localSnapshotsAvailable && typeof this.service.listLocalSnapshots === 'function') {
        try {
          snapshots = await this.service.listLocalSnapshots();
        } catch (error) {
          snapshotError = error;
        }
      }
      if (token !== this.loadToken) return;
      this.#renderHealth(health || {});
      this.#renderSnapshots(Array.isArray(snapshots) ? snapshots : [], {
        available: Boolean(localSnapshotsAvailable),
        error: snapshotError,
      });
      this.#setStatus(snapshotError
        ? 'Storage health loaded, but local snapshots could not be read.'
        : 'Storage and backup status updated.', Boolean(snapshotError));
    } catch (error) {
      if (token !== this.loadToken) return;
      this.els.health.innerHTML = `<div class="backup-view__notice backup-view__notice--error" role="alert"><strong>Storage health could not be loaded.</strong><p>${escapeHtml(error?.message || 'Unknown storage error.')}</p></div>`;
      if (this.els.snapshots) this.els.snapshots.innerHTML = '';
      this.#setStatus(error?.message || 'Storage health could not be loaded.', true);
    }
  }

  #initialFocus() {
    return this.els.download
      || this.els.file
      || this.els.overlay.querySelector('[data-close]')
      || this.modal?.panel;
  }

  #renderLoading() {
    this.els.health.innerHTML = '<p class="muted backup-view__loading">Loading storage health…</p>';
    if (this.els.snapshots) this.els.snapshots.innerHTML = '<p class="muted backup-view__loading">Loading local snapshots…</p>';
    this.#setStatus('Loading storage and backup status…');
  }

  #renderHealth(health) {
    const usage = health.usage ?? health.quota?.usage;
    const quota = health.quotaBytes ?? health.quota?.quota;
    const quotaText = Number.isFinite(Number(usage)) && Number.isFinite(Number(quota))
      ? `${formatBytes(usage)} of ${formatBytes(quota)} used${Number(quota) > 0 ? ` (${Math.round((Number(usage) / Number(quota)) * 100)}%)` : ''}`
      : 'Unavailable in this browser';
    const available = health.historyAvailable !== false && health.available !== false;
    const degraded = health.error
      || health.lastError
      || health.message
      || (!available
        ? 'Revision history and local snapshots are unavailable in fallback storage.'
        : health.degraded
          ? 'Browser-local recovery is degraded. Current-note persistence remains the priority.'
          : '');

    this.els.health.innerHTML = `<section class="backup-health" aria-labelledby="backup-health-title">
      <h3 id="backup-health-title" class="backup-health__title">Storage health</h3>
      <dl class="backup-health__grid">
        <div><dt>Backend</dt><dd>${escapeHtml(backendLabel(health.backend))}</dd></div>
        <div><dt>Storage quota</dt><dd>${escapeHtml(quotaText)}</dd></div>
        <div><dt>Last note persistence</dt><dd>${escapeHtml(formatDateTime(health.lastPersistenceAt ?? health.lastPersistedAt))}</dd></div>
        <div><dt>Pending note writes</dt><dd>${escapeHtml(String(Number.isInteger(health.pendingWrites) ? health.pendingWrites : 0))}</dd></div>
        <div><dt>Pending history tasks</dt><dd>${escapeHtml(String(Number.isInteger(health.pendingHistory) ? health.pendingHistory : 0))}</dd></div>
        <div><dt>Last revision capture</dt><dd>${escapeHtml(formatDateTime(health.lastRevisionAt))}</dd></div>
        <div><dt>Last local snapshot</dt><dd>${escapeHtml(formatDateTime(health.lastLocalSnapshotAt))}</dd></div>
        <div><dt>Last verified downloaded backup</dt><dd>${escapeHtml(formatDateTime(health.lastPortableBackupAt ?? health.lastBackupAt))}</dd></div>
      </dl>
      ${degraded ? `<div class="backup-health__warning" role="note"><strong>Recovery is degraded.</strong><p>${escapeHtml(degraded)}</p></div>` : ''}
      <div class="backup-health__language" role="note">
        <p><strong>Revision history and local snapshots</strong> are browser-local recovery aids. Clearing or losing site data can remove them.</p>
        <p><strong>Downloaded JSON backups</strong> are portable and can be stored independently of this browser.</p>
      </div>
    </section>`;

    this.snapshotAvailable = available && typeof this.service.createLocalSnapshot === 'function';
    if (this.els.createSnapshot) this.els.createSnapshot.disabled = !this.snapshotAvailable || this.busy;
  }

  #renderSnapshots(snapshots, { available = true, error = null } = {}) {
    if (!this.els.snapshots) return;
    if (!available) {
      this.els.snapshots.innerHTML = '<div class="backup-view__notice" role="note"><strong>Local snapshots unavailable.</strong><p>This storage mode can persist current notes only. Download a JSON backup for portable recovery.</p></div>';
      return;
    }
    if (error) {
      this.els.snapshots.innerHTML = `<div class="backup-view__notice backup-view__notice--error" role="alert"><strong>Local snapshots could not be loaded.</strong><p>${escapeHtml(error?.message || 'Unknown snapshot error.')}</p></div>`;
      return;
    }
    if (snapshots.length === 0) {
      this.els.snapshots.innerHTML = '<p class="muted backup-snapshots__empty">No local snapshots are available.</p>';
      return;
    }

    const sorted = snapshots.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    this.els.snapshots.innerHTML = `<section class="backup-snapshots" aria-labelledby="backup-snapshots-title">
      <h3 id="backup-snapshots-title" class="backup-snapshots__title">Local snapshots</h3>
      <ul class="backup-snapshots__list">${sorted.map((snapshot) => {
        const summary = [
          countLabel(snapshot.noteCount ?? snapshot.notes, 'note'),
          snapshot.size != null ? formatBytes(snapshot.size) : null,
          snapshot.kind ? String(snapshot.kind) : null,
        ].filter(Boolean).join(' · ');
        const canPreview = typeof this.service.previewLocalSnapshot === 'function';
        return `<li class="backup-snapshot">
          <div class="backup-snapshot__body">
            <time datetime="${escapeHtml(snapshot.createdAt || '')}">${escapeHtml(formatDateTime(snapshot.createdAt))}</time>
            ${summary ? `<span class="muted">${escapeHtml(summary)}</span>` : ''}
          </div>
          ${canPreview ? `<button type="button" class="btn btn--ghost" data-snapshot-id="${escapeHtml(snapshot.id)}">Restore preview</button>` : ''}
        </li>`;
      }).join('')}</ul>
      <p class="muted backup-snapshots__footnote">Local snapshots may be evicted with browser site data.</p>
    </section>`;
  }

  #fileChanged() {
    this.verified = null;
    this.restorePlan = null;
    this.restoreSource = null;
    if (this.els.preview) {
      this.els.preview.innerHTML = this.els.file?.files?.[0]
        ? '<p class="muted">Backup selected. Verify its integrity before previewing a restore.</p>'
        : '<p class="muted">Choose a JSON backup to begin.</p>';
    }
    this.#syncActions();
  }

  async #download() {
    if (this.busy) return;
    await this.#runAction('Creating and verifying portable backup…', async () => {
      let result;
      if (typeof this.service.downloadBackup === 'function') {
        result = await this.service.downloadBackup();
      } else if (typeof this.service.createBackup === 'function') {
        result = await this.service.createBackup();
        const text = asTextBackup(result);
        if (text == null) throw new Error('The backup service did not return downloadable JSON.');
        if (typeof this.service.verifyBackup === 'function') {
          const verification = await this.service.verifyBackup(text);
          if (verification?.valid === false) throw new Error(verification.message || 'The created backup failed integrity verification.');
        }
        downloadText(text, result?.filename || `noteforge-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      } else {
        throw new Error('Portable backup creation is unavailable.');
      }
      await this.refresh();
      this.#setStatus(result?.message || 'Portable JSON backup verified and downloaded. Store it somewhere independent of this browser.');
    });
  }

  async #createSnapshot() {
    if (this.busy || typeof this.service.createLocalSnapshot !== 'function') return;
    await this.#runAction('Creating local snapshot…', async () => {
      const result = await this.service.createLocalSnapshot();
      await this.refresh();
      this.#setStatus(result?.created === false
        ? "Today's local snapshot already exists. It remains browser-local and is not a portable backup."
        : 'Local snapshot created. It remains browser-local and is not a portable backup.');
    });
  }

  async #verify() {
    const file = this.els.file?.files?.[0];
    if (!file || this.busy) {
      if (!file) this.#setStatus('Choose a JSON backup before verification.', true);
      return;
    }
    if (typeof this.service.verifyBackup !== 'function') {
      this.#setStatus('Backup verification is unavailable.', true);
      return;
    }

    await this.#runAction('Verifying backup integrity…', async () => {
      const result = await this.service.verifyBackup(file);
      if (!result || result.valid === false) throw new Error(result?.message || 'Backup integrity verification failed.');
      this.verified = result;
      this.restorePlan = null;
      this.restoreSource = { type: 'portable', file, verified: result };
      if (this.els.preview) {
        this.els.preview.innerHTML = `<div class="backup-verify backup-verify--ok" role="note">
          <strong>Backup integrity verified.</strong>
          <p>${escapeHtml(backupSummary(result))}</p>
          <p>Review the restore preview before replacing any vault data.</p>
        </div>`;
      }
      this.#setStatus('Backup integrity verified. Restore preview is now available.');
    });
  }

  async #previewRestore() {
    if (!this.restoreSource || this.busy) return;
    if (typeof this.service.previewRestore !== 'function') {
      this.#setStatus('Restore preview is unavailable.', true);
      return;
    }
    await this.#runAction('Building restore preview…', async () => {
      const plan = await this.service.previewRestore(this.restoreSource);
      if (!plan || plan.valid === false) throw new Error(plan?.message || 'The restore preview could not be built.');
      this.#showRestorePlan(plan, 'portable backup');
    });
  }

  async #onSnapshotClick(event) {
    const button = event.target.closest('button[data-snapshot-id]');
    if (!button || this.busy || typeof this.service.previewLocalSnapshot !== 'function') return;
    await this.#runAction('Building local snapshot preview…', async () => {
      const snapshotId = button.dataset.snapshotId;
      const plan = await this.service.previewLocalSnapshot({ snapshotId });
      if (!plan || plan.valid === false) throw new Error(plan?.message || 'The local snapshot could not be previewed.');
      this.restoreSource = { type: 'local', snapshotId };
      this.verified = plan.verified || { valid: true };
      this.#showRestorePlan(plan, 'local snapshot');
    });
  }

  #showRestorePlan(plan, label) {
    this.restorePlan = plan;
    const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
    if (this.els.preview) {
      this.els.preview.innerHTML = `<section class="backup-restore-preview" aria-labelledby="backup-restore-preview-title" tabindex="-1">
        <h3 id="backup-restore-preview-title">Restore preview</h3>
        <p>${escapeHtml(restoreSummary(plan))}</p>
        ${restoreChangeDetails(plan)}
        ${warnings.length ? `<div class="backup-restore-preview__warnings" role="note"><strong>Review before restoring:</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}
        <p><strong>No data has been changed.</strong> Restoring will replace the current vault only after a separate confirmation.</p>
      </section>`;
      this.els.preview.querySelector('.backup-restore-preview')?.focus();
    }
    this.#setStatus(`Restore preview ready for the ${label}. No data has been changed.`);
  }

  async #restore() {
    if (!this.restorePlan || !this.restoreSource || this.busy) return;
    if (typeof this.confirmRestore !== 'function') {
      this.#setStatus('Restore is blocked because explicit confirmation is unavailable.', true);
      return;
    }
    const details = {
      source: this.restoreSource,
      plan: this.restorePlan,
      message: 'Replace the current vault with this verified recovery source? NoteForge will prepare a separate safety backup download before applying the replacement.',
    };
    this.busy = true;
    this.#syncActions();
    let approved;
    try {
      approved = await this.confirmRestore(details);
    } catch (error) {
      this.busy = false;
      this.#syncActions();
      this.#setStatus(error?.message || 'Restore confirmation failed.', true);
      return;
    }
    if (!approved) {
      this.busy = false;
      this.#syncActions();
      this.#setStatus('Restore cancelled. No data was changed.');
      return;
    }

    await this.#runAction('Restoring verified backup…', async () => {
      const result = await this.service.restoreBackup({
        ...this.restoreSource,
        plan: this.restorePlan,
        confirmed: true,
      });
      this.onRestored?.(result);
      this.verified = null;
      this.restorePlan = null;
      this.restoreSource = null;
      if (this.els.file) this.els.file.value = '';
      await this.refresh();
      this.#setStatus('Restore completed successfully.');
    });
  }

  async #runAction(message, action) {
    this.busy = true;
    this.#syncActions();
    this.#setStatus(message);
    try {
      await action();
    } catch (error) {
      this.#setStatus(error?.message || 'The backup action failed.', true);
      if (this.els.preview && /verify|backup|restore/i.test(error?.message || '')) {
        this.els.preview.innerHTML = `<div class="backup-view__notice backup-view__notice--error" role="alert"><strong>The backup action failed.</strong><p>${escapeHtml(error?.message || 'Unknown error.')}</p></div>`;
      }
    } finally {
      this.busy = false;
      this.#syncActions();
    }
  }

  #syncActions() {
    const hasFile = !!this.els.file?.files?.[0];
    if (this.els.download) this.els.download.disabled = this.busy;
    if (this.els.createSnapshot) this.els.createSnapshot.disabled = this.busy || !this.snapshotAvailable;
    if (this.els.verify) this.els.verify.disabled = this.busy || !hasFile;
    if (this.els.previewRestore) this.els.previewRestore.disabled = this.busy || !this.restoreSource || this.restoreSource.type !== 'portable' || !this.verified;
    if (this.els.restore) this.els.restore.disabled = this.busy || !this.restorePlan;
  }

  #setStatus(message, alert = false) {
    if (!this.els.status) return;
    this.els.status.textContent = message;
    this.els.status.setAttribute('role', alert ? 'alert' : 'status');
  }
}
