const KEY = 'noteforge:window-state:v1';
const FIELDS = ['workspace', 'recentNoteIds', 'collapsed'];

/** Window navigation is recoverable session state, never shared vault authority. */
export class WindowState {
  constructor(legacy = {}, { storage = () => globalThis.sessionStorage, onUnavailable = (_message) => {} } = {}) {
    this.values = Object.fromEntries(FIELDS.map((key) => [key, structuredClone(legacy[key])]));
    this.onUnavailable = onUnavailable;
    this.warned = false;
    this.backend = null;
    try {
      const backend = storage();
      const raw = backend.getItem(KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw);
        if (saved?.version !== 1 || !saved.values || typeof saved.values !== 'object' || Array.isArray(saved.values))
          throw new Error('Unsupported window state.');
        this.values = Object.fromEntries(FIELDS.map((key) => [key, saved.values[key]]));
      }
      this.backend = backend;
    } catch {
      this.#unavailable();
    }
  }

  get(key) {
    return structuredClone(this.values[key]);
  }

  set(patch) {
    if (Object.keys(patch).some((key) => !FIELDS.includes(key))) throw new Error('Invalid window state field.');
    this.values = { ...this.values, ...structuredClone(patch) };
    try {
      if (!this.backend) throw new Error('Session storage unavailable.');
      this.backend.setItem(KEY, JSON.stringify({ version: 1, values: this.values }));
      return true;
    } catch {
      this.#unavailable();
      return false;
    }
  }

  #unavailable() {
    if (this.warned) return;
    this.warned = true;
    this.onUnavailable('Window layout and recent notes may not survive reload. Note storage is unchanged.');
  }
}
