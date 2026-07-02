// Per-note banner (Notion-style cover). Renders the strip above the title with
// hover controls, and a picker popover offering gradient presets, an image
// upload (downscaled to fit localStorage), or an image URL. The banner is note
// metadata persisted via the onChange callback — it never touches note.content.

import { fileToBannerDataURL } from '../utils/image.js';
import { escapeAttr } from '../utils/helpers.js';

export const BANNER_GRADIENTS = [
  'linear-gradient(120deg, #6366f1 0%, #8b5cf6 50%, #d946ef 100%)',
  'linear-gradient(120deg, #0ea5e9 0%, #22d3ee 100%)',
  'linear-gradient(120deg, #f97316 0%, #ef4444 100%)',
  'linear-gradient(120deg, #10b981 0%, #34d399 60%, #a7f3d0 100%)',
  'linear-gradient(120deg, #f43f5e 0%, #ec4899 50%, #a855f7 100%)',
  'linear-gradient(120deg, #1e293b 0%, #334155 50%, #64748b 100%)',
  'linear-gradient(120deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%)',
  'linear-gradient(120deg, #2dd4bf 0%, #0ea5e9 50%, #6366f1 100%)',
];

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
    this.picker = null;
    this.repositioning = false;
    this.__onDocClick = (e) => {
      const t = e.target;
      const onTrigger = t && t.closest && t.closest('.banner__btn, .banner-add');
      if (this.picker && !this.picker.contains(t) && !onTrigger) {
        this.#closePicker();
      }
    };
    this.render();
  }

  destroy() {
    this.#closePicker();
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
      add.innerHTML = '🖼 Add banner';
      add.addEventListener('click', () => this.#addRandomGradient());
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
      (banner.type === 'image' ? '<button type="button" class="banner__btn" data-act="reposition">Reposition</button>' : '') +
      '<button type="button" class="banner__btn" data-act="remove">Remove</button>';
    controls.addEventListener('click', (e) => {
      const act = e.target.closest('.banner__btn')?.dataset.act;
      if (act === 'change') this.#openPicker(e.target);
      else if (act === 'remove') this.#remove();
      else if (act === 'reposition') this.#startReposition(strip, banner);
    });
    strip.appendChild(controls);

    this.host.appendChild(strip);
  }

  // --- actions ------------------------------------------------------------

  #addRandomGradient() {
    // Deterministic-ish pick without Math.random surprises: rotate by time.
    const i = Math.floor(Date.now() / 1000) % BANNER_GRADIENTS.length;
    this.onChange({ type: 'gradient', value: BANNER_GRADIENTS[i], position: 50 });
  }

  #remove() {
    this.repositioning = false;
    this.onChange(null);
  }

  #startReposition(strip, banner) {
    if (this.repositioning) return;
    this.repositioning = true;
    const img = strip.querySelector('.banner__img');
    const bar = el('div', 'banner__reposition');
    const range = el('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = String(banner.position ?? 50);
    range.setAttribute('aria-label', 'Vertical position');
    const done = el('button', 'banner__btn');
    done.type = 'button';
    done.textContent = 'Save position';
    bar.append(range, done);
    strip.appendChild(bar);
    strip.classList.add('is-repositioning');

    range.addEventListener('input', () => {
      if (img) img.style.objectPosition = `50% ${range.value}%`;
    });
    const commit = () => {
      this.repositioning = false;
      this.onChange({ ...banner, position: Number(range.value) });
    };
    done.addEventListener('click', commit);
    range.addEventListener('change', commit);
  }

  #apply(banner) {
    this.#closePicker();
    this.onChange(banner);
  }

  // --- picker popover -----------------------------------------------------

  #openPicker(anchor) {
    this.#closePicker();
    const p = el('div', 'banner-picker');
    p.innerHTML = `
      <div class="banner-picker__section">
        <div class="banner-picker__label">Gradients</div>
        <div class="banner-picker__grid">
          ${BANNER_GRADIENTS.map(
            (g) => `<button type="button" class="banner-swatch" data-grad="${escapeAttr(g)}" style="background-image:${escapeAttr(g)}"></button>`
          ).join('')}
        </div>
      </div>
      <div class="banner-picker__section">
        <div class="banner-picker__label">Image</div>
        <button type="button" class="banner-picker__upload">⬆ Upload an image…</button>
        <div class="banner-picker__row">
          <input type="url" class="banner-picker__url" placeholder="Paste an image URL" />
          <button type="button" class="banner-picker__url-apply">Apply</button>
        </div>
        <div class="banner-picker__status" hidden></div>
      </div>`;
    document.body.appendChild(p);
    this.picker = p;

    // Gradient swatches
    p.querySelectorAll('.banner-swatch').forEach((sw) =>
      sw.addEventListener('click', () =>
        this.#apply({ type: 'gradient', value: sw.dataset.grad, position: 50 })
      )
    );

    // Upload
    const status = p.querySelector('.banner-picker__status');
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    p.appendChild(fileInput);
    p.querySelector('.banner-picker__upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const myPicker = p; // the picker may be dismissed while we await
      status.hidden = false;
      status.textContent = 'Processing image…';
      try {
        const dataUrl = await fileToBannerDataURL(file);
        this.#apply({ type: 'image', value: dataUrl, position: 50 });
      } catch (err) {
        if (this.picker === myPicker) status.textContent = err.message || 'Could not use that image.';
      } finally {
        fileInput.value = '';
      }
    });

    // URL
    const urlInput = p.querySelector('.banner-picker__url');
    const applyUrl = () => {
      const v = urlInput.value.trim();
      if (/^https?:\/\//i.test(v)) this.#apply({ type: 'image', value: v, position: 50 });
      else { status.hidden = false; status.textContent = 'Enter an http(s) image URL.'; }
    };
    p.querySelector('.banner-picker__url-apply').addEventListener('click', applyUrl);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } });

    this.#positionPicker(anchor);
    document.addEventListener('mousedown', this.__onDocClick, true);
    document.addEventListener('keydown', this.__onEsc = (e) => { if (e.key === 'Escape') this.#closePicker(); });
  }

  #positionPicker(anchor) {
    const r = anchor.getBoundingClientRect();
    const p = this.picker;
    const top = r.bottom + 6;
    const maxLeft = window.innerWidth - p.offsetWidth - 12;
    p.style.top = `${Math.max(8, Math.min(top, window.innerHeight - p.offsetHeight - 8))}px`;
    p.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`;
  }

  #closePicker() {
    if (this.picker) { this.picker.remove(); this.picker = null; }
    document.removeEventListener('mousedown', this.__onDocClick, true);
    if (this.__onEsc) { document.removeEventListener('keydown', this.__onEsc); this.__onEsc = null; }
  }
}
