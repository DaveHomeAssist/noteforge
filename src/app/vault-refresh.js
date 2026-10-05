/** Reconcile on hints and resume; messages never carry or replace note data. */
export function watchVault(app, announce) {
  let channel;
  try {
    channel = new BroadcastChannel('noteforge:vault-change');
  } catch {
    // Resume and visible-window polling also work without BroadcastChannel.
  }
  let stopped = false;
  let timer;
  let running = false;
  let requested = false;
  // Legacy capture runs on resume, fallback storage events and a bounded
  // visible interval, not after every local save.
  let captureDue = true;
  const canAdopt = () => !stopped && !isAnyModalOpen() && app.editor?.canRefreshFromStorage() === true;
  const refresh = async () => {
    timer = undefined;
    if (stopped || document.visibilityState === 'hidden') return;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    try {
      if (captureDue) {
        captureDue = false;
        const captured = await app.db.captureLegacyChanges().catch((error) => {
          console.warn('[vault] legacy capture failed:', error);
          return { captured: 0 };
        });
        if (captured.captured) {
          app.db.onPersistError?.('conflicts');
          announce('Edits saved in an older NoteForge window were kept for review. Nothing was overwritten.');
        }
      }
      const result = await app.db.refreshCurrentVault(canAdopt);
      if (result.status === 'refreshed' && app.db.conflicts.size) app.db.onPersistError?.('conflicts');
    } catch (error) {
      announce('Saved changes could not be refreshed. Local drafts are unchanged.');
      console.warn('[vault] refresh failed:', error);
    } finally {
      running = false;
      if (requested) {
        requested = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => void refresh(), 100);
  };
  const capture = () => {
    captureDue = true;
    schedule();
  };
  const legacyStorage = (event) => {
    if (
      ['my-notes-app:notes', 'my-notes-app:config', 'my-notes-app:schemaVersion'].includes(event.key) ||
      event.key === null
    )
      capture();
  };
  const local = () => {
    try {
      channel?.postMessage(null);
    } catch {
      // Losing a hint does not affect the already completed transaction.
    }
    schedule();
  };
  channel?.addEventListener('message', schedule);
  window.addEventListener('noteforge:vault-change', local);
  window.addEventListener('pageshow', capture);
  window.addEventListener('focus', capture);
  window.addEventListener('storage', legacyStorage);
  document.addEventListener('visibilitychange', capture);
  document.addEventListener('focusout', schedule);
  const polling = setInterval(capture, 15_000);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(polling);
    channel?.close();
    window.removeEventListener('noteforge:vault-change', local);
    window.removeEventListener('pageshow', capture);
    window.removeEventListener('focus', capture);
    window.removeEventListener('storage', legacyStorage);
    document.removeEventListener('visibilitychange', capture);
    document.removeEventListener('focusout', schedule);
  };
}
import { isAnyModalOpen } from '../components/modal.js';
