// Pure settings helpers: defaults, normalization, and theme resolution. No DOM
// dependency, so this is unit-testable in Node. The DOM/UI lives in
// components/settings-view.js; applying settings lives in the app controller.

export const THEME_MODES = ['light', 'dark', 'system'];
export const FONT_SCALES = { s: '14px', m: '15px', l: '17px' };
export const EDITOR_WIDTHS = { normal: '760px', wide: '1040px', full: 'none' };
export const AUTOSAVE_OPTIONS = [250, 400, 800];
export const TEMPLATE_IDS = ['none', 'daily', 'meeting', 'project'];

export const DEFAULT_SETTINGS = {
  themeMode: 'system',
  fontScale: 'm',
  editorWidth: 'normal',
  autosaveMs: 400,
  defaultTemplate: 'none',
};

/**
 * Coerce a (possibly partial / legacy) config object into a valid settings shape.
 * Falls back to the legacy `theme` key for `themeMode` so older installs keep
 * their light/dark choice.
 */
export function normalizeSettings(cfg = {}) {
  const s = { ...DEFAULT_SETTINGS };
  if (THEME_MODES.includes(cfg.themeMode)) s.themeMode = cfg.themeMode;
  else if (THEME_MODES.includes(cfg.theme)) s.themeMode = cfg.theme; // legacy
  if (Object.prototype.hasOwnProperty.call(FONT_SCALES, cfg.fontScale)) s.fontScale = cfg.fontScale;
  if (Object.prototype.hasOwnProperty.call(EDITOR_WIDTHS, cfg.editorWidth)) s.editorWidth = cfg.editorWidth;
  if (AUTOSAVE_OPTIONS.includes(Number(cfg.autosaveMs))) s.autosaveMs = Number(cfg.autosaveMs);
  if (TEMPLATE_IDS.includes(cfg.defaultTemplate)) s.defaultTemplate = cfg.defaultTemplate;
  return s;
}

/** Resolve a theme mode + system preference to a concrete 'light' | 'dark'. */
export function resolveTheme(mode, prefersDark) {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}
