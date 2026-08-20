import './phase6.css';
import { Modal } from './modal.js';
import { buildClipperBookmarklet } from '../utils/clipper.js';

export function createClipperElements(root = document.body) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'clipper-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-close></div>
    <div class="modal__panel clipper-modal" role="dialog" aria-modal="true" aria-labelledby="clipper-title" tabindex="-1">
      <header class="modal__header"><div><h2 class="modal__title" id="clipper-title">NoteForge web clipper</h2><p class="muted">Save this bookmark, then use it on a page you want to capture.</p></div><button type="button" class="btn btn--ghost" data-close aria-label="Close web clipper">✕</button></header>
      <div class="clipper-view">
        <ol><li>Drag <strong>Clip to NoteForge</strong> to your bookmarks bar.</li><li>Use it on any http or https page.</li><li>Review the text and destination in Quick Capture, then choose Save capture.</li></ol>
        <a class="btn btn--primary clipper-bookmarklet" draggable="true">Clip to NoteForge</a>
        <p class="muted">Large pages use a clipboard handoff because browsers limit bookmarklet URLs. Nothing is sent to a server.</p>
        <label class="clipper-source">Bookmarklet source<textarea readonly rows="4" spellcheck="false"></textarea></label>
      </div>
      <footer class="recovery-modal__footer"><span class="recovery-modal__status" role="status" aria-live="polite"></span><div class="modal__actions"><button type="button" class="btn btn--ghost" data-copy>Copy bookmarklet</button><button type="button" class="btn btn--ghost" data-close>Close</button></div></footer>
    </div>`;
  root.appendChild(overlay);
  return {
    overlay,
    link: overlay.querySelector('.clipper-bookmarklet'),
    source: overlay.querySelector('textarea'),
    status: overlay.querySelector('[role="status"]'),
    copy: overlay.querySelector('[data-copy]'),
  };
}

export class ClipperView {
  constructor(els, { appUrl, writeClipboard } = {}) {
    this.els = els;
    this.appUrl = appUrl || window.location.href;
    this.writeClipboard = writeClipboard || ((text) => navigator.clipboard?.writeText?.(text));
    this.modal = new Modal(els.overlay, { initialFocus: () => this.els.link });
    this.els.copy.addEventListener('click', () => void this.#copy());
  }

  get open() { return this.modal.isOpen; }

  show() {
    const value = buildClipperBookmarklet(this.appUrl);
    this.els.link.href = value;
    this.els.source.value = value;
    this.els.status.textContent = '';
    this.modal.open();
  }

  close() { this.modal.close(); }

  async #copy() {
    try {
      const result = this.writeClipboard(this.els.source.value);
      if (!result || typeof result.then !== 'function') throw new Error('Clipboard permission is unavailable.');
      await result;
      this.els.status.textContent = 'Bookmarklet copied. Create a bookmark and paste it into the address field.';
    } catch (error) {
      this.els.source.focus();
      this.els.source.select();
      this.els.status.textContent = `${error?.message || 'Clipboard permission is unavailable.'} Copy the selected source manually.`;
    }
  }
}
