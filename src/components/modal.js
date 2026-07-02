// A small accessible-modal controller shared by the Trash and command-palette
// overlays. It makes the rest of the app `inert` while open, traps Tab within
// the `.modal__panel`, moves focus in on open, and restores focus to the
// trigger (or the menu button) on close. Close on Esc, backdrop, or any
// [data-close] control. No dependencies; framework-free.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Reference count so the shared `inert` on the background is only removed when the
// LAST open modal closes — overlapping modals can't prematurely un-inert the app.
let openModalCount = 0;

export class Modal {
  /**
   * @param {HTMLElement} overlay  the fixed backdrop container (holds .modal__panel)
   * @param {{ onEscape?:()=>void, initialFocus?:(HTMLElement|string|(()=>HTMLElement)) }} [opts]
   */
  constructor(overlay, { onEscape, initialFocus } = {}) {
    this.overlay = overlay;
    this.onEscape = onEscape;
    this.initialFocus = initialFocus;
    this.isOpen = false;
    this._returnFocus = null;

    this.__onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't let the app's global Escape (e.g. exit graph) also fire
        (this.onEscape || (() => this.close()))();
      } else if (e.key === 'Tab') {
        this.#trapTab(e);
      }
    };
    this.overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.close();
    });
  }

  get panel() {
    return this.overlay.querySelector('.modal__panel');
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._returnFocus = document.activeElement;
    this.overlay.hidden = false;
    openModalCount += 1;
    if (openModalCount === 1) this.#background()?.setAttribute('inert', ''); // freeze the app behind the modal
    document.addEventListener('keydown', this.__onKey, true);
    this.focusInitial();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.hidden = true;
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) this.#background()?.removeAttribute('inert');
    document.removeEventListener('keydown', this.__onKey, true);
    this.#restoreFocus();
  }

  /** (Re)apply the initial focus — call after rebuilding panel contents. */
  focusInitial() {
    const el = this.#resolveInitial();
    if (el && typeof el.focus === 'function') el.focus();
  }

  // --- internals ----------------------------------------------------------

  #background() {
    return document.getElementById('app');
  }

  #focusables() {
    const root = this.panel || this.overlay;
    return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  }

  #resolveInitial() {
    const f = this.initialFocus;
    let el = null;
    if (typeof f === 'function') el = f();
    else if (typeof f === 'string') el = (this.panel || this.overlay).querySelector(f);
    else if (f) el = f;
    if (!el || el.offsetParent === null) el = this.panel || this.#focusables()[0] || null;
    return el;
  }

  #restoreFocus() {
    const prev = this._returnFocus;
    this._returnFocus = null;
    const usable = prev && prev.isConnected && prev.offsetParent !== null && typeof prev.focus === 'function';
    if (usable) prev.focus();
    else document.getElementById('menu-btn')?.focus?.(); // trigger may live in a now-closed menu
  }

  #trapTab(e) {
    const items = this.#focusables();
    const panel = this.panel;
    if (items.length === 0) { e.preventDefault(); panel?.focus?.(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
