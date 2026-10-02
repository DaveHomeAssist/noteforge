// Per-note banner (Notion-style cover). Renders the strip above the title with
// hover controls. The banner is note metadata persisted via the onChange
// callback — it never touches note.content.
//
// Only the strip and its buttons are in the first-paint shell. The picker
// popover (gradient presets, image upload, image URL), Reposition and the
// gradient list live in ./banner-picker.js, a lazy chunk that starts loading
// when the pointer or focus first reaches the banner, so a click rarely waits.

import { icon } from '../ui/icons.js';

let pickerModule = null;
let pickerLoad = null;

/** Loads the picker chunk once; resolves to the module. */
export function loadBannerPicker() {
  pickerLoad ??= import('./banner-picker.js')
    .then((m) => {
      pickerModule = m;
      return m;
    })
    .catch((error) => {
      pickerLoad = null;
      throw error;
    });
  return pickerLoad;
}

/** Runs `fn(module)` now when the picker chunk is loaded, else after it loads. */
function withPicker(ctrl, fn) {
  if (ctrl.destroyed) return;
  if (pickerModule) fn(pickerModule);
  else {
    loadBannerPicker()
      .then((m) => {
        if (!ctrl.destroyed) fn(m);
      })
      .catch((error) => console.warn('[banner] picker unavailable; try again:', error));
  }
}

function preloadPicker() {
  // Hover/focus is speculative; a click can retry if this preload fails.
  void loadBannerPicker().catch(() => {});
}

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export class BannerControl {
  /**
   * @param {HTMLElement} host  the `.editor__banner` container
   * @param {{ getBanner:()=>object|null, onChange:(banner:object|null)=>void }} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.getBanner = opts.getBanner;
    this.onChange = opts.onChange;
    this.destroyed = false;
    this.picker = null;
    this.repositioning = false;
    this.__onDocClick = (e) => {
      const t = e.target;
      const onTrigger = t?.closest?.('.banner__btn, .banner-add');
      if (this.picker && !this.picker.contains(t) && !onTrigger) {
        this.closePicker();
      }
    };
    host.addEventListener('pointerenter', preloadPicker, { once: true });
    host.addEventListener('focusin', preloadPicker, { once: true });
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this.host.removeEventListener('pointerenter', preloadPicker);
    this.host.removeEventListener('focusin', preloadPicker);
    this.closePicker();
    document.removeEventListener('mousedown', this.__onDocClick, true);
  }

  /** True while the picker is open or a reposition drag is in progress — the
   *  editor must not rebuild us then (it would drop the in-flight interaction). */
  isBusy() {
    return !!this.picker || this.repositioning;
  }

  // --- rendering ----------------------------------------------------------

  render() {
    const banner = this.getBanner();
    this.host.innerHTML = '';
    this.repositioning = false;
    if (!banner) {
      this.host.classList.remove('has-banner');
      const add = el('button', 'banner-add');
      add.type = 'button';
      add.innerHTML = `${icon('image')} Add banner`;
      add.addEventListener('click', () => withPicker(this, (m) => m.addRandomGradient(this)));
      this.host.appendChild(add);
      return;
    }

    this.host.classList.add('has-banner');
    const strip = el('div', 'banner banner--' + banner.type);
    if (banner.type === 'gradient') {
      strip.style.backgroundImage = banner.value;
    } else {
      const img = el('img', 'banner__img');
      img.src = banner.value;
      img.alt = '';
      img.style.objectPosition = `50% ${banner.position}%`;
      img.addEventListener('error', () => strip.classList.add('banner--broken'));
      strip.appendChild(img);
    }

    const controls = el('div', 'banner__controls');
    controls.innerHTML =
      '<button type="button" class="banner__btn" data-act="change">Change</button>' +
      (banner.type === 'image'
        ? '<button type="button" class="banner__btn" data-act="reposition">Reposition</button>'
        : '') +
      '<button type="button" class="banner__btn" data-act="remove">Remove</button>';
    controls.addEventListener('click', (e) => {
      const act = e.target.closest('.banner__btn')?.dataset.act;
      if (act === 'change') withPicker(this, (m) => m.openPicker(this, e.target));
      else if (act === 'remove') this.#remove();
      else if (act === 'reposition') withPicker(this, (m) => m.startReposition(this, strip, banner));
    });
    strip.appendChild(controls);

    this.host.appendChild(strip);
  }

  // --- actions ------------------------------------------------------------

  #remove() {
    this.repositioning = false;
    this.onChange(null);
  }

  /** Closes the picker popover, if open, and drops its document listeners. */
  closePicker() {
    if (this.picker) {
      this.picker.remove();
      this.picker = null;
    }
    document.removeEventListener('mousedown', this.__onDocClick, true);
    if (this.__onEsc) {
      document.removeEventListener('keydown', this.__onEsc);
      this.__onEsc = null;
    }
  }
}
