// Browser-local revision history. The view owns presentation, selection, focus,
// and confirmation handoff; durable reads/restores stay behind an injected
// service so the component is usable with either the real RevisionStore or a
// small test double.

import { escapeHtml } from '../utils/helpers.js';
import { Modal } from './modal.js';
import './recovery.css';

const REASON_LABELS = {
  autosave: 'Autosave',
  pre_import: 'Before import',
  pre_reconcile: 'Before reconciliation',
  pre_bulk_replace: 'Before bulk replace',
  pre_bulk_action: 'Before bulk action',
  pre_archive: 'Before archive',
  pre_unarchive: 'Before unarchive',
  pre_rename: 'Before rename',
  pre_alias_repair: 'Before alias repair',
  pre_link_conversion: 'Before link conversion',
  pre_frontmatter_alias_migration: 'Before alias migration',
  pre_frontmatter_source_edit: 'Before YAML source edit',
  pre_property_edit: 'Before property edit',
  pre_restore: 'Before restore',
  manual: 'Manual snapshot',
};

const asArray = (value) => (Array.isArray(value) ? value : []);

/** Create the lazy History dialog only when the feature is first opened. */
export function createHistoryElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'history-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel recovery-modal" role="dialog" aria-modal="true" aria-labelledby="history-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="history-title">↶ Revision history</h2><p class="muted recovery-modal__subtitle">Browser-local recovery points for the current note</p></div><button class="btn btn--ghost" data-close title="Close" aria-label="Close revision history">✕</button></header>
      <div class="history-view"><nav id="history-list" class="history-view__list" aria-label="Note revisions"></nav><div class="history-view__detail"><div id="history-preview" class="history-view__preview"></div><div id="history-diff" class="history-view__diff"></div></div></div>
      <footer class="recovery-modal__footer"><span id="history-status" class="recovery-modal__status" role="status" aria-live="polite"></span><div class="modal__actions"><button id="history-restore-copy" class="btn btn--ghost" disabled>Restore as copy</button><button id="history-restore" class="btn btn--primary" disabled>Restore revision</button></div></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    list: overlay.querySelector('#history-list'),
    preview: overlay.querySelector('#history-preview'),
    diff: overlay.querySelector('#history-diff'),
    status: overlay.querySelector('#history-status'),
    restore: overlay.querySelector('#history-restore'),
    restoreCopy: overlay.querySelector('#history-restore-copy'),
  };
}

function dateValue(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function reasonLabel(reason) {
  return REASON_LABELS[reason] || String(reason || 'Revision').replaceAll('_', ' ');
}

function snapshotFrom(details, revision) {
  const source = details?.snapshot || revision?.snapshot || revision?.note || revision || {};
  const metadata = details?.metadata || revision?.metadata || source.metadata || {};
  return {
    ...metadata,
    ...source,
    content: String(source.content ?? details?.content ?? revision?.content ?? ''),
  };
}

function changedMetadata(current, selected) {
  const ignored = new Set(['content', 'id', 'updatedAt']);
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(selected || {})]);
  return [...keys]
    .filter((key) => !ignored.has(key))
    .filter((key) => JSON.stringify(current?.[key]) !== JSON.stringify(selected?.[key]))
    .sort();
}

function previewLine(value, limit = 800) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [${text.length - limit} more characters]`;
}

function previewContent(value) {
  return String(value ?? '').split('\n').map((line) => previewLine(line)).join('\n');
}

function unavailableReason(health) {
  if (health?.message) return health.message;
  if (health?.reason === 'indexeddb_unavailable') return 'Durable IndexedDB storage is unavailable.';
  if (health?.reason === 'quota') return 'History is paused to protect space for current-note saves.';
  return typeof health?.reason === 'string' && health.reason.includes(' ')
    ? health.reason
    : 'Revision history requires durable IndexedDB storage.';
}

/**
 * Line-oriented diff used by the revision preview. Additions describe the
 * selected revision; removals describe the current note. A bounded fallback
 * keeps very large notes from turning preview into an unbounded matrix.
 *
 * @param {string} currentText
 * @param {string} selectedText
 * @returns {{ type:'same'|'add'|'remove', text:string }[]}
 */
export function buildHistoryDiff(currentText, selectedText) {
  const current = String(currentText ?? '').split('\n');
  const selected = String(selectedText ?? '').split('\n');

  if (current.length * selected.length > 250_000) {
    const out = [];
    const total = Math.max(current.length, selected.length);
    for (let i = 0; i < total; i += 1) {
      if (current[i] === selected[i] && current[i] !== undefined) out.push({ type: 'same', text: current[i] });
      else {
        if (current[i] !== undefined) out.push({ type: 'remove', text: current[i] });
        if (selected[i] !== undefined) out.push({ type: 'add', text: selected[i] });
      }
    }
    return out;
  }

  const widths = selected.length + 1;
  const matrix = new Uint32Array((current.length + 1) * widths);
  for (let i = current.length - 1; i >= 0; i -= 1) {
    for (let j = selected.length - 1; j >= 0; j -= 1) {
      const at = i * widths + j;
      matrix[at] = current[i] === selected[j]
        ? matrix[(i + 1) * widths + j + 1] + 1
        : Math.max(matrix[(i + 1) * widths + j], matrix[i * widths + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < current.length && j < selected.length) {
    if (current[i] === selected[j]) {
      out.push({ type: 'same', text: current[i] });
      i += 1;
      j += 1;
    } else if (matrix[(i + 1) * widths + j] >= matrix[i * widths + j + 1]) {
      out.push({ type: 'remove', text: current[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: selected[j] });
      j += 1;
    }
  }
  while (i < current.length) out.push({ type: 'remove', text: current[i++] });
  while (j < selected.length) out.push({ type: 'add', text: selected[j++] });
  return out;
}

export class HistoryView {
  /**
   * @param {{
   *   overlay:HTMLElement,
   *   list:HTMLElement,
   *   preview:HTMLElement,
   *   diff?:HTMLElement,
   *   status?:HTMLElement,
   *   restore?:HTMLButtonElement,
   *   restoreCopy?:HTMLButtonElement
   * }} els
   * @param {{
   *   getStatus?:(noteId:string)=>Promise<object>|object,
   *   listRevisions:(noteId:string)=>Promise<object[]>|object[],
   *   getRevision?:(request:{noteId:string, revisionId:string})=>Promise<object>|object,
   *   getCurrentNote?:(noteId:string)=>Promise<object>|object,
   *   previewRevision?:(request:{noteId:string, revisionId:string})=>Promise<object>|object,
   *   restore:(request:{noteId:string, revisionId:string})=>Promise<object>|object,
   *   restoreAsCopy:(request:{noteId:string, revisionId:string})=>Promise<object>|object
   * }} service
   * @param {{
   *   confirmRestore?:(details:object)=>Promise<boolean>|boolean,
   *   onRestored?:(result:object)=>void,
   *   onRestoreCopy?:(result:object)=>void
   * }} [options]
   */
  constructor(els, service, options = {}) {
    if (!els?.overlay || !els?.list || !els?.preview) {
      throw new TypeError('HistoryView requires overlay, list, and preview elements.');
    }
    if (!service || typeof service.listRevisions !== 'function') {
      throw new TypeError('HistoryView requires a revision service.');
    }

    this.els = els;
    this.service = service;
    this.confirmRestore = options.confirmRestore;
    this.onRestored = options.onRestored;
    this.onRestoreCopy = options.onRestoreCopy;
    this.noteId = null;
    this.revisions = [];
    this.selectedId = null;
    this.selectedDetails = null;
    this.busy = false;
    this.loadToken = 0;

    this.modal = new Modal(els.overlay, { initialFocus: () => this.#initialFocus() });
    this.els.list.addEventListener('click', (event) => this.#onListClick(event));
    this.els.list.addEventListener('keydown', (event) => this.#onListKey(event));
    this.els.restore?.addEventListener('click', () => this.#restore());
    this.els.restoreCopy?.addEventListener('click', () => this.#restoreCopy());

    this.els.status?.setAttribute('role', 'status');
    this.els.status?.setAttribute('aria-live', 'polite');
    this.els.status?.setAttribute('aria-atomic', 'true');
    this.els.list.setAttribute('aria-label', this.els.list.getAttribute('aria-label') || 'Note revisions');
    this.#setActionsEnabled(false);
  }

  get open() {
    return this.modal.isOpen;
  }

  async show(noteId) {
    this.noteId = noteId;
    this.selectedId = null;
    this.selectedDetails = null;
    this.#renderLoading();
    this.modal.open();
    await this.refresh();
  }

  close() {
    this.loadToken += 1;
    this.modal.close();
  }

  async toggle(noteId) {
    if (this.modal.isOpen && this.noteId === noteId) this.close();
    else await this.show(noteId);
  }

  async refresh() {
    if (!this.noteId) return;
    const token = ++this.loadToken;
    this.#setStatus('Loading revision history…');
    try {
      const health = typeof this.service.getStatus === 'function'
        ? await this.service.getStatus(this.noteId)
        : { available: true };
      if (token !== this.loadToken) return;
      if (health?.available === false) {
        this.revisions = [];
        this.#renderUnavailable(unavailableReason(health));
        return;
      }

      const revisions = await this.service.listRevisions(this.noteId);
      if (token !== this.loadToken) return;
      this.revisions = asArray(revisions).slice().sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));
      this.#renderList();
      if (this.revisions.length === 0) {
        this.#renderEmpty();
        return;
      }
      const selected = this.revisions.some((revision) => revision.id === this.selectedId)
        ? this.selectedId
        : this.revisions[0].id;
      await this.#select(selected);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.#renderError(error, 'Revision history could not be loaded.');
    }
  }

  #initialFocus() {
    return this.els.list.querySelector('.history-revision[aria-current="true"]')
      || this.els.list.querySelector('.history-revision')
      || this.els.overlay.querySelector('button[data-close], [data-close][tabindex]:not([tabindex="-1"])')
      || this.modal?.panel;
  }

  #renderLoading() {
    this.revisions = [];
    this.els.list.innerHTML = '<p class="muted history-view__empty">Loading revisions…</p>';
    this.els.preview.innerHTML = '<p class="muted history-view__empty">Select a revision to compare it with the current note.</p>';
    if (this.els.diff) this.els.diff.innerHTML = '';
    this.#setActionsEnabled(false);
  }

  #renderUnavailable(reason) {
    const detail = reason || 'Revision history requires durable IndexedDB storage.';
    this.els.list.innerHTML = '<p class="muted history-view__empty">Revision history is unavailable in this storage mode.</p>';
    this.els.preview.innerHTML = `<div class="history-view__notice" role="note"><strong>Browser-local recovery is unavailable.</strong><p>${escapeHtml(detail)}</p><p>Download a JSON backup for portable recovery.</p></div>`;
    if (this.els.diff) this.els.diff.innerHTML = '';
    this.#setActionsEnabled(false);
    this.#setStatus('Revision history is unavailable.');
  }

  #renderEmpty() {
    this.els.list.innerHTML = '<p class="muted history-view__empty">No revisions have been captured for this note yet.</p>';
    this.els.preview.innerHTML = '<div class="history-view__notice" role="note"><strong>No recovery points yet.</strong><p>A revision is captured after a durable save and before destructive changes.</p><p>Revision history is stored in this browser and is not a portable backup.</p></div>';
    if (this.els.diff) this.els.diff.innerHTML = '';
    this.#setActionsEnabled(false);
    this.#setStatus('No revisions found.');
  }

  #renderList() {
    if (this.revisions.length === 0) return;
    this.els.list.innerHTML = `<ol class="history-list">${this.revisions.map((revision) => {
      const selected = revision.id === this.selectedId;
      const label = reasonLabel(revision.reason);
      const when = formatDateTime(revision.createdAt);
      return `<li class="history-list__item">
        <button type="button" class="history-revision" data-revision-id="${escapeHtml(revision.id)}"${selected ? ' aria-current="true"' : ''}>
          <span class="history-revision__reason">${escapeHtml(label)}</span>
          <time class="history-revision__time" datetime="${escapeHtml(revision.createdAt || '')}">${escapeHtml(when)}</time>
        </button>
      </li>`;
    }).join('')}</ol>`;
  }

  async #select(revisionId, { focus = false } = {}) {
    const revision = this.revisions.find((item) => item.id === revisionId);
    if (!revision || this.busy) return;
    const token = ++this.loadToken;
    this.selectedId = revisionId;
    this.#renderList();
    if (focus) {
      [...this.els.list.querySelectorAll('.history-revision[data-revision-id]')]
        .find((button) => button.dataset.revisionId === revisionId)
        ?.focus();
    }
    this.#setActionsEnabled(false);
    this.#setStatus('Loading revision preview…');
    this.els.preview.setAttribute('aria-busy', 'true');

    try {
      let details;
      if (typeof this.service.previewRevision === 'function') {
        details = await this.service.previewRevision({ noteId: this.noteId, revisionId });
      } else {
        const [fullRevision, currentNote] = await Promise.all([
          typeof this.service.getRevision === 'function'
            ? this.service.getRevision({ noteId: this.noteId, revisionId })
            : revision,
          typeof this.service.getCurrentNote === 'function'
            ? this.service.getCurrentNote(this.noteId)
            : null,
        ]);
        details = { revision: fullRevision || revision, currentNote };
      }
      if (token !== this.loadToken) return;
      this.selectedDetails = {
        ...details,
        revision: details?.revision || revision,
        snapshot: snapshotFrom(details, details?.revision || revision),
        currentNote: details?.currentNote || {},
      };
      this.#renderPreview();
      this.#setActionsEnabled(true);
      this.#setStatus(`Showing revision from ${formatDateTime(revision.createdAt)}.`);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.selectedDetails = null;
      this.#renderError(error, 'This revision could not be previewed.');
    } finally {
      if (token === this.loadToken) this.els.preview.removeAttribute('aria-busy');
    }
  }

  #renderPreview() {
    const details = this.selectedDetails;
    const revision = details.revision;
    const selected = details.snapshot;
    const current = details.currentNote || {};
    const metadata = changedMetadata(current, selected);
    const title = selected.title || current.title || 'Untitled';
    const metadataText = metadata.length
      ? `Metadata changes: ${metadata.join(', ')}`
      : 'No restorable metadata changes.';

    this.els.preview.innerHTML = `<article class="history-preview">
      <header class="history-preview__header">
        <h3 class="history-preview__title">${escapeHtml(title)}</h3>
        <p class="muted">${escapeHtml(reasonLabel(revision.reason))} · ${escapeHtml(formatDateTime(revision.createdAt))}</p>
      </header>
      <p class="history-preview__metadata">${escapeHtml(metadataText)}</p>
      <details class="history-preview__content">
        <summary>Revision content</summary>
        <pre><code>${escapeHtml(previewContent(selected.content))}</code></pre>
        <p class="muted">Long lines, including embedded image data, are abbreviated in this visual preview. Restore uses the exact stored bytes.</p>
      </details>
    </article>`;

    if (this.els.diff) {
      const diff = buildHistoryDiff(current.content || '', selected.content);
      const changed = diff.some((line) => line.type !== 'same');
      this.els.diff.innerHTML = changed
        ? `<section class="history-diff" aria-label="Content comparison">
            <p class="history-diff__legend"><span>Current only</span><span>Selected revision</span></p>
            <div class="history-diff__lines">${diff.map((line) => {
              const label = line.type === 'remove' ? 'Current only' : line.type === 'add' ? 'Selected revision' : 'Unchanged';
              const mark = line.type === 'remove' ? '−' : line.type === 'add' ? '+' : ' ';
              return `<div class="history-diff__line history-diff__line--${line.type}">
                <span class="history-diff__kind">${label}</span><span class="history-diff__mark" aria-hidden="true">${mark}</span><code>${escapeHtml(previewLine(line.text || ' '))}</code>
              </div>`;
            }).join('')}</div>
          </section>`
        : '<p class="muted history-diff__empty">The selected revision content matches the current note.</p>';
    }
  }

  #onListClick(event) {
    const button = event.target.closest('.history-revision[data-revision-id]');
    if (button) this.#select(button.dataset.revisionId, { focus: true });
  }

  #onListKey(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      const button = event.target.closest('.history-revision[data-revision-id]');
      if (!button) return;
      event.preventDefault();
      this.#select(button.dataset.revisionId, { focus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...this.els.list.querySelectorAll('.history-revision[data-revision-id]')];
    if (buttons.length === 0) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(current + 1, buttons.length - 1)
          : Math.max(current - 1, 0);
    event.preventDefault();
    this.#select(buttons[next].dataset.revisionId, { focus: true });
  }

  async #restore() {
    if (!this.selectedDetails || this.busy) return;
    if (typeof this.confirmRestore !== 'function') {
      this.#setStatus('Restore is blocked because explicit confirmation is unavailable.', true);
      return;
    }
    const request = { noteId: this.noteId, revisionId: this.selectedId };
    this.busy = true;
    this.#setActionsEnabled(false);
    let approved;
    try {
      approved = await this.confirmRestore({
        ...request,
        revision: this.selectedDetails.revision,
        snapshot: this.selectedDetails.snapshot,
        currentNote: this.selectedDetails.currentNote,
        message: 'Restore this revision? A safety revision of the current note will be created first.',
      });
    } catch (error) {
      this.busy = false;
      this.#setActionsEnabled(true);
      this.#setStatus(error?.message || 'Restore confirmation failed.', true);
      return;
    }
    if (!approved) {
      this.busy = false;
      this.#setActionsEnabled(true);
      this.#setStatus('Restore cancelled.');
      return;
    }

    await this.#runAction('Restoring revision…', async () => {
      const result = await this.service.restore(request);
      this.onRestored?.(result);
      await this.refresh();
      this.#setStatus('Revision restored. A safety revision preserves the previous note state.');
    });
  }

  async #restoreCopy() {
    if (!this.selectedDetails || this.busy) return;
    await this.#runAction('Creating restored copy…', async () => {
      const result = await this.service.restoreAsCopy({ noteId: this.noteId, revisionId: this.selectedId });
      this.#setStatus('Restored copy created. The original note was not changed.');
      this.onRestoreCopy?.(result);
    });
  }

  async #runAction(message, action) {
    this.busy = true;
    this.#setActionsEnabled(false);
    this.#setStatus(message);
    try {
      await action();
    } catch (error) {
      this.#setStatus(error?.message || 'The revision action failed.', true);
    } finally {
      this.busy = false;
      this.#setActionsEnabled(!!this.selectedDetails);
    }
  }

  #renderError(error, fallback) {
    const message = error?.message || fallback;
    this.els.preview.innerHTML = `<div class="history-view__notice history-view__notice--error" role="alert"><strong>${escapeHtml(fallback)}</strong><p>${escapeHtml(message)}</p></div>`;
    if (this.els.diff) this.els.diff.innerHTML = '';
    this.#setActionsEnabled(false);
    this.#setStatus(message, true);
  }

  #setActionsEnabled(enabled) {
    if (this.els.restore) this.els.restore.disabled = !enabled || this.busy;
    if (this.els.restoreCopy) this.els.restoreCopy.disabled = !enabled || this.busy;
  }

  #setStatus(message, alert = false) {
    if (!this.els.status) return;
    this.els.status.textContent = message;
    this.els.status.setAttribute('role', alert ? 'alert' : 'status');
  }
}
