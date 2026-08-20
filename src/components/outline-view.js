import './outline-view.css';
import { extractHeadings } from '../utils/headings.js';
import { escapeHtml } from '../utils/helpers.js';

export class OutlineView {
  constructor(container, { scrollRoot, onJump }) {
    this.container = container;
    this.scrollRoot = scrollRoot;
    this.onJump = onJump;
    this.headings = [];
    this.activeAnchor = null;
    this.__onScroll = () => this.#syncActiveFromScroll();
    this.__onClick = (event) => {
      const button = event.target.closest('[data-outline-anchor]');
      if (!button) return;
      this.#setActive(button.dataset.outlineAnchor);
      this.onJump(button.dataset.outlineAnchor);
    };
    this.__onKey = (event) => this.#onKey(event);
    this.container.addEventListener('click', this.__onClick);
    this.container.addEventListener('keydown', this.__onKey);
    this.scrollRoot?.addEventListener('scroll', this.__onScroll, { passive: true });
  }

  update(markdown) {
    const focusedAnchor = document.activeElement?.dataset?.outlineAnchor || null;
    this.headings = extractHeadings(markdown);
    if (!this.headings.some((heading) => heading.anchor === this.activeAnchor)) {
      this.activeAnchor = this.headings[0]?.anchor || null;
    }
    if (!this.headings.length) {
      this.container.hidden = true;
      this.container.innerHTML = '';
      return;
    }
    this.container.hidden = false;
    const open = window.matchMedia?.('(min-width: 761px)').matches ? ' open' : '';
    this.container.innerHTML = `<details class="outline"${open}>
      <summary class="outline__summary">On this page <span class="muted">${this.headings.length}</span></summary>
      <nav class="outline__nav" aria-label="Headings in this note">
        ${this.headings.map((heading) => `<button type="button" class="outline__item" data-outline-anchor="${escapeHtml(heading.anchor)}" style="--outline-level:${heading.level}" aria-current="${heading.anchor === this.activeAnchor ? 'location' : 'false'}">${escapeHtml(heading.text || 'Untitled heading')}</button>`).join('')}
      </nav>
    </details>`;
    if (focusedAnchor) this.container.querySelector(`[data-outline-anchor="${CSS.escape(focusedAnchor)}"]`)?.focus();
    queueMicrotask(() => this.#syncActiveFromScroll());
  }

  destroy() {
    this.container.removeEventListener('click', this.__onClick);
    this.container.removeEventListener('keydown', this.__onKey);
    this.scrollRoot?.removeEventListener('scroll', this.__onScroll);
  }

  #buttons() {
    return [...this.container.querySelectorAll('[data-outline-anchor]')];
  }

  #setActive(anchor) {
    if (!anchor) return;
    this.activeAnchor = anchor;
    for (const button of this.#buttons()) {
      button.setAttribute('aria-current', button.dataset.outlineAnchor === anchor ? 'location' : 'false');
    }
  }

  #syncActiveFromScroll() {
    if (!this.headings.length || !this.scrollRoot) return;
    const rootTop = this.scrollRoot.getBoundingClientRect().top;
    const rows = new Map([...this.scrollRoot.querySelectorAll('[data-heading-anchor]')]
      .map((element) => [element.dataset.headingAnchor, element]));
    let active = this.headings[0].anchor;
    for (const heading of this.headings) {
      const row = rows.get(heading.anchor);
      if (!row) continue;
      if (row.getBoundingClientRect().top <= rootTop + 140) active = heading.anchor;
      else break;
    }
    this.#setActive(active);
  }

  #onKey(event) {
    const button = event.target.closest('[data-outline-anchor]');
    if (!button) return;
    const buttons = this.#buttons();
    const index = buttons.indexOf(button);
    let next = null;
    if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }
}
