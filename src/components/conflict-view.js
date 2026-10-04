import { Modal } from './modal.js';
import { downloadText } from '../utils/download.js';
import './conflict-view.css';

export async function openConflictRecovery(app, ensureSafety) {
  app.conflictView ||= new ConflictView({
    db: app.db,
    flush: () => app.editor?.flushPending(),
    ensureSafety,
    onResolved: ({ noteIds }) => {
      if (app.workspace) app.workspace.syncAuthoritative(noteIds);
      else app.editor?.syncAuthoritative(noteIds);
      if (!app.db.conflicts.size && !app.db.getPersistenceStatus().pendingWrites) app._storageErrorBar?.remove();
    },
  });
  await app.conflictView.open();
}

export class ConflictView {
  constructor({ db, flush, ensureSafety, onResolved }) {
    Object.assign(this, { db, flush, ensureSafety, onResolved });
    this.request = 0;
    this.busy = false;
    this.overlay = document.createElement('div');
    this.overlay.id = 'conflict-dialog';
    this.overlay.className = 'modal';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `<div class="modal__backdrop"></div>
      <section class="modal__panel conflict-view" role="dialog" aria-modal="true" aria-labelledby="conflict-title" tabindex="-1">
        <header><h2 id="conflict-title">Recover unsaved changes</h2><button type="button" data-dismiss>Close</button></header>
        <div class="conflict-view__body">
          <p>Choices apply only if the draft and saved vault still match this review.</p>
          <label for="conflict-choice">Conflict</label><select id="conflict-choice"></select>
          <p data-explanation></p>
          <div class="conflict-view__comparison">
            <label>Saved version<textarea readonly data-current spellcheck="false"></textarea></label>
            <label>Your draft<textarea readonly data-draft spellcheck="false"></textarea></label>
          </div>
          <details><summary>Metadata and complete change</summary><pre data-metadata></pre></details>
        </div>
        <footer>
          <p role="status" aria-live="polite" data-status></p>
          <div class="conflict-view__actions">
            <button type="button" data-refresh>Refresh comparison</button>
            <button type="button" data-export>Export recovery file</button>
            <button type="button" data-action="keep-current">Keep saved version</button>
            <button type="button" data-action="save-copy">Save draft as a copy</button>
            <button type="button" data-action="use-draft">Replace saved version with draft</button>
          </div>
        </footer>
      </section>`;
    document.body.append(this.overlay);
    this.modal = new Modal(this.overlay, { onEscape: () => this.close(), initialFocus: '[data-dismiss]' });
    this.choice = this.overlay.querySelector('select');
    this.status = this.overlay.querySelector('[data-status]');
    this.choice.addEventListener('change', () => void this.select());
    this.overlay.querySelector('[data-dismiss]').addEventListener('click', () => this.close());
    this.overlay.querySelector('[data-refresh]').addEventListener('click', () => void this.refresh());
    this.overlay.querySelector('[data-export]').addEventListener('click', () => this.export());
    this.overlay.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => void this.resolve(button.dataset.action));
    });
  }

  close() {
    if (this.busy) return;
    this.request++;
    this.preview = null;
    this.modal.close();
  }

  async open() {
    if (this.modal.isOpen) return;
    this.modal.open();
    await this.refresh();
  }

  buttons() {
    for (const button of this.overlay.querySelectorAll('[data-action]')) {
      const allowed =
        this.preview &&
        (button.dataset.action === 'keep-current' ||
          (button.dataset.action === 'save-copy' && this.preview.canCopy) ||
          (button.dataset.action === 'use-draft' && this.preview.canUseDraft));
      button.disabled = this.busy || !allowed;
    }
    this.choice.disabled = this.busy || !this.choice.options.length;
    this.overlay.querySelector('[data-dismiss]').disabled = this.busy;
    this.overlay.querySelector('[data-refresh]').disabled = this.busy;
  }

  async refresh() {
    if (this.busy) return;
    const request = ++this.request;
    const selected = this.choice.value;
    this.preview = null;
    this.clearComparison();
    this.buttons();
    this.status.textContent = 'Loading saved conflicts…';
    try {
      this.flush();
      await this.db.flushCurrentWrites();
      const snapshot = await this.db.storage.readCurrentVault();
      if (!this.modal.isOpen || request !== this.request) return;
      this.choice.replaceChildren();
      for (const conflict of snapshot?.conflicts ?? []) {
        const option = document.createElement('option');
        option.value = conflict.id;
        option.textContent = conflict.mutation.notes?.[0]?.value?.title || 'Settings or planned change';
        this.choice.append(option);
      }
      if ([...this.choice.options].some((option) => option.value === selected)) this.choice.value = selected;
      if (this.choice.options.length) await this.select();
      else {
        this.status.textContent =
          'No stored conflicts remain. Export a recovery file to preserve any unsaved local drafts.';
        this.clearComparison();
      }
    } catch (error) {
      if (!this.modal.isOpen || request !== this.request) return;
      this.status.textContent = `Saved conflicts could not be read: ${error.message}. You can still export local drafts.`;
    }
    this.buttons();
  }

  clearComparison() {
    for (const textarea of this.overlay.querySelectorAll('textarea')) textarea.value = '';
    this.overlay.querySelector('[data-metadata]').textContent = '';
    this.overlay.querySelector('[data-explanation]').textContent = '';
  }

  async select() {
    const request = ++this.request;
    this.preview = null;
    this.clearComparison();
    this.buttons();
    try {
      this.flush();
      const preview = await this.db.previewConflict(this.choice.value);
      if (!this.modal.isOpen || request !== this.request) return;
      this.preview = preview;
      const content = (side) =>
        preview.notes.length
          ? preview.notes
              .map((note) =>
                note[side] ? `${note[side].title || 'Untitled'}\n\n${note[side].content}` : '(Note deleted)',
              )
              .join('\n\n────────\n\n')
          : JSON.stringify(
              preview.config.map((setting) => ({ key: setting.key, value: setting[side] })),
              null,
              2,
            );
      this.overlay.querySelector('[data-current]').value = content('current');
      this.overlay.querySelector('[data-draft]').value = content('draft');
      this.overlay.querySelector('[data-metadata]').textContent = JSON.stringify(preview, null, 2);
      this.overlay.querySelector('[data-explanation]').textContent = preview.requiresNewPlan
        ? 'Review a new plan to apply this operation. Note drafts can be saved as copies.'
        : 'Resolved drafts stay archived. Export recovery before clearing browser data.';
      this.status.textContent = 'Review both versions, then choose an action.';
    } catch (error) {
      if (this.modal.isOpen && request === this.request) this.status.textContent = error.message;
    }
    this.buttons();
  }

  async export() {
    try {
      this.flush();
      const conflicts = new Map(this.db.conflicts);
      let conflictError = null;
      try {
        const snapshot = await this.db.storage.readCurrentVault();
        if (!snapshot) throw new Error('Saved conflicts are unavailable.');
        for (const conflict of snapshot.conflicts) conflicts.set(conflict.id, conflict);
      } catch (error) {
        conflictError = error.message;
      }
      // Read active conflicts before archives: a concurrent resolution must
      // appear in at least one collection, never vanish between the reads.
      let archived = [];
      let archiveError = null;
      try {
        archived = await this.db.storage.readResolvedConflicts();
      } catch (error) {
        archiveError = error.message;
      }
      const payload = {
        format: 'noteforge-conflict-recovery',
        createdAt: new Date().toISOString(),
        notes: [...this.db.notes.values()].map((note) => note.toJSON()),
        config: this.db.config,
        conflicts: [...conflicts.values()],
        conflictError,
        archived,
        archiveError,
      };
      downloadText(JSON.stringify(payload, null, 2), 'noteforge-unsaved-recovery.json', 'application/json');
      this.status.textContent =
        archiveError || conflictError
          ? 'Local drafts exported; some stored recovery data was unavailable. This recovery file is not a portable vault backup.'
          : 'Local drafts, conflicts and archived resolutions exported. This recovery file is not a portable vault backup.';
    } catch (error) {
      this.status.textContent = `Recovery export failed: ${error.message}`;
    }
  }

  async resolve(action) {
    if (this.busy || !this.preview) return;
    this.busy = true;
    this.buttons();
    try {
      this.flush();
      if (action === 'use-draft') await this.ensureSafety();
      const result = await this.db.resolveConflict(this.preview, action);
      this.onResolved(result);
      this.busy = false;
      await this.refresh();
      this.status.textContent = 'Recovery choice saved. Newer drafts still need review.';
    } catch (error) {
      this.busy = false;
      await this.select();
      this.status.textContent = `${error.message} Review again before retrying.`;
    }
    this.buttons();
  }
}
