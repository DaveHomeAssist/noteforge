import { moveMenuFocus } from './menu-nav.js';

// Native popovers escape pane clipping and provide outside-click/Escape dismissal.
// The returned cleanup prevents stale listeners when an editor changes notes.
export function bindActionMenu(root) {
  const trigger = root.querySelector('[data-action-menu]');
  const menu = root.querySelector('.action-menu');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
  const close = (restore = false) => {
    if (menu.matches(':popover-open')) menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (restore && trigger.isConnected) trigger.focus();
  };
  const open = (last = false) => {
    menu.showPopover({ source: trigger });
    trigger.setAttribute('aria-expanded', 'true');
    const anchor = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - height - 8))}px`;
    (last ? items().at(-1) : items()[0])?.focus();
  };
  trigger.addEventListener('click', () => (menu.matches(':popover-open') ? close(true) : open()), options);
  trigger.addEventListener(
    'keydown',
    (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      open(event.key === 'ArrowUp');
    },
    options,
  );
  menu.addEventListener(
    'toggle',
    () => {
      trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
    },
    options,
  );
  menu.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
        close(true);
      } else moveMenuFocus(event, items());
    },
    options,
  );
  menu.addEventListener(
    'click',
    (event) => {
      if (event.target.closest('[role^="menuitem"]:not(:disabled)')) close(true);
    },
    options,
  );
  window.addEventListener('resize', () => close(), options);
  return () => {
    close();
    controller.abort();
  };
}
