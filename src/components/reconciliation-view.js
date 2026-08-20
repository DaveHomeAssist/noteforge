import './phase6.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { readVaultDirectory, readVaultFileList } from '../utils/vault-import.js';

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
      <header class="modal__header"><div><h2 class="modal__title" id="reconciliation-title">Reconcile Markdown folder</h2><p class="muted">Preview-only scan. Applying creates a portable backup and local revisions; files and missing notes are never deleted.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close folder reconciliation">✕</button></header>
      <div class="reconciliation-view">
        <section class="reconciliation-picker" aria-labelledby="reconciliation-source-title"><div><h3 id="reconciliation-source-title">1. Select source</h3><p class="muted">Chromium can open a directory directly. Other browsers can select a folder or multiple Markdown files.</p></div><div class="reconciliation-picker__actions"><button type="button" class="btn btn--primary" data-directory>Choose folder</button><label class="btn btn--ghost reconciliation-file-label">Select folder files<input data-folder-files type="file" accept=".md,text/markdown,text/plain" multiple webkitdirectory></label><label class="btn btn--ghost reconciliation-file-label">Select Markdown files<input data-files type="file" accept=".md,text/markdown,text/plain" multiple></label></div></section>
        <section class="reconciliation-plan" aria-labelledby="reconciliation-plan-title"><h3 id="reconciliation-plan-title">2. Review plan</h3><div class="reconciliation-summary muted">No folder scanned.</div><div class="reconciliation-items"></div><nav class="reconciliation-pagination" aria-label="Reconciliation plan pages" hidden><button type="button" class="btn btn--ghost" data-page-previous>Previous</button><span data-page-status aria-live="polite"></span><button type="button" class="btn btn--ghost" data-page-next>Next</button></nav></section>
      </div>
      <footer class="recovery-modal__footer"><span class="recovery-modal__status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-report hidden>Download report</button><button type="button" class="btn btn--ghost" data-close>Close</button><button type="button" class="btn btn--primary" data-apply disabled>Apply selected changes</button></div></footer>
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
    report: overlay.querySelector('[data-report]'),
    pagination: overlay.querySelector('.reconciliation-pagination'),
    pagePrevious: overlay.querySelector('[data-page-previous]'),
    pageNext: overlay.querySelector('[data-page-next]'),
    pageStatus: overlay.querySelector('[data-page-status]'),
  };
}

export class ReconciliationView {
  constructor(els, db, service, { pickDirectory, confirmApply, onApplied } = {}) {
    this.els = els;
    this.db = db;
    this.service = service;
    this.pickDirectory = pickDirectory || globalThis.showDirectoryPicker?.bind(globalThis);
    this.confirmApply = confirmApply;
    this.onApplied = onApplied || (() => {});
    this.plan = null;
    this.lastReport = null;
    this.scanVersion = 0;
    this.page = 0;
    this.decisions = new Map();
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.directory.disabled ? this.els.file : this.els.directory });
    this.els.directory.disabled = typeof this.pickDirectory !== 'function';
    this.els.directory.title = this.els.directory.disabled ? 'Direct folder access is unavailable in this browser. Use Select Markdown files.' : '';
    this.els.directory.addEventListener('click', () => void this.#chooseDirectory());
    this.els.folderFile.addEventListener('change', () => void this.#chooseFiles(this.els.folderFile));
    this.els.file.addEventListener('change', () => void this.#chooseFiles(this.els.file));
    this.els.apply.addEventListener('click', () => void this.#apply());
    this.els.report.addEventListener('click', () => this.lastReport && this.service.downloadReport(this.lastReport));
    this.els.items.addEventListener('change', (event) => {
      const control = event.target.closest('[data-decision]');
      if (!control) return;
      this.decisions.set(control.dataset.decision, control.value);
      this.#syncApplyAvailability();
    });
    this.els.pagePrevious.addEventListener('click', () => this.#setPage(this.page - 1));
    this.els.pageNext.addEventListener('click', () => this.#setPage(this.page + 1));
  }

  get open() { return this.modal.isOpen; }
  show() {
    this.els.status.textContent = this.pickDirectory
      ? 'Choose a folder to build a read-only plan.'
      : 'Direct folder access is unavailable. Use the file-selection fallback; no writes occur during scanning.';
    this.modal.open();
  }
  close() { this.modal.close(); }

  async #chooseDirectory() {
    try {
      const handle = await this.pickDirectory({ mode: 'read' });
      await this.#scan(await readVaultDirectory(handle));
    } catch (error) {
      if (error?.name !== 'AbortError') this.els.status.textContent = error?.message || String(error);
    }
  }

  async #chooseFiles(input) {
    try { await this.#scan(await readVaultFileList(input.files)); }
    catch (error) { this.els.status.textContent = error?.message || String(error); }
    finally { input.value = ''; }
  }

  async #scan(entries) {
    const version = ++this.scanVersion;
    this.els.apply.disabled = true;
    this.els.status.textContent = `Scanning ${entries.length} Markdown file${entries.length === 1 ? '' : 's'}…`;
    let plan;
    try {
      plan = await this.service.plan(entries);
    } catch (error) {
      if (version === this.scanVersion) throw error;
      return false;
    }
    if (version !== this.scanVersion) return false;
    this.plan = plan;
    this.page = 0;
    this.decisions = new Map(this.plan.items.map((item) => [
      item.key,
      item.status === 'Conflict' ? 'skip' : '',
    ]));
    this.lastReport = null;
    this.els.report.hidden = true;
    this.#renderPlan();
    this.#syncApplyAvailability();
    this.els.status.textContent = 'Plan ready. Review every proposed action; the vault is unchanged.';
    return true;
  }

  #renderPlan() {
    const counts = this.plan.counts;
    this.els.summary.textContent = `${counts.Add} add · ${counts.Update} update · ${counts.Conflict} conflict · ${counts.Unchanged} unchanged · 0 deletions`;
    const pageCount = Math.max(1, Math.ceil(this.plan.items.length / PAGE_SIZE));
    this.page = Math.min(this.page, pageCount - 1);
    const start = this.page * PAGE_SIZE;
    const visibleItems = this.plan.items.slice(start, start + PAGE_SIZE);
    this.els.items.innerHTML = visibleItems.map((item) => {
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
    }).join('');
    this.els.pagination.hidden = this.plan.items.length <= PAGE_SIZE;
    this.els.pagePrevious.disabled = this.page === 0;
    this.els.pageNext.disabled = this.page >= pageCount - 1;
    const end = Math.min(start + visibleItems.length, this.plan.items.length);
    this.els.pageStatus.textContent = `Page ${this.page + 1} of ${pageCount} · ${this.plan.items.length ? start + 1 : 0}–${end} of ${this.plan.items.length} items`;
  }

  #setPage(page) {
    const pageCount = Math.max(1, Math.ceil((this.plan?.items.length || 0) / PAGE_SIZE));
    this.page = Math.max(0, Math.min(pageCount - 1, page));
    this.#renderPlan();
    this.els.items.querySelector('select, summary')?.focus();
  }

  #syncApplyAvailability() {
    const mutable = this.plan?.items.filter((item) => item.status === 'Add' || item.status === 'Update') || [];
    this.els.apply.disabled = !mutable.length || mutable.some((item) => !['apply', 'skip'].includes(this.decisions.get(item.key)));
  }

  async #apply() {
    const decisions = Object.fromEntries([...this.decisions].filter(([, value]) => value));
    if (typeof this.confirmApply !== 'function' || this.confirmApply({
      message: 'Apply the selected folder changes? NoteForge will first download a verified portable backup, capture pre-change revisions, re-check every source file, and delete nothing.',
      plan: this.plan,
    }) !== true) {
      this.els.status.textContent = 'Folder reconciliation cancelled. No data was changed.';
      return;
    }
    this.els.apply.disabled = true;
    this.els.status.textContent = 'Creating verified backup and checking source files…';
    try {
      this.lastReport = await this.service.apply({ plan: this.plan, decisions, confirmed: true });
      try {
        await this.onApplied(this.lastReport);
      } catch (error) {
        console.warn('[reconciliation] applied vault could not be refreshed in the open workspace:', error);
      }
      const s = this.lastReport.summary;
      this.els.status.textContent = `${this.lastReport.message} Added ${s.added}, updated ${s.updated}, unchanged ${s.unchanged}, skipped ${s.skipped}, deleted 0.`;
      this.els.report.hidden = false;
      this.plan = await this.service.plan(this.service.entries);
      this.page = 0;
      this.decisions = new Map(this.plan.items.map((item) => [item.key, item.status === 'Conflict' ? 'skip' : '']));
      this.#renderPlan();
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
    } finally {
      this.#syncApplyAvailability();
    }
  }
}
