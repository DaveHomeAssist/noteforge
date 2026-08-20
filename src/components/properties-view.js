import './properties-view.css';
import { Modal } from './modal.js';
import { escapeHtml } from '../utils/helpers.js';
import { inferPropertyType } from '../utils/frontmatter.js';

export function createPropertiesElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'properties-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div><div class="modal__panel properties-modal" role="dialog" aria-modal="true" aria-labelledby="properties-title" tabindex="-1">
    <header class="modal__header"><div><h2 class="modal__title" id="properties-title">Note properties</h2><p class="muted">Portable YAML stored in this note’s Markdown.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close note properties">✕</button></header>
    <div class="properties-modal__body">
      <div class="properties-list" role="list" aria-label="Current properties"></div>
      <form class="properties-form" aria-describedby="properties-status">
        <fieldset><legend>Add or edit a property</legend><label>Property name<input name="key" maxlength="128" required></label><label>Type<select name="type"><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">ISO date</option><option value="url">URL</option><option value="select">Single select</option><option value="multi-select">Multi select</option></select></label><label>Value<input name="value" required></label><button type="submit" class="btn btn--primary">Save property</button></fieldset>
      </form>
      <form class="properties-raw-form" aria-describedby="properties-status"><label>Raw YAML frontmatter<textarea name="raw" rows="8" spellcheck="false"></textarea></label><p class="muted">Includes the opening and closing delimiters. The Markdown body is never rewritten.</p><button type="submit" class="btn btn--ghost">Apply raw YAML source</button></form>
    </div>
    <footer class="properties-modal__footer"><span id="properties-status" role="status" aria-live="polite"></span><button type="button" class="btn btn--ghost" data-close>Close</button></footer>
  </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    list: overlay.querySelector('.properties-list'),
    form: overlay.querySelector('.properties-form'),
    fieldset: overlay.querySelector('.properties-form fieldset'),
    rawForm: overlay.querySelector('.properties-raw-form'),
    status: overlay.querySelector('#properties-status'),
  };
}

function displayValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export class PropertiesView {
  constructor(els, service) {
    this.els = els;
    this.service = service;
    this.noteId = null;
    this.parsed = null;
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.form.elements.key });
    els.form.addEventListener('submit', (event) => void this.#save(event));
    els.rawForm.addEventListener('submit', (event) => void this.#saveRaw(event));
    els.list.addEventListener('click', (event) => void this.#listAction(event));
    els.form.elements.type.addEventListener('change', () => this.#syncValueControl());
  }

  get open() { return this.modal.isOpen; }

  async show(noteId) {
    this.noteId = noteId;
    this.els.status.textContent = 'Loading properties…';
    this.modal.open();
    await this.refresh();
  }

  async refresh({ focusKey = false } = {}) {
    this.parsed = await this.service.read(this.noteId);
    const parsed = this.parsed;
    const invalid = parsed.status === 'invalid';
    this.els.fieldset.disabled = invalid;
    this.els.rawForm.elements.raw.value = parsed.split.raw || '';
    if (invalid) {
      const issue = parsed.diagnostics[0];
      this.els.status.textContent = `${issue?.message || 'Invalid YAML'}${issue?.line ? ` (line ${issue.line}${issue.column ? `, column ${issue.column}` : ''})` : ''}. Fix the raw source before editing properties.`;
    } else {
      this.els.status.textContent = parsed.status === 'none' ? 'This note has no frontmatter yet.' : `${parsed.properties.size} propert${parsed.properties.size === 1 ? 'y' : 'ies'}.`;
    }
    this.#renderList();
    if (focusKey && !invalid) this.els.form.elements.key.focus();
  }

  #renderList() {
    const entries = this.parsed?.status === 'valid' ? [...this.parsed.properties] : [];
    this.els.list.innerHTML = entries.length ? entries.map(([key, value]) => {
      const type = inferPropertyType(value, String(key));
      const immutable = key === 'noteforge_id';
      return `<div class="properties-row" role="listitem"><div><strong>${escapeHtml(key)}</strong><span class="properties-row__type">${escapeHtml(type)}</span><code>${escapeHtml(displayValue(value))}</code></div><div class="properties-row__actions">${type === 'unsupported' || immutable ? '' : `<button type="button" class="btn btn--ghost" data-property-edit="${escapeHtml(key)}">Edit</button>`}<button type="button" class="btn btn--danger-ghost" data-property-delete="${escapeHtml(key)}" ${immutable ? 'disabled title="noteforge_id is immutable"' : ''}>Remove</button></div></div>`;
    }).join('') : '<p class="muted">No editable properties.</p>';
  }

  async #save(event) {
    event.preventDefault();
    const form = this.els.form;
    this.els.status.textContent = 'Saving property…';
    try {
      await this.service.set(this.noteId, form.elements.key.value, form.elements.value.value, form.elements.type.value);
      await this.refresh();
      form.reset();
      this.#syncValueControl();
      form.elements.key.focus();
      this.els.status.textContent = 'Property saved to Markdown.';
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
      form.elements.value.setAttribute('aria-invalid', 'true');
      form.elements.value.focus();
    }
  }

  async #saveRaw(event) {
    event.preventDefault();
    this.els.status.textContent = 'Saving raw YAML source…';
    try {
      await this.service.replaceRaw(this.noteId, this.els.rawForm.elements.raw.value);
      await this.refresh();
      this.els.status.textContent = this.parsed.status === 'invalid' ? this.els.status.textContent : 'Raw YAML source saved.';
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
      this.els.rawForm.elements.raw.focus();
    }
  }

  async #listAction(event) {
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
      try {
        await this.service.remove(this.noteId, remove.dataset.propertyDelete);
        await this.refresh();
        this.els.status.textContent = 'Property removed from Markdown.';
      } catch (error) {
        this.els.status.textContent = error?.message || String(error);
      }
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
