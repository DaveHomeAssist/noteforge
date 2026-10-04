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
  window.addEventListener('pageshow', schedule);
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('focusout', schedule);
  const polling = setInterval(schedule, 15_000);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(polling);
    channel?.close();
    window.removeEventListener('noteforge:vault-change', local);
    window.removeEventListener('pageshow', schedule);
    window.removeEventListener('focus', schedule);
    document.removeEventListener('visibilitychange', schedule);
    document.removeEventListener('focusout', schedule);
  };
}
import { isAnyModalOpen } from '../components/modal.js';
