import './properties-view.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { inferPropertyType } from '../utils/frontmatter.js';
import { icon } from '../ui/icons.js';

export function createPropertiesElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'properties-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel properties-modal" role="dialog" aria-modal="true" aria-labelledby="properties-title" tabindex="-1">
    <header class="modal__header"><div><h2 class="modal__title" id="properties-title">Note properties</h2><p class="muted">Portable YAML stored in this note’s Markdown.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close note properties">${icon('x')}</button></header>
    <div class="properties-modal__body">
      <div class="properties-list" role="list" aria-label="Current properties"></div>
      <form class="properties-form" aria-describedby="properties-status">
        <fieldset><legend>Add or edit a property</legend><label>Property name<input name="key" maxlength="128" required></label><label>Type<select name="type"><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">ISO date</option><option value="url">URL</option><option value="select">Single select</option><option value="multi-select">Multi select</option></select></label><label>Value<input name="value" required></label><button type="submit" class="btn btn--primary">Save property</button></fieldset>
      </form>
      <details data-properties-current hidden><summary>Saved YAML after refresh</summary><pre></pre></details><form class="properties-raw-form" aria-describedby="properties-status"><label>Raw YAML frontmatter<textarea name="raw" rows="8" spellcheck="false"></textarea></label><p class="muted">Includes the opening and closing delimiters. The Markdown body is never rewritten.</p><button type="submit" class="btn btn--ghost">Apply raw YAML source</button></form>
    </div>
    <footer class="properties-modal__footer"><span id="properties-status" role="status" aria-live="polite"></span><button type="button" class="btn btn--ghost" data-properties-refresh hidden>Refresh saved properties</button><button type="button" class="btn btn--ghost" data-close>Close</button></footer>
  </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    list: overlay.querySelector('.properties-list'),
    form: overlay.querySelector('.properties-form'),
    fieldset: overlay.querySelector('.properties-form fieldset'),
    rawForm: overlay.querySelector('.properties-raw-form'),
    status: overlay.querySelector('#properties-status'),
    refresh: overlay.querySelector('[data-properties-refresh]'),
    current: overlay.querySelector('[data-properties-current]'),
  };
}

function displayValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class PropertiesView {
  constructor(els, service) {
    this.els = els;
    this.service = service;
    this.noteId = null;
    this.parsed = null;
    this.epoch = 0;
    this.loadVersion = 0;
    this.busy = false;
    this.loading = false;
    this.stale = false;
    this.modal = new Modal(els.overlay, {
      initialFocus: () => this.els.form.elements.key,
      onEscape: () => this.close(),
    });
    els.overlay.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
    });
    els.refresh?.addEventListener('click', () => {
      if (!this.busy && !this.loading) void this.refresh({ preserveDraft: true });
    });
    els.form.addEventListener('submit', (event) => void this.#save(event));
    els.rawForm.addEventListener('submit', (event) => void this.#saveRaw(event));
    els.list.addEventListener('click', (event) => void this.#listAction(event));
    els.form.elements.type.addEventListener('change', () => this.#syncValueControl());
  }

  get open() {
    return this.modal.isOpen;
  }

  async show(noteId) {
    this.epoch++;
    this.stale = false;
    this.parsed = null;
    this.els.form.reset();
    if (this.els.current) this.els.current.hidden = true;
    this.noteId = noteId;
    this.els.status.textContent = 'Loading properties…';
    this.modal.open();
    await this.refresh();
  }

  close() {
    this.epoch++;
    this.loadVersion++;
    this.loading = false;
    this.modal.close();
  }

  async refresh({ focusKey = false, preserveDraft = false } = {}) {
    const epoch = this.epoch;
    const version = ++this.loadVersion;
    const raw =
      preserveDraft && this.els.rawForm.elements.raw.value !== (this.parsed?.split.raw || '')
        ? this.els.rawForm.elements.raw.value
        : null;
    this.loading = true;
    this.#syncActions();
    try {
      await this.service.refreshPreview?.();
      if (epoch !== this.epoch || version !== this.loadVersion || !this.open) return;
      const parsed = await this.service.read(this.noteId);
      if (epoch !== this.epoch || version !== this.loadVersion || !this.open) return;
      this.parsed = parsed;
      this.stale = false;
      const invalid = parsed.status === 'invalid';
      this.els.rawForm.elements.raw.value = raw ?? parsed.split.raw ?? '';
      if (this.els.current) {
        this.els.current.hidden = raw === null;
        this.els.current.querySelector('pre').textContent = parsed.split.raw || '(No saved YAML)';
      }
      if (invalid) {
        const issue = parsed.diagnostics[0];
        this.els.status.textContent = `${issue?.message || 'Invalid YAML'}${issue?.line ? ` (line ${issue.line}${issue.column ? `, column ${issue.column}` : ''})` : ''}. Fix the raw source before editing properties.`;
      } else {
        this.els.status.textContent = preserveDraft
          ? 'Saved properties refreshed. Your draft is retained; review the saved values before applying it.'
          : parsed.status === 'none'
            ? 'This note has no frontmatter yet.'
            : `${parsed.properties.size} propert${parsed.properties.size === 1 ? 'y' : 'ies'}.`;
      }
      this.#renderList();
    } catch (error) {
      if (epoch === this.epoch && version === this.loadVersion && this.open) {
        this.stale = true;
        this.els.status.textContent = error?.message || String(error);
      }
    } finally {
      if (version === this.loadVersion) this.loading = false;
      this.#syncActions();
      if (epoch === this.epoch && version === this.loadVersion && this.open && focusKey && !this.stale)
        this.els.form.elements.key.focus();
      if (epoch === this.epoch && version === this.loadVersion && this.open && preserveDraft && !this.stale)
        this.els.rawForm.elements.raw.focus();
    }
  }

  #syncActions() {
    const disabled = this.busy || this.loading || this.stale || !this.parsed;
    this.els.fieldset.disabled = disabled || this.parsed?.status === 'invalid';
    this.els.rawForm.querySelector('button[type="submit"]').disabled = disabled;
    this.els.rawForm.elements.raw.disabled = this.busy || this.loading;
    this.els.list.querySelectorAll('button').forEach((button) => {
      button.disabled = disabled || button.dataset.propertyDelete === 'noteforge_id';
    });
    if (this.els.refresh) {
      this.els.refresh.hidden = !this.stale;
      this.els.refresh.disabled = this.busy || this.loading;
    }
  }

  #renderList() {
    const entries = this.parsed?.status === 'valid' ? [...this.parsed.properties] : [];
    this.els.list.innerHTML = entries.length
      ? entries
          .map(([key, value]) => {
            const type = inferPropertyType(value, String(key));
            const immutable = key === 'noteforge_id';
            return `<div class="properties-row" role="listitem"><div><strong>${escapeHtml(key)}</strong><span class="properties-row__type">${escapeHtml(type)}</span><code>${escapeHtml(displayValue(value))}</code></div><div class="properties-row__actions">${type === 'unsupported' || immutable ? '' : `<button type="button" class="btn btn--ghost" data-property-edit="${escapeHtml(key)}">Edit</button>`}<button type="button" class="btn btn--danger-ghost" data-property-delete="${escapeHtml(key)}" ${immutable ? 'disabled title="noteforge_id is immutable"' : ''}>Remove</button></div></div>`;
          })
          .join('')
      : '<p class="muted" role="listitem">No editable properties.</p>';
  }

  async #mutate(message, action, success, input = null) {
    if (this.busy || this.loading || this.stale || !this.parsed) return;
    const epoch = this.epoch;
    let focus = document.activeElement;
    input?.removeAttribute('aria-invalid');
    this.busy = true;
    this.#syncActions();
    this.els.status.textContent = message;
    try {
      await action();
      if (epoch !== this.epoch || !this.open) return;
      await this.refresh();
      if (epoch === this.epoch && this.open && !this.stale) success();
    } catch (error) {
      if (epoch !== this.epoch || !this.open) return;
      this.stale = ['stale_plan', 'stale_note'].includes(error?.code);
      if (this.stale) focus = this.els.refresh;
      else if (input) {
        input.setAttribute('aria-invalid', 'true');
        focus = input;
      }
      this.els.status.textContent = this.stale
        ? 'The note changed. Refresh saved properties and review your retained draft before applying.'
        : error?.message || String(error);
    } finally {
      this.busy = false;
      this.#syncActions();
      if (epoch === this.epoch && this.open && focus?.isConnected) focus.focus();
    }
  }

  async #save(event) {
    event.preventDefault();
    const form = this.els.form;
    const request = [
      this.noteId,
      form.elements.key.value,
      form.elements.value.value,
      form.elements.type.value,
      this.parsed?.review,
    ];
    await this.#mutate(
      'Saving property…',
      () => this.service.set(...request),
      () => {
        form.reset();
        this.#syncValueControl();
        this.els.status.textContent = 'Property saved to Markdown.';
      },
      form.elements.value,
    );
  }

  async #saveRaw(event) {
    event.preventDefault();
    const request = [this.noteId, this.els.rawForm.elements.raw.value, this.parsed?.review];
    await this.#mutate(
      'Saving raw YAML source…',
      () => this.service.replaceRaw(...request),
      () => {
        if (this.parsed.status !== 'invalid') this.els.status.textContent = 'Raw YAML source saved.';
      },
      this.els.rawForm.elements.raw,
    );
  }

  async #listAction(event) {
    if (this.busy || this.loading || this.stale || !this.parsed) return;
    const edit = event.target.closest('[data-property-edit]');
    const remove = event.target.closest('[data-property-delete]');
    if (edit) {
      const key = edit.dataset.propertyEdit;
      const value = this.parsed.properties.get(key);
      const type = inferPropertyType(value, key);
      this.els.form.elements.key.value = key;
      this.els.form.elements.type.value = type;
      this.els.form.elements.value.value = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      this.#syncValueControl();
      this.els.form.elements.value.focus();
    } else if (remove) {
      const request = [this.noteId, remove.dataset.propertyDelete, this.parsed.review];
      await this.#mutate(
        'Removing property…',
        () => this.service.remove(...request),
        () => {
          this.els.status.textContent = 'Property removed from Markdown.';
        },
      );
    }
  }

  #syncValueControl() {
    const input = this.els.form.elements.value;
    const type = this.els.form.elements.type.value;
    input.removeAttribute('aria-invalid');
    input.type = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'url' ? 'url' : 'text';
    input.placeholder = type === 'multi-select' ? 'Comma-separated values' : type === 'boolean' ? 'true or false' : '';
  }
}
