const MAX_TITLE = 300;
const MAX_TEXT = 100_000;
const MAX_URL = 2_048;

function bounded(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function normalizeCaptureUrl(value) {
  const source = bounded(value, MAX_URL).trim();
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch { throw new TypeError('Enter a complete http or https URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Only http and https URLs can be captured.');
  return url.href;
}

export function normalizeCapturePayload(payload = {}) {
  const title = bounded(payload.title, MAX_TITLE).trim();
  const text = bounded(payload.text, MAX_TEXT).replace(/\r\n?/g, '\n').trim();
  const url = normalizeCaptureUrl(payload.url);
  return { title, text, url };
}

export function consumeShareTarget(input) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input), 'https://noteforge.invalid/');
  if (url.searchParams.get('source') !== 'share-target') return { matched: false, payload: null, cleanUrl: null };
  // Only the manifest-declared title/text/url names are read. Everything else
  // is ignored, then the complete query is cleared to make intake one-shot.
  const payload = normalizeCapturePayload({
    title: url.searchParams.get('title') || '',
    text: url.searchParams.get('text') || '',
    url: url.searchParams.get('url') || '',
  });
  return { matched: true, payload, cleanUrl: `${url.pathname}${url.hash}` };
}

function escapeLinkLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
}

export function buildCaptureMarkdown({ title = '', text = '', url = '', imageDataUrl = '', imageAlt = '' } = {}) {
  const normalized = normalizeCapturePayload({ title, text, url });
  const parts = [];
  if (normalized.text) parts.push(normalized.text);
  if (normalized.url) {
    const label = normalized.title || normalized.url;
    parts.push(`[${escapeLinkLabel(label)}](${normalized.url})`);
  } else if (normalized.title && !normalized.text) {
    parts.push(normalized.title);
  }
  if (imageDataUrl) {
    if (!/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i.test(imageDataUrl)) throw new TypeError('Captured image data is not a supported image.');
    const alt = String(imageAlt || 'Captured image').replace(/[\[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    parts.push(`![${alt}](${imageDataUrl})`);
  }
  return parts.join('\n\n');
}

export function appendCapturedMarkdown(existing, captured) {
  const before = String(existing ?? '');
  const addition = String(captured ?? '');
  if (!addition) return before;
  if (!before) return addition;
  return `${before.replace(/\s*$/, '')}\n\n${addition}`;
}
