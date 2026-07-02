// Small, dependency-free helpers shared across the app.

/** Collision-resistant id: time component + random suffix. */
export function uid() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Escape text for safe insertion into HTML element content. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape text for use inside a double-quoted HTML attribute. */
export function escapeAttr(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Debounce: run `fn` after `ms` of quiet. Returns a cancelable wrapper. */
export function debounce(fn, ms = 300) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

/** Truncate to `n` chars on a word-ish boundary, adding an ellipsis. */
export function truncate(text, n = 120) {
  const clean = String(text ?? '').replace(/[#*`>\-\[\]]/g, '').trim();
  if (clean.length <= n) return clean;
  return clean.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

/** Human-friendly relative-ish date. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const diffDays = Math.floor((now - d) / 86_400_000);
  if (diffDays < 7 && diffDays >= 0) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Case-insensitive title match, trimmed. Used to resolve wikilinks. */
export function normalizeTitle(title) {
  return String(title ?? '').trim().toLowerCase();
}
