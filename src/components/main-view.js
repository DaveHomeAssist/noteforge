// Subject areas (Tasks, Calendar) open in the main area in place of the
// editor, as the graph does, instead of in a modal (house rule WEB-2). A host
// mirrors the Modal interface the views already use; the app listens for its
// `mainview:open` / `mainview:close` events on `.main` to decide what the main
// area shows, and asks a view to close with `mainview:request-close`.

/** A hidden, labelled main-area section holding a view's markup. */
export function createMainViewSection({ id, view, labelledBy, html, root = null }) {
  const section = document.createElement('section');
  section.id = id;
  section.className = 'main-view';
  section.dataset.view = view;
  section.hidden = true;
  section.tabIndex = -1;
  section.setAttribute('aria-labelledby', labelledBy);
  section.innerHTML = html;
  (root || document.querySelector('.main') || document.body).appendChild(section);
  return section;
}

export class MainViewHost {
  /**
   * @param {HTMLElement} section
   * @param {{ view: string, initialFocus?: () => HTMLElement|null }} options
   */
  constructor(section, { view, initialFocus = null }) {
    this.section = section;
    this.view = view;
    this.initialFocus = initialFocus;
    this.isOpen = false;
    section.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
    });
    section.addEventListener('mainview:request-close', () => this.close());
  }

  open() {
    if (!this.isOpen) {
      this.isOpen = true;
      this.section.hidden = false;
      this.#emit('mainview:open');
    }
    this.focusInitial();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.section.hidden = true;
    this.#emit('mainview:close');
  }

  focusInitial() {
    const target = typeof this.initialFocus === 'function' ? this.initialFocus() : null;
    (target || this.section).focus({ preventScroll: true });
  }

  /** Modal compatibility: a main view has no trigger to return focus to. */
  setReturnFocus() {}

  #emit(type) {
    this.section.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { view: this.view } }));
  }
}
