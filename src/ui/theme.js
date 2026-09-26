// Theme handling: applies a resolved `data-theme` (light|dark) on <html> from a
// mode (light|dark|system) persisted in the Database config. In `system` mode it
// follows the OS preference live via matchMedia.
//
// Boot order: index.html applies the mirrored mode (THEME_MIRROR_KEY in
// localStorage) inline before first paint so dark users never see a light flash.
// Once the Database is ready this class re-applies the persisted mode and keeps
// the mirror, <meta name="theme-color">, and every toggle button in sync.

import { DEFAULT_SETTINGS, resolveTheme, THEME_MIRROR_KEY, THEME_MODES } from './settings.js';

export class Theme {
  /** @param buttons one toggle button or an array of them (desktop header + mobile bar). */
  constructor(db, buttons) {
    this.db = db;
    this.buttons = [buttons].flat().filter(Boolean);
    this.mql = window.matchMedia('(prefers-color-scheme: dark)');
    this.__onSystem = () => { if (this.mode === 'system') this.#applyResolved(); };
    this.mql.addEventListener ? this.mql.addEventListener('change', this.__onSystem)
      : this.mql.addListener?.(this.__onSystem); // Safari <14 fallback
    // A persisted choice (new themeMode, or the legacy `theme` key) always wins;
    // whoever never chose gets the WEB-1 light default. The initial apply is not
    // written back, so "never chose" stays distinguishable from an explicit pick.
    const stored = [db.config.themeMode, db.config.theme].find((mode) => THEME_MODES.includes(mode));
    this.setMode(stored || DEFAULT_SETTINGS.themeMode, { persist: false });
    for (const button of this.buttons) button.addEventListener('click', () => this.toggle());
  }

  /** Apply a mode; persist it to the Database config unless told otherwise. */
  setMode(mode, { persist = true } = {}) {
    this.mode = THEME_MODES.includes(mode) ? mode : DEFAULT_SETTINGS.themeMode;
    if (persist) this.db.setConfig({ themeMode: this.mode });
    this.#applyResolved();
  }

  #applyResolved() {
    const resolved = resolveTheme(this.mode, this.mql.matches);
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    // Best effort: private mode or a full quota must never break theming.
    try { localStorage.setItem(THEME_MIRROR_KEY, this.mode); } catch { /* ignore */ }
    // Browser chrome (address bar, PWA title bar) follows the top-bar surface.
    const meta = document.querySelector('meta[name="theme-color"]');
    const color = getComputedStyle(root).getPropertyValue('--bg-elev').trim();
    if (meta && color) meta.content = color;
    for (const button of this.buttons) {
      button.textContent = resolved === 'dark' ? '☀️' : '🌙';
      button.setAttribute('aria-label', `Theme: ${this.mode}`);
      button.setAttribute('title', `Theme: ${this.mode} — click to toggle`);
    }
  }

  /** The toggle buttons flip between explicit light/dark (System is set via Settings). */
  toggle() {
    const resolved = resolveTheme(this.mode, this.mql.matches);
    this.setMode(resolved === 'dark' ? 'light' : 'dark');
  }
}
