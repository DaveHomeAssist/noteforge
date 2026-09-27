// In-app replacements for window.alert() and window.confirm() (NoteForge 2,
// Phase 1). Native dialogs block the page, cannot be styled or themed, and
// cannot offer an undo. This module is loaded lazily on first use.
//
//   confirmDialog({ title, message, confirmLabel, cancelLabel, danger })
//     -> Promise<boolean>. An accessible alertdialog on the shared Modal
//        controller (stacks over other dialogs, traps focus, Escape and the
//        backdrop cancel, focus returns to the trigger). Calls queue.
//   toast(message, { tone: 'info' | 'success' | 'error', action, duration })
//     -> { dismiss }. A non-blocking notice with an optional action (Undo).
// Callers that accept an injected confirmer use whenConfirmed()
// (src/utils/when-confirmed.js) to handle both sync and async answers.

import { Modal } from '../components/modal.js';
import './dialogs.css';

let confirmUi = null;
let queue = Promise.resolve();

function buildConfirm() {
  const overlay = document.createElement('div');
  overlay.id = 'confirm-dialog';
  overlay.className = 'modal confirm-dialog';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal__backdrop" data-confirm-cancel></div><div class="modal__panel confirm-dialog__panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" tabindex="-1"><h2 id="confirm-dialog-title" class="confirm-dialog__title"></h2><p id="confirm-dialog-message" class="confirm-dialog__message"></p><div class="confirm-dialog__actions"><button type="button" class="btn" data-confirm-cancel></button><button type="button" class="btn btn--primary" data-confirm-accept></button></div></div>`;
  document.body.append(overlay);
  const els = {
    overlay,
    title: overlay.querySelector('#confirm-dialog-title'),
    message: overlay.querySelector('#confirm-dialog-message'),
    cancel: overlay.querySelector('.confirm-dialog__actions [data-confirm-cancel]'),
    accept: overlay.querySelector('[data-confirm-accept]'),
  };
  return { els, modal: new Modal(overlay) };
}

/** @returns {Promise<boolean>} */
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  const run = () =>
    new Promise((resolve) => {
      confirmUi ||= buildConfirm();
      const { els, modal } = confirmUi;
      els.title.textContent = title;
      els.message.textContent = message;
      els.accept.textContent = confirmLabel;
      els.cancel.textContent = cancelLabel;
      els.accept.classList.toggle('btn--primary', !danger);
      els.accept.classList.toggle('btn--danger', danger);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        els.overlay.removeEventListener('click', onClick);
        modal.close();
        resolve(value);
      };
      const onClick = (event) => {
        if (event.target.closest('[data-confirm-accept]')) finish(true);
        else if (event.target.closest('[data-confirm-cancel]')) finish(false);
      };
      els.overlay.addEventListener('click', onClick);
      modal.onEscape = () => finish(false);
      // Focus the least destructive choice first (WAI-ARIA alertdialog pattern).
      modal.initialFocus = danger ? els.cancel : els.accept;
      modal.open();
    });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

let region = null;

function toastRegion() {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.className = 'toasts';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-label', 'Notifications');
  document.body.append(region);
  return region;
}

/** @returns {{ dismiss: () => void }} */
export function toast(message, { tone = 'info', action = null, duration } = {}) {
  const host = toastRegion();
  const item = document.createElement('div');
  item.className = `toast toast--${tone}`;
  if (tone === 'error') item.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.className = 'toast__message';
  text.textContent = message;
  item.append(text);
  let timer = 0;
  const stop = () => clearTimeout(timer);
  const dismiss = () => {
    stop();
    item.remove();
  };
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast__action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      dismiss();
      action.run();
    });
    item.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', dismiss);
  item.append(close);
  const ms = duration ?? (action ? 10_000 : tone === 'error' ? 8_000 : 5_000);
  const start = () => {
    stop();
    timer = setTimeout(dismiss, ms);
  };
  item.addEventListener('pointerenter', stop);
  item.addEventListener('pointerleave', start);
  item.addEventListener('focusin', stop);
  item.addEventListener('focusout', start);
  // A live region announces changes, not its own creation: insert on the next
  // frame when the region was only just added.
  requestAnimationFrame(() => {
    host.append(item);
    start();
  });
  return { dismiss };
}
