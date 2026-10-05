import './phase6.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { readVaultDirectory, readVaultFileList } from '../utils/vault-import.js';
import { icon } from '../ui/icons.js';

const PREVIEW_LIMIT = 20_000;
const PAGE_SIZE = 50;
const previewMarkdown = (value) => {
  const source = String(value ?? '');
  return source.length <= PREVIEW_LIMIT
    ? source
    : `${source.slice(0, PREVIEW_LIMIT)}\n\n… Preview abbreviated at ${PREVIEW_LIMIT.toLocaleString()} of ${source.length.toLocaleString()} characters. Exact bytes will be used when applying.`;
};

export function createReconciliationElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'reconciliation-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel reconciliation-modal" role="dialog" aria-modal="true" aria-labelledby="reconciliation-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="reconciliation-title">Reconcile Markdown folder</h2><p class="muted">Preview-only scan. Applying creates a portable backup and local revisions; files and missing notes are never deleted.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close folder reconciliation">${icon('x')}</button></header>
      <div class="reconciliation-view">
        <section class="reconciliation-picker" aria-labelledby="reconciliation-source-title"><div><h3 id="reconciliation-source-title">1. Select source</h3><p class="muted">Chromium can open a directory directly. Other browsers can select a folder or multiple Markdown files.</p></div><div class="reconciliation-picker__actions"><button type="button" class="btn btn--primary" data-directory>Choose folder</button><label class="btn btn--ghost reconciliation-file-label">Select folder files<input data-folder-files type="file" accept=".md,text/markdown,text/plain" multiple webkitdirectory></label><label class="btn btn--ghost reconciliation-file-label">Select Markdown files<input data-files type="file" accept=".md,text/markdown,text/plain" multiple></label></div></section>
        <section class="reconciliation-plan" aria-labelledby="reconciliation-plan-title"><h3 id="reconciliation-plan-title">2. Review plan</h3><div class="reconciliation-summary muted">No folder scanned.</div><div class="reconciliation-items"></div><nav class="reconciliation-pagination" aria-label="Reconciliation plan pages" hidden><button type="button" class="btn btn--ghost" data-page-previous>Previous</button><span data-page-status aria-live="polite"></span><button type="button" class="btn btn--ghost" data-page-next>Next</button></nav></section>
      </div>
      <footer class="recovery-modal__footer"><span class="recovery-modal__status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-report hidden>Download report</button><button type="button" class="btn btn--ghost" data-close>Close</button><button type="button" class="btn btn--ghost" data-refresh hidden>Refresh preview</button><button type="button" class="btn btn--primary" data-apply disabled>Apply selected changes</button></div></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    directory: overlay.querySelector('[data-directory]'),
    folderFile: overlay.querySelector('[data-folder-files]'),
    file: overlay.querySelector('[data-files]'),
    summary: overlay.querySelector('.reconciliation-summary'),
    items: overlay.querySelector('.reconciliation-items'),
    status: overlay.querySelector('[role="status"]'),
    apply: overlay.querySelector('[data-apply]'),
    refresh: overlay.querySelector('[data-refresh]'),
    report: overlay.querySelector('[data-report]'),
    pagination: overlay.querySelector('.reconciliation-pagination'),
    pagePrevious: overlay.querySelector('[data-page-previous]'),
    pageNext: overlay.querySelector('[data-page-next]'),
    pageStatus: overlay.querySelector('[data-page-status]'),
  };
}

export class ReconciliationView {
  constructor(els, db, service, { pickDirectory, confirmApply, onApplied, refreshPreview } = {}) {
    this.els = els;
    this.db = db;
    this.service = service;
    this.pickDirectory = pickDirectory || globalThis.showDirectoryPicker?.bind(globalThis);
    this.confirmApply = confirmApply;
    this.refreshPreview = refreshPreview;
    this.epoch = 0;
    this.busy = false;
    this.scanning = false;
    this.stale = false;
    this.onApplied = onApplied || (() => {});
    this.plan = null;
    this.lastReport = null;
    this.scanVersion = 0;
    this.page = 0;
    this.decisions = new Map();
    this.modal = new Modal(els.overlay, {
      onEscape: () => this.close(),
      initialFocus: () => (this.els.directory.disabled ? this.els.file : this.els.directory),
    });
    this.els.overlay.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
    });
    this.els.refresh?.addEventListener('click', () => {
      if (!this.busy && !this.scanning) void this.#scan(() => this.service.refreshPlan());
    });
    this.els.directory.disabled = typeof this.pickDirectory !== 'function';
    this.els.directory.title = this.els.directory.disabled
      ? 'Direct folder access is unavailable in this browser. Use Select Markdown files.'
      : '';
    this.els.directory.addEventListener('click', () => void this.#chooseDirectory());
    this.els.folderFile.addEventListener('change', () => void this.#chooseFiles(this.els.folderFile));
    this.els.file.addEventListener('change', () => void this.#chooseFiles(this.els.file));
    this.els.apply.addEventListener('click', () => void this.#apply());
    this.els.report.addEventListener('click', () => this.lastReport && this.service.downloadReport(this.lastReport));
    this.els.items.addEventListener('change', (event) => {
      const control = event.target.closest('[data-decision]');
      if (!control) return;
      this.epoch++;
      this.decisions.set(control.dataset.decision, control.value);
      this.#syncApplyAvailability();
    });
    this.els.pagePrevious.addEventListener('click', () => this.#setPage(this.page - 1));
    this.els.pageNext.addEventListener('click', () => this.#setPage(this.page + 1));
  }

  get open() {
    return this.modal.isOpen;
  }
  show() {
    this.epoch++;
    this.scanVersion++;
    this.scanning = false;
    this.plan = null;
    this.stale = Boolean(this.service.entries?.length);
    this.#syncApplyAvailability();
    this.els.status.textContent = this.pickDirectory
      ? 'Choose a folder to build a read-only plan.'
      : 'Direct folder access is unavailable. Use the file-selection fallback; no writes occur during scanning.';
    this.modal.open();
  }
  close() {
    this.epoch++;
    this.scanVersion++;
    this.scanning = false;
    this.modal.close();
  }

  async #chooseDirectory() {
    if (this.busy) return;
    const version = ++this.scanVersion;
    this.epoch++;
    this.plan = null;
    this.scanning = true;
    this.stale = Boolean(this.service.entries?.length);
    this.#syncApplyAvailability();
    try {
      const handle = await this.pickDirectory({ mode: 'read' });
      if (version !== this.scanVersion || !this.open) return;
      const entries = await readVaultDirectory(handle);
      if (version === this.scanVersion && this.open) await this.#scan(() => this.service.plan(entries), version);
    } catch (error) {
      if (version === this.scanVersion && this.open && error?.name !== 'AbortError')
        this.els.status.textContent = error?.message || String(error);
    } finally {
      if (version === this.scanVersion) {
        this.scanning = false;
        this.#syncApplyAvailability();
      }
    }
  }

  async #chooseFiles(input) {
    if (this.busy) return;
    const version = ++this.scanVersion;
    this.epoch++;
    this.plan = null;
    this.scanning = true;
    this.stale = Boolean(this.service.entries?.length);
    this.#syncApplyAvailability();
    try {
      const entries = await readVaultFileList(input.files);
      if (version === this.scanVersion && this.open) await this.#scan(() => this.service.plan(entries), version);
    } catch (error) {
      if (version === this.scanVersion && this.open) this.els.status.textContent = error?.message || String(error);
    } finally {
      if (version === this.scanVersion) {
        input.value = '';
        this.scanning = false;
        this.#syncApplyAvailability();
      }
    }
  }

  async #scan(loadPlan, version = ++this.scanVersion) {
    this.epoch++;
    this.plan = null;
    this.scanning = true;
    this.#syncApplyAvailability();
    this.els.status.textContent = 'Refreshing saved notes and scanning the selected source…';
    try {
      await this.refreshPreview?.();
      if (version !== this.scanVersion || !this.open) return;
      const plan = await loadPlan();
      if (version !== this.scanVersion || !this.open) return;
      this.plan = plan;
      this.stale = false;
      this.page = 0;
      // Source or destination changes require new per-item decisions.
      this.decisions = new Map(plan.items.map((item) => [item.key, item.status === 'Conflict' ? 'skip' : '']));
      this.lastReport = null;
      this.els.report.hidden = true;
      this.#renderPlan();
      this.els.status.textContent = 'Plan ready. Review every proposed action; the vault is unchanged.';
    } catch (error) {
      if (version === this.scanVersion && this.open) this.els.status.textContent = error?.message || String(error);
    } finally {
      if (version === this.scanVersion) {
        this.scanning = false;
        this.#syncApplyAvailability();
      }
    }
  }

  #renderPlan() {
    const counts = this.plan.counts;
    this.els.summary.textContent = `${counts.Add} add · ${counts.Update} update · ${counts.Conflict} conflict · ${counts.Unchanged} unchanged · 0 deletions`;
    const pageCount = Math.max(1, Math.ceil(this.plan.items.length / PAGE_SIZE));
    this.page = Math.min(this.page, pageCount - 1);
    const start = this.page * PAGE_SIZE;
    const visibleItems = this.plan.items.slice(start, start + PAGE_SIZE);
    this.els.items.innerHTML = visibleItems
      .map((item) => {
        const destination = item.destinationNoteId ? this.db.notes.get(item.destinationNoteId) : null;
        const mutable = item.status === 'Add' || item.status === 'Update';
        const selected = this.decisions.get(item.key);
        const decision = mutable
          ? `<label class="reconciliation-decision">Decision<select data-decision="${escapeHtml(item.key)}" aria-label="Decision for ${escapeHtml(item.relativePath)}"><option value=""${selected ? '' : ' selected'}>Choose…</option><option value="apply"${selected === 'apply' ? ' selected' : ''}>Apply ${item.status.toLowerCase()}</option><option value="skip"${selected === 'skip' ? ' selected' : ''}>Skip</option></select></label>`
          : `<input type="hidden" data-decision="${escapeHtml(item.key)}" value="${item.status === 'Conflict' ? 'skip' : ''}"><span class="reconciliation-fixed">${item.status === 'Conflict' ? 'Conflict must be skipped until resolved' : 'No change'}</span>`;
        return `<article class="reconciliation-item" data-status="${item.status.toLowerCase()}">
        <header><div><span class="reconciliation-badge">${item.status}</span><strong>${escapeHtml(item.relativePath)}</strong><p class="muted">${escapeHtml(item.reasons.join(' '))}</p></div>${decision}</header>
        <details><summary>Compare Markdown</summary><div class="reconciliation-compare"><section><h4>Folder source</h4><pre>${escapeHtml(previewMarkdown(item.source))}</pre></section><section><h4>Vault destination</h4><pre>${escapeHtml(previewMarkdown(destination?.content || '(new note)'))}</pre></section></div></details>
      </article>`;
      })
      .join('');
    this.els.pagination.hidden = this.plan.items.length <= PAGE_SIZE;
    this.els.pagePrevious.disabled = this.page === 0;
    this.els.pageNext.disabled = this.page >= pageCount - 1;
    const end = Math.min(start + visibleItems.length, this.plan.items.length);
    this.els.pageStatus.textContent = `Page ${this.page + 1} of ${pageCount} · ${this.plan.items.length ? start + 1 : 0}–${end} of ${this.plan.items.length} items`;
  }

  #setPage(page) {
    if (!this.plan) return;
    const pageCount = Math.max(1, Math.ceil((this.plan?.items.length || 0) / PAGE_SIZE));
    this.page = Math.max(0, Math.min(pageCount - 1, page));
    this.#renderPlan();
    this.els.items.querySelector('select, summary')?.focus();
  }

  #syncApplyAvailability() {
    const mutable = this.plan?.items.filter((item) => item.status === 'Add' || item.status === 'Update') || [];
    this.els.apply.disabled =
      this.busy ||
      this.scanning ||
      this.stale ||
      !mutable.length ||
      mutable.some((item) => !['apply', 'skip'].includes(this.decisions.get(item.key)));
    if (this.els.refresh) {
      this.els.refresh.hidden = !this.stale;
      this.els.refresh.disabled = this.busy || this.scanning;
    }
    this.els.directory.disabled = this.busy || typeof this.pickDirectory !== 'function';
    this.els.file.disabled = this.busy;
    this.els.folderFile.disabled = this.busy;
    this.els.items.querySelectorAll('select').forEach((control) => {
      control.disabled = this.busy || this.scanning || this.stale || !this.plan;
    });
  }

  async #apply() {
    if (!this.plan || this.els.apply.disabled || this.busy) return;
    const plan = structuredClone(this.plan);
    const decisions = Object.fromEntries([...this.decisions].filter(([, value]) => value));
    const epoch = this.epoch;
    const current = () => epoch === this.epoch && this.open;
    this.busy = true;
    this.#syncApplyAvailability();
    try {
      const approved =
        typeof this.confirmApply === 'function' &&
        (await this.confirmApply({
          message:
            'Apply the selected folder changes? NoteForge will first download a verified portable backup, capture pre-change revisions, re-check every source file, and delete nothing.',
          plan,
        }));
      if (!current()) return;
      if (approved !== true) {
        this.els.status.textContent = 'Folder reconciliation cancelled. No data was changed.';
        return;
      }
      this.els.status.textContent = 'Creating verified backup and checking source files…';
      const report = await this.service.apply({ plan, decisions, confirmed: true });
      if (!current()) return;
      this.lastReport = report;
      try {
        await this.onApplied(report);
      } catch (error) {
        console.warn('[reconciliation] applied vault could not be refreshed in the open workspace:', error);
      }
      if (!current()) return;
      const summary = report.summary;
      this.els.status.textContent = `${report.message} Added ${summary.added}, updated ${summary.updated}, unchanged ${summary.unchanged}, skipped ${summary.skipped}, deleted 0.`;
      this.els.report.hidden = false;
      this.plan = null;
      this.stale = true;
    } catch (error) {
      if (!current()) return;
      if (error?.code === 'stale_plan') {
        this.stale = true;
        this.plan = null;
        this.els.status.textContent =
          'The source or current vault changed. Refresh the preview and review each decision again.';
      } else this.els.status.textContent = error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncApplyAvailability();
    }
  }
}
