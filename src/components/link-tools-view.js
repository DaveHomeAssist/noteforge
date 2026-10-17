import './link-tools-view.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { LinkOperations } from '../core/link-operations.js';
import { icon } from '../ui/icons.js';

function ambiguityLabel(kind) {
  if (kind === 'duplicate_title') return 'Duplicate canonical title';
  if (kind === 'duplicate_alias') return 'Alias used by multiple notes';
  return 'Title and alias collision';
}

/** Create the lazy Link tools dialog only when the feature is first opened. */
export function createLinkToolsElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'link-tools-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel link-tools" role="dialog" aria-modal="true" aria-labelledby="link-tools-title" tabindex="-1">
      <header class="modal__header"><h2 class="modal__title" id="link-tools-title">Link tools</h2><button class="btn btn--ghost" data-close title="Close" aria-label="Close link tools">${icon('x')}</button></header>
      <div id="link-tools-content" class="link-tools__content"></div>
      <footer class="link-tools__footer"><span id="link-tools-status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close>Close</button><button type="button" class="btn btn--ghost" id="link-tools-refresh" hidden>Refresh preview</button><button type="button" class="btn btn--primary" id="link-tools-apply">Apply</button></div></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    title: overlay.querySelector('#link-tools-title'),
    content: overlay.querySelector('#link-tools-content'),
    status: overlay.querySelector('#link-tools-status'),
    apply: overlay.querySelector('#link-tools-apply'),
    refresh: overlay.querySelector('#link-tools-refresh'),
  };
}

export class LinkToolsView {
  constructor(els, db, { onApplied = () => {}, refreshPreview } = {}) {
    this.els = els;
    this.db = db;
    this.links = new LinkOperations(db);
    this.onApplied = onApplied;
    this.refreshPreview = refreshPreview;
    this.epoch = 0;
    this.busy = false;
    this.stale = false;
    this.intent = null;
    this.mode = null;
    this.plan = null;
    this.modal = new Modal(els.overlay, { initialFocus: () => this.#initialFocus(), onEscape: () => this.close() });
    this.els.overlay.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
    });
    this.els.refresh?.addEventListener('click', () => this.#refresh());
    this.els.apply.addEventListener('click', () => this.#apply());
    this.els.content.addEventListener('click', (event) => {
      const rename = event.target.closest('[data-repair-rename]');
      if (rename) {
        const note = this.db.getNote(rename.dataset.repairRename);
        if (note) this.showRename(note.id, note.title);
        return;
      }
      const alias = event.target.closest('[data-repair-alias]');
      if (alias) this.showAliasRemoval(alias.dataset.repairAlias, alias.dataset.alias);
    });
  }

  get open() {
    return this.modal.isOpen;
  }

  integrityReport() {
    return this.links.linkIntegrityReport();
  }

  showRename(noteId, proposedTitle) {
    this.#begin('rename', { noteId, proposedTitle });
    this.noteId = noteId;
    this.els.title.textContent = 'Rename note safely';
    this.els.apply.hidden = false;
    this.els.apply.textContent = 'Apply rename';
    this.els.content.innerHTML = `<label class="link-tools__field">New canonical title
      <input id="link-rename-input" type="text" value="${escapeHtml(proposedTitle)}" autocomplete="off">
    </label><div id="link-tools-preview"></div>`;
    const input = this.els.content.querySelector('#link-rename-input');
    input.addEventListener('input', () => this.#previewRename(input.value));
    this.#previewRename(input.value);
    this.#present();
  }

  showMention(mention) {
    this.#begin('mention', structuredClone(mention));
    this.els.title.textContent = 'Convert mention to wikilink';
    this.els.apply.hidden = false;
    this.els.apply.textContent = 'Convert mention';
    this.plan = this.links.planMentionConversion(mention);
    this.els.content.innerHTML = this.plan.valid
      ? `<div class="link-tools__summary">
          <p><strong>Source:</strong> ${escapeHtml(this.plan.sourceTitle)}</p>
          <p><strong>Target:</strong> ${escapeHtml(this.plan.targetTitle)}</p>
          ${this.plan.heading ? `<p><strong>Heading:</strong> ${escapeHtml(this.plan.heading)}</p>` : ''}
          <p class="link-tools__snippet">${escapeHtml(this.plan.snippet)}</p>
          <p><code>${escapeHtml(this.plan.text)}</code> → <code>${escapeHtml(this.plan.replacement)}</code></p>
          <p class="muted">No data changes until you choose Convert mention. A local safety revision is required first.</p>
        </div>`
      : `<p class="link-tools__error" role="alert">${escapeHtml(this.plan.message)}</p>`;
    this.#setPlanState();
    this.#present();
  }

  showAliasRemoval(noteId, alias) {
    this.#begin('alias-repair', { noteId, alias });
    this.els.title.textContent = 'Remove conflicting alias';
    this.els.apply.hidden = false;
    this.els.apply.textContent = 'Remove alias';
    this.plan = this.links.planAliasRemoval(noteId, alias);
    this.els.content.innerHTML = this.plan.valid
      ? `<div class="link-tools__summary">
          <p>Remove alias <strong>“${escapeHtml(this.plan.alias)}”</strong> from <strong>${escapeHtml(this.plan.noteTitle)}</strong>?</p>
          <p class="muted">The canonical title and Markdown stay unchanged. No data changes until you choose Remove alias. A local safety revision is required first.</p>
        </div>`
      : `<p class="link-tools__error" role="alert">${escapeHtml(this.plan.message)}</p>`;
    this.#setPlanState();
    this.#present();
  }

  showReport() {
    this.#begin('report', null);
    this.plan = null;
    this.els.title.textContent = 'Link integrity report';
    this.els.apply.hidden = true;
    const report = this.integrityReport();
    this.els.content.innerHTML = report.healthy
      ? '<p class="link-tools__healthy">No ambiguous canonical titles or aliases were found.</p>'
      : `<p class="muted">Ambiguous imported names are never guessed. Use the repair actions below; destructive rewrites involving a name stay blocked until it resolves uniquely.</p>
        <ul class="link-tools__ambiguities">${report.ambiguities
          .map(
            (entry) => `<li>
          <strong>${escapeHtml(ambiguityLabel(entry.kind))}: “${escapeHtml(entry.name)}”</strong>
          <ul>${entry.notes
            .map(
              (note) => `<li>${escapeHtml(note.title)} <code>${escapeHtml(note.id)}</code>
            <span class="link-tools__repair-actions">
              ${note.canonical ? `<button type="button" class="btn btn--ghost" data-repair-rename="${escapeHtml(note.id)}">Rename note</button>` : ''}
              ${(note.aliases || []).map((alias) => `<button type="button" class="btn btn--ghost" data-repair-alias="${escapeHtml(note.id)}" data-alias="${escapeHtml(alias)}">Remove alias “${escapeHtml(alias)}”</button>`).join('')}
            </span>
          </li>`,
            )
            .join('')}</ul>
        </li>`,
          )
          .join('')}</ul>`;
    this.els.status.textContent = report.healthy
      ? 'Link resolution is healthy.'
      : `${report.ambiguities.length} ambiguity group${report.ambiguities.length === 1 ? '' : 's'} need repair.`;
    this.#present();
  }

  #begin(mode, intent) {
    this.epoch++;
    this.mode = mode;
    this.intent = intent;
    this.stale = false;
    if (this.els.refresh) this.els.refresh.hidden = true;
  }

  close() {
    this.epoch++;
    this.modal.close();
  }

  async #refresh() {
    if (this.busy || !this.intent) return;
    const epoch = this.epoch;
    const mode = this.mode;
    const intent = structuredClone(this.intent);
    this.busy = true;
    this.#syncApply();
    this.els.status.textContent = 'Refreshing saved notes for a new preview…';
    try {
      await this.refreshPreview?.();
      if (epoch !== this.epoch || !this.open) return;
      this.busy = false;
      if (mode === 'rename') this.showRename(intent.noteId, intent.proposedTitle);
      else if (mode === 'alias-repair') this.showAliasRemoval(intent.noteId, intent.alias);
      else this.showMention(intent);
    } catch (error) {
      if (epoch === this.epoch && this.open) this.els.status.textContent = error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncApply();
    }
  }

  #syncApply() {
    this.els.apply.disabled = this.busy || this.stale || !this.plan?.valid;
    if (this.els.refresh) {
      this.els.refresh.hidden = !this.stale;
      this.els.refresh.disabled = this.busy;
    }
    this.els.content.querySelectorAll('input, button').forEach((control) => {
      control.disabled = this.busy;
    });
  }

  #present() {
    if (this.modal.isOpen) this.modal.focusInitial();
    else this.modal.open();
  }

  #initialFocus() {
    return this.els.content.querySelector('input') || this.els.apply || this.modal.panel;
  }

  #previewRename(value) {
    this.epoch++;
    this.intent.proposedTitle = value;
    this.plan = this.links.planRename(this.noteId, value);
    const preview = this.els.content.querySelector('#link-tools-preview');
    if (!preview) return;
    if (!this.plan.valid) {
      preview.innerHTML = `<p class="link-tools__error" role="alert">${escapeHtml(this.plan.message)}</p>`;
    } else {
      preview.innerHTML = `<div class="link-tools__summary">
        <p><strong>${escapeHtml(this.plan.oldTitle)}</strong> → <strong>${escapeHtml(this.plan.newTitle)}</strong></p>
        <p>${this.plan.linkCount} exact inbound link${this.plan.linkCount === 1 ? '' : 's'} across ${this.plan.affected.length} protected note${this.plan.affected.length === 1 ? '' : 's'}.</p>
        <ul>${this.plan.affected.map((note) => `<li>${escapeHtml(note.title)} — ${note.linkCount} link${note.linkCount === 1 ? '' : 's'}</li>`).join('')}</ul>
        <p class="muted">${
          this.plan.repairMode
            ? 'This repairs one duplicated imported title. Ambiguous old targets are not rewritten or retained as an alias.'
            : 'The previous title becomes an alias. Display text, fragments, embeds, code, escaped text, and unrelated prose remain unchanged.'
        } No data changes until Apply rename.</p>
      </div>`;
    }
    this.#setPlanState();
  }

  #setPlanState() {
    this.#syncApply();
    this.els.status.textContent = this.plan?.valid
      ? 'Preview ready. No data has been changed.'
      : this.plan?.message || '';
  }

  async #apply() {
    if (!this.plan?.valid || this.busy || this.stale) return;
    const plan = this.plan;
    const mode = this.mode;
    const epoch = this.epoch;
    this.busy = true;
    this.#syncApply();
    this.els.status.textContent =
      mode === 'rename'
        ? 'Applying atomic rename…'
        : mode === 'alias-repair'
          ? 'Removing conflicting alias…'
          : 'Converting mention…';
    try {
      const result =
        mode === 'rename'
          ? await this.links.applyRenamePlan(plan)
          : mode === 'alias-repair'
            ? await this.links.applyAliasRemovalPlan(plan)
            : await this.links.applyMentionPlan(plan);
      if (epoch !== this.epoch || !this.open) return;
      this.plan = null;
      this.els.status.textContent =
        mode === 'rename'
          ? `Rename completed. ${result.linkCount} link${result.linkCount === 1 ? '' : 's'} updated.`
          : mode === 'alias-repair'
            ? `Alias “${result.alias}” removed.`
            : 'Mention converted to a wikilink.';
      this.els.apply.hidden = true;
      this.els.content.insertAdjacentHTML(
        'beforeend',
        '<p class="link-tools__healthy" tabindex="-1">Change saved with a local safety revision.</p>',
      );
      this.els.content.querySelector('.link-tools__healthy')?.focus();
      this.onApplied({ mode, result });
    } catch (error) {
      if (epoch !== this.epoch || !this.open) return;
      this.stale = error?.code === 'stale_plan';
      this.els.status.textContent = this.stale
        ? 'Notes changed. Refresh the preview and review it before applying.'
        : error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncApply();
    }
  }
}
