// Roving focus for WAI-ARIA menus (the More actions menu and the block action
// menu): arrows wrap, Home/End jump, and a letter moves to the next item whose
// text starts with it. Escape and Tab stay with each menu, which knows where
// focus should return.

/**
 * Move focus among `items` for a keydown inside a menu.
 * @param {KeyboardEvent} e
 * @param {HTMLElement[]} items enabled menu items, in order
 * @returns {boolean} whether the key was handled
 */
export function moveMenuFocus(e, items) {
  if (!items.length) return false;
  const index = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
  else if (e.key === 'ArrowUp') next = items[index <= 0 ? items.length - 1 : index - 1];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items.at(-1);
  else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const key = e.key.toLowerCase();
    const rotated = [...items.slice(index + 1), ...items.slice(0, index + 1)];
    next = rotated.find((item) => item.textContent.trim().toLowerCase().startsWith(key));
  }
  if (!next) return false;
  e.preventDefault();
  next.focus();
  return true;
}
