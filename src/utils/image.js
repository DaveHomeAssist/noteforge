// Client-side image downscaling for banner uploads. localStorage is small
// (~5 MB total) and holds the whole note DB, so an uploaded cover must be
// shrunk to a compact JPEG data URL before it can be stored.

const MAX_WIDTH = 1600; // banners are wide; width is what matters for quality
const MAX_HEIGHT = 2400; // also cap height so tall panoramas can't exceed canvas limits
const QUALITY = 0.82;
const HARD_LIMIT = 2_000_000; // ~2 MB data URL ceiling; reject beyond this

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a readable image.'));
    img.src = src;
  });
}

/**
 * Convert an uploaded image File to a downscaled JPEG data URL.
 * Retries at progressively lower quality/size if the result is too large.
 * @param {File} file
 * @returns {Promise<string>} a `data:image/jpeg;base64,...` URL
 */
export async function fileToBannerDataURL(file) {
  if (!file || !/^image\//.test(file.type)) {
    throw new Error('Please choose an image file.');
  }
  const srcUrl = await readAsDataURL(file);
  const img = await loadImage(srcUrl);
  if (!img.width || !img.height) {
    throw new Error('That image has no usable dimensions.');
  }

  const attempts = [
    { maxWidth: MAX_WIDTH, quality: QUALITY },
    { maxWidth: 1200, quality: 0.78 },
    { maxWidth: 1000, quality: 0.72 },
    { maxWidth: 800, quality: 0.68 },
  ];

  let last = '';
  for (const { maxWidth, quality } of attempts) {
    const scale = Math.min(1, maxWidth / img.width, MAX_HEIGHT / img.height);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // White backfill so transparent PNGs don't turn black under JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL('image/jpeg', quality);
    // Over-large canvases make toDataURL return the empty sentinel "data:," —
    // treat any non-JPEG result as an encode failure and shrink further.
    if (!out.startsWith('data:image/jpeg')) continue;
    last = out;
    if (last.length <= HARD_LIMIT) return last;
  }
  throw new Error('This image could not be processed for a banner (too large).');
}
