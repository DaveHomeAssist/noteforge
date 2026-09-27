// Icon system (NoteForge 2, Phase 1): Lucide icons (ISC) served as one SVG
// sprite, public/icons.svg, which the service worker precaches. The shell
// carries only short <use> references, and stroke weight and color come from
// the `.icon` rule, so every icon follows the text color and theme.
//
// Add an icon: append its Lucide name (https://lucide.dev/icons) to ICON_NAMES,
// run `npm run icons`, and commit public/icons.svg. `npm run icons -- --check`
// (in CI) fails when the committed sprite and this list disagree.

export const ICON_NAMES = [
  'archive',
  'arrow-left',
  'arrow-left-right',
  'arrow-right',
  'arrow-up-to-line',
  'calendar',
  'calendar-days',
  'check',
  'chevron-left',
  'chevron-right',
  'columns-2',
  'command',
  'corner-down-right',
  'download',
  'ellipsis',
  'file-down',
  'file-text',
  'folder',
  'folder-kanban',
  'folder-sync',
  'globe',
  'history',
  'image',
  'inbox',
  'layout-template',
  'life-buoy',
  'link',
  'link-2',
  'menu',
  'message-square',
  'moon',
  'notebook-pen',
  'panel-left',
  'panel-right',
  'pin',
  'plus',
  'rotate-ccw',
  'scissors',
  'search',
  'settings',
  'sliders-horizontal',
  'sparkles',
  'square',
  'square-check-big',
  'sun',
  'sun-moon',
  'text-search',
  'trash-2',
  'triangle-alert',
  'upload',
  'users',
  'waypoints',
  'x',
  'zap',
];

const KNOWN = new Set(ICON_NAMES);
// `import.meta.env` exists under Vite (dev: "/", build: "/noteforge/"); Node
// tests that import UI modules fall back to the root.
const SPRITE = `${import.meta.env?.BASE_URL ?? '/'}icons.svg`;

export function isIconName(name) {
  return KNOWN.has(name);
}

/**
 * Markup for a decorative icon. Icons never carry meaning on their own: the
 * control they sit in needs visible text or an aria-label.
 */
export function icon(name, { className = '' } = {}) {
  if (!KNOWN.has(name)) throw new Error(`Unknown icon "${name}"; add it to ICON_NAMES in src/ui/icons.js`);
  const classes = className ? `icon ${className}` : 'icon';
  return `<svg class="${classes}" aria-hidden="true" focusable="false"><use href="${SPRITE}#i-${name}"></use></svg>`;
}
