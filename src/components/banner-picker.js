// Banner picker: the lazy half of the note banner (see ./banner.js). Holds the
// gradient presets, the picker popover (gradients, image upload downscaled to
// fit localStorage, image URL) and Reposition. Every function takes the
// BannerControl that owns the strip and reports through its onChange.

import './banner-picker.css';
import { fileToBannerDataURL } from '../utils/image.js';
import { escapeAttr } from '../utils/helpers.js';
import { icon } from '../ui/icons.js';

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

export function addRandomGradient(ctrl) {
  // Deterministic-ish pick without Math.random surprises: rotate by time.
  const i = Math.floor(Date.now() / 1000) % BANNER_GRADIENTS.length;
  ctrl.onChange({ type: 'gradient', value: BANNER_GRADIENTS[i], position: 50 });
}

export function startReposition(ctrl, strip, banner) {
  if (ctrl.repositioning) return;
  ctrl.repositioning = true;
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
    ctrl.repositioning = false;
    ctrl.onChange({ ...banner, position: Number(range.value) });
  };
  done.addEventListener('click', commit);
  range.addEventListener('change', commit);
}

function apply(ctrl, banner) {
  ctrl.closePicker();
  ctrl.onChange(banner);
}

// --- picker popover -------------------------------------------------------

export function openPicker(ctrl, anchor) {
  ctrl.closePicker();
  const p = el('div', 'banner-picker');
  p.innerHTML = `
    <div class="banner-picker__section">
      <div class="banner-picker__label">Gradients</div>
      <div class="banner-picker__grid">
        ${BANNER_GRADIENTS.map(
          (g) =>
            `<button type="button" class="banner-swatch" data-grad="${escapeAttr(g)}" style="background-image:${escapeAttr(g)}"></button>`,
        ).join('')}
      </div>
    </div>
    <div class="banner-picker__section">
      <div class="banner-picker__label">Image</div>
      <button type="button" class="banner-picker__upload">${icon('upload')} Upload an image…</button>
      <div class="banner-picker__row">
        <input type="url" class="banner-picker__url" placeholder="Paste an image URL" />
        <button type="button" class="banner-picker__url-apply">Apply</button>
      </div>
      <div class="banner-picker__status" hidden></div>
    </div>`;
  document.body.appendChild(p);
  ctrl.picker = p;

  // Gradient swatches
  for (const sw of p.querySelectorAll('.banner-swatch')) {
    sw.addEventListener('click', () => apply(ctrl, { type: 'gradient', value: sw.dataset.grad, position: 50 }));
  }

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
      apply(ctrl, { type: 'image', value: dataUrl, position: 50 });
    } catch (err) {
      if (ctrl.picker === myPicker) status.textContent = err.message || 'Could not use that image.';
    } finally {
      fileInput.value = '';
    }
  });

  // URL
  const urlInput = p.querySelector('.banner-picker__url');
  const applyUrl = () => {
    const v = urlInput.value.trim();
    if (/^https?:\/\//i.test(v)) apply(ctrl, { type: 'image', value: v, position: 50 });
    else {
      status.hidden = false;
      status.textContent = 'Enter an http(s) image URL.';
    }
  };
  p.querySelector('.banner-picker__url-apply').addEventListener('click', applyUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyUrl();
    }
  });

  positionPicker(p, anchor);
  document.addEventListener('mousedown', ctrl.__onDocClick, true);
  ctrl.__onEsc = (e) => {
    if (e.key === 'Escape') ctrl.closePicker();
  };
  document.addEventListener('keydown', ctrl.__onEsc);
}

function positionPicker(p, anchor) {
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6;
  const maxLeft = window.innerWidth - p.offsetWidth - 12;
  p.style.top = `${Math.max(8, Math.min(top, window.innerHeight - p.offsetHeight - 8))}px`;
  p.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`;
}
