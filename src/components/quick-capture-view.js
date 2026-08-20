import './quick-capture-view.css';
import { Modal } from './modal.js';
import { buildCaptureMarkdown } from '../utils/capture.js';
import { escapeHtml } from '../utils/helpers.js';
import { fileToBannerDataURL } from '../utils/image.js';
import { localDateKey } from '../utils/local-date.js';

export function createQuickCaptureElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'quick-capture-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel quick-capture-modal" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="quick-capture-title">Quick Capture</h2><p class="muted">Route text, a link, clipboard content, or one local image into your vault.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close Quick Capture">✕</button></header>
      <form id="quick-capture-form" class="quick-capture-form">
        <label>Shared title<input id="capture-title" maxlength="300" autocomplete="off" placeholder="Optional label for a link"></label>
        <label>Text<textarea id="capture-text" rows="6" maxlength="100000" placeholder="What do you want to remember?"></textarea></label>
        <div class="quick-capture-inline"><label>URL<input id="capture-url" type="url" maxlength="2048" inputmode="url" placeholder="https://…"></label><button type="button" class="btn btn--ghost" data-read-clipboard>Paste clipboard</button></div>
        <label>Local image<input id="capture-image" type="file" accept="image/*"><span class="muted">Images are resized locally and stored inside Markdown. Shared binary files use this picker.</span></label>
        <label>Destination<select id="capture-destination"></select></label>
        <label id="capture-new-title-row" hidden>New note title<input id="capture-new-title" maxlength="120" autocomplete="off"></label>
        <footer class="quick-capture-footer"><span id="quick-capture-status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-close>Close</button><button type="submit" class="btn btn--primary">Save capture</button></div></footer>
      </form>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    form: overlay.querySelector('#quick-capture-form'),
    title: overlay.querySelector('#capture-title'),
    text: overlay.querySelector('#capture-text'),
    url: overlay.querySelector('#capture-url'),
    image: overlay.querySelector('#capture-image'),
    destination: overlay.querySelector('#capture-destination'),
    newTitleRow: overlay.querySelector('#capture-new-title-row'),
    newTitle: overlay.querySelector('#capture-new-title'),
    status: overlay.querySelector('#quick-capture-status'),
  };
}

export class QuickCaptureView {
  constructor(els, db, service, { readClipboard, onSaved = () => {} } = {}) {
    this.els = els;
    this.db = db;
    this.service = service;
    this.readClipboard = readClipboard || (() => navigator.clipboard?.readText?.());
    this.onSaved = onSaved;
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.text });
    this.els.form.addEventListener('submit', (event) => { event.preventDefault(); void this.#save(); });
    this.els.destination.addEventListener('change', () => this.#syncDestination());
    this.els.overlay.querySelector('[data-read-clipboard]').addEventListener('click', () => this.#pasteClipboard());
  }

  get open() { return this.modal.isOpen; }

  show({ payload = null, destinationId = null } = {}) {
    this.#renderDestinations(destinationId);
    this.els.title.value = payload?.title || '';
    this.els.text.value = payload?.text || '';
    this.els.url.value = payload?.url || '';
    this.els.image.value = '';
    this.els.newTitle.value = payload?.title || `Capture ${localDateKey()}`;
    this.els.status.textContent = payload ? 'Shared content is ready to review. Nothing is saved until you choose Save capture.' : '';
    this.#syncDestination();
    this.modal.open();
  }

  close() { this.modal.close(); }

  #renderDestinations(destinationId) {
    const notes = this.db.getAllNotes().slice().sort((a, b) => a.title.localeCompare(b.title));
    this.els.destination.innerHTML = '<option value="inbox">Inbox (create if needed)</option>'
      + notes.map((note) => `<option value="existing:${escapeHtml(note.id)}">${escapeHtml(note.title || 'Untitled')}</option>`).join('')
      + '<option value="new">New note…</option>';
    if (destinationId && notes.some((note) => note.id === destinationId)) this.els.destination.value = `existing:${destinationId}`;
    else this.els.destination.value = 'inbox';
  }

  #syncDestination() {
    this.els.newTitleRow.hidden = this.els.destination.value !== 'new';
  }

  async #pasteClipboard() {
    try {
      const text = await this.readClipboard();
      if (typeof text !== 'string' || !text) throw new Error('The clipboard did not contain text.');
      this.els.text.value = [this.els.text.value, text].filter(Boolean).join(this.els.text.value ? '\n\n' : '');
      this.els.status.textContent = 'Clipboard text added. Review it before saving.';
      this.els.text.focus();
    } catch (error) {
      this.els.status.textContent = `Clipboard access was unavailable. Paste into the Text field instead. ${error?.message || ''}`.trim();
    }
  }

  async #save() {
    const submit = this.els.form.querySelector('[type="submit"]');
    submit.disabled = true;
    this.els.status.textContent = 'Preparing capture…';
    try {
      const file = this.els.image.files?.[0] || null;
      const imageDataUrl = file ? await fileToBannerDataURL(file) : '';
      const markdown = buildCaptureMarkdown({
        title: this.els.title.value,
        text: this.els.text.value,
        url: this.els.url.value,
        imageDataUrl,
        imageAlt: file?.name?.replace(/\.[^.]+$/, '') || '',
      });
      const selected = this.els.destination.value;
      const destination = selected === 'new' ? 'new' : selected.startsWith('existing:') ? 'existing' : 'inbox';
      const result = await this.service.save({
        destination,
        noteId: destination === 'existing' ? selected.slice('existing:'.length) : null,
        newTitle: this.els.newTitle.value,
        markdown,
      });
      this.els.status.textContent = `Saved to “${result.note.title}”.`;
      this.els.text.value = '';
      this.els.url.value = '';
      this.els.image.value = '';
      this.onSaved(result);
    } catch (error) {
      this.els.status.textContent = error?.message || String(error);
    } finally {
      submit.disabled = false;
    }
  }
}
