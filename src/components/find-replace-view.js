import './find-replace-view.css';
import { escapeHtml } from '../utils/helpers.js';
import { findLiteralMatches, replaceLiteral } from '../utils/find-replace.js';
import { BulkOperations } from '../core/bulk-operations.js';
import { icon } from '../ui/icons.js';

export function createFindReplaceElements(root = document.querySelector('.main')) {
  const panel = document.createElement('section');
  panel.className = 'find-replace';
  panel.id = 'find-replace-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'find-replace-title');
  panel.innerHTML = `<header><h2 id="find-replace-title">Find and replace</h2><div class="find-replace__scope" role="group" aria-label="Search scope"><button type="button" class="btn btn--ghost" data-scope="current" aria-pressed="true">Current note</button><button type="button" class="btn btn--ghost" data-scope="vault" aria-pressed="false">Vault</button></div><button type="button" class="btn btn--ghost" data-find-close aria-label="Close find and replace">${icon('x')}</button></header>
    <div class="find-replace__controls"><label>Find<input id="find-input" type="text" autocomplete="off"></label><label>Replace with<input id="replace-input" type="text" autocomplete="off"></label><label class="find-replace__check"><input id="find-case" type="checkbox"> Match case</label><label class="find-replace__check"><input id="find-word" type="checkbox"> Whole word</label><label class="find-replace__check find-replace__vault-option" hidden><input id="find-archive" type="checkbox"> Include Archive</label><label class="find-replace__check find-replace__vault-option" hidden><input id="find-trash" type="checkbox"> Include Trash</label></div>
    <div class="find-replace__actions"><button type="button" class="btn btn--ghost" data-find-prev>Previous</button><button type="button" class="btn btn--ghost" data-find-next>Next</button><button type="button" class="btn btn--ghost" data-find-preview>Preview</button><button type="button" class="btn btn--primary" data-find-apply disabled>Apply</button></div>
    <div class="find-replace__preview" role="region" aria-label="Replacement preview" tabindex="0" aria-live="polite"></div><footer><span class="find-replace__status" role="status" aria-live="polite"></span></footer>`;
  root?.insertBefore(panel, root.firstChild);
  return {
    panel,
    find: panel.querySelector('#find-input'),
    replacement: panel.querySelector('#replace-input'),
    caseSensitive: panel.querySelector('#find-case'),
    wholeWord: panel.querySelector('#find-word'),
    includeArchived: panel.querySelector('#find-archive'),
    includeTrash: panel.querySelector('#find-trash'),
    preview: panel.querySelector('.find-replace__preview'),
    status: panel.querySelector('.find-replace__status'),
    apply: panel.querySelector('[data-find-apply]'),
  };
}

export class FindReplaceView {
  constructor(els, db, editor, { confirmVaultApply = () => false, onApplied = () => {}, refreshPreview } = {}) {
    this.els = els;
    this.db = db;
    this.editor = editor;
    this.bulk = new BulkOperations(db);
    this.confirmVaultApply = confirmVaultApply;
    this.onApplied = onApplied;
    this.refreshPreview = refreshPreview;
    this.epoch = 0;
    this.busy = false;
    this.stale = false;
    this.scope = 'current';
    this.plan = null;
    this.matchIndex = -1;
    this.els.panel.addEventListener('click', (event) => this.#onClick(event));
    this.els.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    for (const input of [
      els.find,
      els.replacement,
      els.caseSensitive,
      els.wholeWord,
      els.includeArchived,
      els.includeTrash,
    ]) {
      const invalidate = () => {
        if (this.inputState !== this.#inputState()) this.#invalidate();
      };
      input.addEventListener('input', invalidate);
      input.addEventListener('change', invalidate);
    }
  }

  get open() {
    return !this.els.panel.hidden;
  }

  show({ scope = 'current' } = {}) {
    this.els.panel.hidden = false;
    this.#setScope(scope);
    this.els.find.focus();
    this.els.find.select();
  }

  close() {
    this.#invalidate();
    this.els.panel.hidden = true;
    this.els.status.textContent = '';
    this.editor.container.querySelector('.editor__title')?.focus();
  }

  #options() {
    return { caseSensitive: this.els.caseSensitive.checked, wholeWord: this.els.wholeWord.checked };
  }

  #setScope(scope) {
    this.scope = scope === 'vault' ? 'vault' : 'current';
    this.els.panel.querySelectorAll('[data-scope]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.scope === this.scope));
    });
    this.els.panel.querySelectorAll('.find-replace__vault-option').forEach((label) => {
      label.hidden = this.scope !== 'vault';
    });
    this.els.panel.querySelectorAll('[data-find-prev],[data-find-next]').forEach((button) => {
      button.hidden = this.scope !== 'current';
    });
    this.#invalidate();
  }

  #inputState() {
    return JSON.stringify([
      this.els.find.value,
      this.els.replacement.value,
      this.els.caseSensitive.checked,
      this.els.wholeWord.checked,
      this.els.includeArchived.checked,
      this.els.includeTrash.checked,
    ]);
  }

  #invalidate() {
    this.inputState = this.#inputState();
    this.epoch++;
    this.stale = false;
    this.plan = null;
    this.matchIndex = -1;
    this.els.apply.disabled = true;
    this.els.status.textContent = 'Choose Preview before applying changes.';
    this.els.preview.innerHTML = '<p class="muted">No data has been changed.</p>';
    this.#syncApply();
  }

  #onClick(event) {
    const scope = event.target.closest('[data-scope]');
    if (scope) return this.#setScope(scope.dataset.scope);
    if (event.target.closest('[data-find-close]')) return this.close();
    if (event.target.closest('[data-find-preview]')) return this.#preview();
    if (event.target.closest('[data-find-next]')) return this.#navigate(1);
    if (event.target.closest('[data-find-prev]')) return this.#navigate(-1);
    if (event.target.closest('[data-find-apply]')) return this.#apply();
  }

  #preview() {
    if (this.busy) return;
    this.inputState = this.#inputState();
    if (this.scope === 'vault') return this.#previewVault();
    const note = this.editor.currentId ? this.db.getNote(this.editor.currentId) : null;
    if (!note) {
      this.els.status.textContent = 'Open an active note first.';
      return;
    }
    this.plan = {
      ...replaceLiteral(
        this.editor.getSourceMarkdown(),
        this.els.find.value,
        this.els.replacement.value,
        this.#options(),
      ),
      noteId: note.id,
    };
    this.els.apply.disabled = !this.plan.changed;
    this.els.preview.innerHTML = `<p><strong>${this.plan.count}</strong> source match${this.plan.count === 1 ? '' : 'es'} in “${escapeHtml(note.title)}”.</p><p class="muted">Replacement edits Markdown source and remains one editor undo step. No data has been changed.</p>`;
    this.els.status.textContent = this.plan.count ? 'Preview ready.' : 'No matches in the current note.';
  }

  async #previewVault() {
    const epoch = ++this.epoch;
    const options = {
      query: this.els.find.value,
      replacement: this.els.replacement.value,
      ...this.#options(),
      includeArchived: this.els.includeArchived.checked,
      includeTrash: this.els.includeTrash.checked,
    };
    this.plan = null;
    this.busy = true;
    this.#syncApply();
    this.els.status.textContent = 'Refreshing saved notes for a new preview…';
    try {
      if (this.refreshPreview) await this.refreshPreview();
      if (epoch !== this.epoch || !this.open) return;
      this.stale = false;
      this.plan = this.bulk.planVaultReplace(options);
      this.#renderVaultPreview();
    } catch (error) {
      if (epoch === this.epoch && this.open) this.els.status.textContent = error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncApply();
    }
  }

  #syncApply() {
    this.els.apply.disabled =
      this.busy ||
      this.stale ||
      !(this.scope === 'vault' ? this.plan?.valid && this.plan.changed.length : this.plan?.changed);
    const preview = this.els.panel.querySelector('[data-find-preview]');
    if (preview) {
      preview.disabled = this.busy;
      preview.textContent = this.stale ? 'Refresh preview' : 'Preview';
    }
  }

  #renderVaultPreview() {
    if (!this.plan.valid) {
      this.els.preview.innerHTML = `<p class="find-replace__error" role="alert">${escapeHtml(this.plan.message)}</p>`;
      this.els.status.textContent = this.plan.message;
      return;
    }
    this.els.apply.disabled = this.plan.changed.length === 0;
    const affected = this.plan.changed
      .slice(0, 100)
      .map((note) => `<li>${escapeHtml(note.title)} — ${note.count} match${note.count === 1 ? '' : 'es'}</li>`)
      .join('');
    this.els.preview.innerHTML = `<p><strong>${this.plan.changed.length} changed</strong> · ${this.plan.unchanged.length} unchanged · ${this.plan.skipped.length} skipped · 0 failed</p>${affected ? `<ul>${affected}</ul>` : ''}<p class="muted">No data has been changed. Apply requires confirmation and a pre-change revision for every affected note.</p>`;
    this.els.status.textContent = this.plan.changed.length ? 'Vault preview ready.' : 'No vault notes would change.';
  }

  #editableMatches() {
    const matches = [];
    for (const entry of this.editor.findEntries()) {
      for (const match of findLiteralMatches(entry.text, this.els.find.value, this.#options()))
        matches.push({ ...match, blockId: entry.id });
    }
    return matches;
  }

  #navigate(direction) {
    if (!this.plan) this.#preview();
    const matches = this.#editableMatches();
    if (!matches.length) {
      this.els.status.textContent =
        'No editable text matches. Matches inside Markdown markers remain visible in Preview.';
      return;
    }
    this.matchIndex = (this.matchIndex + direction + matches.length) % matches.length;
    const match = matches[this.matchIndex];
    this.editor.selectFindRange(match.blockId, match.start, match.end);
    this.els.status.textContent = `Match ${this.matchIndex + 1} of ${matches.length}.`;
  }

  async #apply() {
    if (!this.plan || this.busy || this.stale) return;
    if (this.scope === 'current') {
      if (this.editor.currentId !== this.plan.noteId || this.editor.getSourceMarkdown() !== this.plan.source) {
        this.#preview();
        this.els.status.textContent = 'The note changed after Preview. Review the updated match count before applying.';
        return;
      }
      if (!this.plan.changed || !this.editor.applyFindReplacement(this.plan.result)) return;
      const count = this.plan.count;
      this.onApplied({ scope: 'current', count });
      this.#preview();
      this.els.status.textContent = `${count} replacement${count === 1 ? '' : 's'} applied. Use Undo in the editor to revert.`;
      return;
    }
    if (!this.plan.valid || !this.plan.changed.length) return;
    const plan = this.plan;
    const epoch = this.epoch;
    this.busy = true;
    this.#syncApply();
    try {
      const approved = await this.confirmVaultApply({
        message: `Apply replacements to ${plan.changed.length} note${plan.changed.length === 1 ? '' : 's'}? Every affected note requires a local safety revision first.`,
        plan,
      });
      if (epoch !== this.epoch || !this.open || plan !== this.plan) return;
      if (!approved) {
        this.els.status.textContent = 'Vault replacement cancelled.';
        return;
      }
      this.els.status.textContent = 'Applying revision-protected vault replacement…';
      const report = await this.bulk.applyVaultReplace(plan);
      if (epoch !== this.epoch || !this.open) return;
      this.plan = null;
      this.els.status.textContent = `${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.skipped.length} skipped · ${report.failed.length} failed.`;
      this.onApplied({ scope: 'vault', report });
    } catch (error) {
      if (epoch !== this.epoch || !this.open) return;
      this.stale = error?.code === 'stale_plan';
      if (this.stale) {
        this.plan = null;
        this.els.status.textContent = 'Notes changed. Refresh the preview and review it before applying.';
      } else {
        const report = error.report || { changed: [], unchanged: [], skipped: [], failed: plan.changed };
        this.els.status.textContent = `${error?.message || error} ${report.changed.length} changed · ${report.unchanged.length} unchanged · ${report.skipped.length} skipped · ${report.failed.length} failed.`;
      }
    } finally {
      this.busy = false;
      this.#syncApply();
    }
  }
}
