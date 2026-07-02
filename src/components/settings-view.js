// Settings modal. Reads/writes the Database config and calls onApply with the
// normalized settings so the app can apply theme / font / width / autosave /
// default-template live. Focus/inert/keyboard handling come from the shared Modal.

import { Modal } from './modal.js';
import { normalizeSettings } from '../ui/settings.js';

const field = (id, label, options, value) => `
  <label class="settings__row">
    <span class="settings__label">${label}</span>
    <select class="settings__select" id="${id}">
      ${options.map((o) => `<option value="${o.value}"${String(o.value) === String(value) ? ' selected' : ''}>${o.label}</option>`).join('')}
    </select>
  </label>`;

export class SettingsView {
  /**
   * @param {{ overlay:HTMLElement, form:HTMLElement }} els
   * @param {import('../core/database.js').Database} db
   * @param {(settings:object)=>void} onApply
   */
  constructor(els, db, onApply) {
    this.els = els;
    this.db = db;
    this.onApply = onApply;
    this.modal = new Modal(els.overlay);
    this.els.form.addEventListener('change', () => this.#apply());
  }

  get open() {
    return this.modal.isOpen;
  }

  show() {
    this.#render();
    this.modal.open();
  }

  close() {
    this.modal.close();
  }

  toggle() {
    this.modal.isOpen ? this.close() : this.show();
  }

  #render() {
    const s = normalizeSettings(this.db.config);
    this.els.form.innerHTML =
      field('set-theme', 'Theme', [
        { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
      ], s.themeMode) +
      field('set-font', 'Editor font size', [
        { value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' },
      ], s.fontScale) +
      field('set-width', 'Editor width', [
        { value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full width' },
      ], s.editorWidth) +
      field('set-autosave', 'Autosave delay', [
        { value: '250', label: 'Fast (0.25s)' }, { value: '400', label: 'Normal (0.4s)' }, { value: '800', label: 'Relaxed (0.8s)' },
      ], String(s.autosaveMs)) +
      field('set-template', 'Default new note', [
        { value: 'none', label: 'Blank' }, { value: 'daily', label: 'Daily note' }, { value: 'meeting', label: 'Meeting note' }, { value: 'project', label: 'Project note' },
      ], s.defaultTemplate);
  }

  #apply() {
    const val = (id) => this.els.form.querySelector('#' + id)?.value;
    const clean = normalizeSettings({
      ...this.db.config,
      themeMode: val('set-theme'),
      fontScale: val('set-font'),
      editorWidth: val('set-width'),
      autosaveMs: Number(val('set-autosave')),
      defaultTemplate: val('set-template'),
    });
    this.db.setConfig(clean);
    this.onApply?.(clean);
  }
}
