// Theme handling: applies a resolved `data-theme` (light|dark) on <html> from a
// mode (light|dark|system) persisted in the Database config. In `system` mode it
// follows the OS preference live via matchMedia.

import { resolveTheme, THEME_MODES } from './settings.js';

export class Theme {
  constructor(db, button) {
    this.db = db;
    this.button = button;
    this.mql = window.matchMedia('(prefers-color-scheme: dark)');
    this.__onSystem = () => { if (this.mode === 'system') this.#applyResolved(); };
    this.mql.addEventListener ? this.mql.addEventListener('change', this.__onSystem)
      : this.mql.addListener?.(this.__onSystem); // Safari <14 fallback
    // Prefer the new themeMode; fall back to the legacy `theme` key.
    this.setMode(db.config.themeMode || db.config.theme || 'system');
    if (button) button.addEventListener('click', () => this.toggle());
  }

  setMode(mode) {
    this.mode = THEME_MODES.includes(mode) ? mode : 'system';
    this.db.setConfig({ themeMode: this.mode });
    this.#applyResolved();
  }

  #applyResolved() {
    const resolved = resolveTheme(this.mode, this.mql.matches);
    document.documentElement.setAttribute('data-theme', resolved);
    if (this.button) {
      this.button.textContent = resolved === 'dark' ? '☀️' : '🌙';
      this.button.setAttribute('aria-label', `Theme: ${this.mode}`);
      this.button.setAttribute('title', `Theme: ${this.mode} — click to toggle`);
    }
  }

  /** The header button toggles between explicit light/dark (System is set via Settings). */
  toggle() {
    const resolved = resolveTheme(this.mode, this.mql.matches);
    this.setMode(resolved === 'dark' ? 'light' : 'dark');
  }
}
