// Registers the service worker for offline launch — production only. In dev the
// SW would cache un-hashed dev modules and fight HMR, and the headless test
// runner would be polluted; import.meta.env.PROD is false there so we bail.

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  // Register under the app's base URL so it works both at root (dev) and under a
  // GitHub Pages sub-path (e.g. /my-notes-app/) — the SW is copied to the build root.
  const base = import.meta.env.BASE_URL || '/';
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
      console.warn('[pwa] service worker registration failed:', err);
    });
  });
}
