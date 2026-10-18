import './feature-actions.css';

import { FeatureLoader } from './feature-loader.js';

/** One pending opening owns the shell recovery surface, never the shared import. */
export class FeatureActions {
  constructor({ saveAndReload, exportDrafts }) {
    this.loader = new FeatureLoader();
    this.active = null;
    this.generation = 0;
    this.saveAndReload = saveAndReload;
    this.exportDrafts = exportDrafts;
    this.element = document.createElement('section');
    this.element.className = 'feature-status';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Feature loading and recovery');
    this.element.innerHTML = '<p id="feature-status" role="status" aria-live="polite"></p><div></div>';
    document.body.append(this.element);
    this.status = this.element.querySelector('p');
    this.controls = this.element.querySelector('div');
    this.events = new AbortController();
    const options = { capture: true, signal: this.events.signal };
    document.addEventListener(
      'pointerdown',
      (event) => {
        this.pointerTrigger = event.target.closest?.('button, [role="menuitem"]');
      },
      options,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.active) {
          const pending = this.active.state !== 'ready';
          this.cancel(pending || this.element.contains(document.activeElement));
          if (pending) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }
      },
      options,
    );
    document.addEventListener(
      'noteforge:modal-open',
      () => {
        if (this.active?.state !== 'ready') this.cancel();
      },
      { signal: this.events.signal },
    );
    window.addEventListener('pagehide', () => this.cancel(), { signal: this.events.signal });
  }
  cancel(restore = this.element.contains(document.activeElement)) {
    if (!this.active) return false;
    this.generation++;
    this.active.state = 'cancelled';
    const trigger = this.active.trigger;
    this.active = null;
    this.element.hidden = true;
    if (restore)
      (trigger?.isConnected && trigger.getClientRects().length
        ? trigger
        : document.getElementById('menu-btn')
      )?.focus();
    return true;
  }
  destroy() {
    this.cancel();
    this.events.abort();
    this.element.remove();
  }
  async run({ key, label, load, open, valid = () => true, payload = null }, retry = false) {
    this.cancel();
    const generation = ++this.generation;
    const request = {
      key,
      label,
      payload,
      state: 'loading',
      trigger: document.activeElement === document.body ? this.pointerTrigger : document.activeElement,
    };
    request.current = () => this.generation === generation && valid();
    request.commit = (action) => {
      if (!request.current()) return false;
      request.state = 'ready';
      request.committed = true;
      this.element.hidden = true;
      return action();
    };
    this.active = request;
    const spec = { key, label, load, open, valid, payload };
    this.#render(`Loading ${label}…`, [['Cancel', () => this.cancel(true)]]);
    try {
      const feature = await this.loader.load(key, load, retry);
      if (!request.current()) return false;
      const result = await open(feature, request);
      if (!request.current()) return request.committed ? result : false;
      request.state = 'ready';
      this.active = null;
      this.element.hidden = true;
      return result === undefined ? true : result;
    } catch (error) {
      if (!request.current()) return false;
      request.error = error;
      this.active = request;
      const recoverable = this.loader.canRetry(key);
      request.state = recoverable ? 'recoverable' : 'reload-required';
      const controls = recoverable ? [['Retry', () => this.run(spec, true)]] : [];
      controls.push(
        ['Save and reload', () => this.saveAndReload(request)],
        ['Export drafts', () => this.exportDrafts(request)],
        ['Dismiss', () => this.cancel(true)],
      );
      this.#render(
        `${label} could not open. ${recoverable ? 'Check your connection, then retry once.' : 'Save and reload to try again.'} Your drafts remain in this window.`,
        controls,
      );
      return false;
    } finally {
      if (this.active === request && !request.current()) this.cancel();
    }
  }
  #render(message, controls) {
    this.element.dataset.state = this.active?.state || 'ready';
    this.status.textContent = message;
    this.controls.replaceChildren();
    for (const [label, action] of controls) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--ghost';
      button.textContent = label;
      button.addEventListener('click', async () => {
        const request = this.active;
        button.disabled = true;
        try {
          await action();
        } catch (error) {
          if (request === this.active)
            this.status.textContent = error?.message || 'Recovery could not finish. Your drafts remain in this window.';
        } finally {
          button.disabled = false;
        }
      });
      this.controls.append(button);
    }
    this.element.hidden = false;
  }
}
