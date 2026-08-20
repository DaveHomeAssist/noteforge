// Bounded, one-shot web clipper intake. All incoming page/article material is
// plain text; only the existing sanitized Markdown renderer may later create DOM.

export const CLIPPER_MAX_TITLE = 300;
export const CLIPPER_MAX_URL = 2_048;
export const CLIPPER_MAX_SELECTION = 60_000;
export const CLIPPER_MAX_ARTICLE = 100_000;
export const CLIPPER_MAX_INTAKE_URL = 8_000;

const bounded = (value, max) => typeof value === 'string'
  ? value.replace(/\0/g, '').replace(/\r\n?/g, '\n').slice(0, max).trim()
  : '';

export function normalizeClipperPayload(payload = {}) {
  const title = bounded(payload.title, CLIPPER_MAX_TITLE);
  const selection = bounded(payload.selection ?? payload.text, CLIPPER_MAX_SELECTION);
  const article = bounded(payload.article, CLIPPER_MAX_ARTICLE);
  let url = bounded(payload.url, CLIPPER_MAX_URL);
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError('The clipped page URL is invalid.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Only http and https pages can be clipped.');
    url = parsed.href;
  }
  const text = [selection, article && article !== selection ? article : ''].filter(Boolean).join('\n\n');
  return { title, text, url, selection, article };
}

export function consumeClipperIntake(input) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input), 'https://noteforge.invalid/');
  const mode = url.searchParams.get('capture');
  if (mode !== 'clipper' && mode !== 'clipboard') return { matched: false, clipboardFallback: false, payload: null, cleanUrl: null };
  const cleanUrl = `${url.pathname}${url.hash}`;
  if (mode === 'clipboard') return { matched: true, clipboardFallback: true, payload: null, cleanUrl };
  if (url.href.length > CLIPPER_MAX_INTAKE_URL) throw new TypeError('This clip is too large for a URL. Copy it to the clipboard and use Quick Capture instead.');
  return {
    matched: true,
    clipboardFallback: false,
    payload: normalizeClipperPayload({
      title: url.searchParams.get('title') || '',
      url: url.searchParams.get('url') || '',
      selection: url.searchParams.get('selection') || '',
      article: url.searchParams.get('article') || '',
    }),
    cleanUrl,
  };
}

function javascriptString(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Generate a self-contained bookmarklet with an explicit large-payload fallback. */
export function buildClipperBookmarklet(appUrl) {
  const base = new URL(String(appUrl));
  if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('The NoteForge clipper URL must use http or https.');
  base.search = '';
  base.hash = '';
  const app = javascriptString(base.href);
  return `javascript:(()=>{const a=${app},s=String(globalThis.getSelection?.()||'').trim(),b=document.body?.innerText||'',p=new URLSearchParams({capture:'clipper',title:document.title||'',url:location.href,selection:s,article:s?'':b.slice(0,100000)}),u=a+'?'+p;if(u.length<=8000){open(u,'_blank','noopener')}else{const m=[s||b.slice(0,100000),'['+(document.title||location.href)+']('+location.href+')'].filter(Boolean).join('\\n\\n'),f=()=>open(a+'?capture=clipboard','_blank','noopener'),c=()=>{prompt('Copy this clip, then paste it into NoteForge Quick Capture:',m);f()};navigator.clipboard?.writeText?navigator.clipboard.writeText(m).then(f).catch(c):c()}})()`;
}
