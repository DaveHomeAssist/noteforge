import { Theme } from '../ui/theme.js';
import { downloadText } from '../utils/download.js';
import './storage-recovery.css';

/** A recovery reader has no editor, background feature initialization, or write queue. */
export function showStorageRecovery(db) {
  const root = document.createElement('main');
  root.id = 'storage-recovery';
  root.className = 'storage-recovery';
  root.innerHTML = `
    <header>
      <h1>NoteForge recovery</h1>
      <button type="button" data-theme-toggle></button>
    </header>
    <section class="storage-recovery__summary" aria-labelledby="storage-recovery-title">
      <h2 id="storage-recovery-title" tabindex="-1">This vault is read only</h2>
      <p data-reason></p>
      <p>You can read and export the notes loaded when this window opened. Reload to read later changes.</p>
      <div class="storage-recovery__actions">
        <button type="button" data-backup>Download verified backup</button>
        <button type="button" data-source>Download recovery source</button>
        <button type="button" data-reload>Reload vault</button>
      </div>
      <p role="status" aria-live="polite" data-status></p>
    </section>
    <section class="storage-recovery__reader" aria-label="Read saved notes">
      <label for="storage-recovery-note">Saved note (including Trash and Archive)</label>
      <select id="storage-recovery-note"></select>
      <label for="storage-recovery-content">Markdown source</label>
      <textarea id="storage-recovery-content" readonly spellcheck="false"></textarea>
    </section>`;
  root.querySelector('[data-reason]').textContent = db.upgradeRequired
    ? 'Editing is paused until a safe compatibility upgrade is available. Your stored notes have not been changed.'
    : 'Safe storage is unavailable in this browser. Editing is paused to prevent unsaved changes.';
  const notes = [...db.notes.values()];
  const select = root.querySelector('select');
  const content = root.querySelector('textarea');
  notes.forEach((note, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${note.title || 'Untitled'}${note.deletedAt ? ' (Trash)' : note.archivedAt ? ' (Archive)' : ''}`;
    select.append(option);
  });
  const read = () => {
    content.value = notes[Number(select.value)]?.content ?? '';
  };
  select.disabled = notes.length === 0;
  select.addEventListener('change', read);
  read();
  const status = root.querySelector('[data-status]');
  status.textContent = `${notes.length} saved note${notes.length === 1 ? '' : 's'} loaded. Editing is disabled.`;
  root.querySelector('[data-reload]').addEventListener('click', () => window.location.reload());
  root.querySelector('[data-source]').addEventListener('click', () => {
    try {
      downloadText(JSON.stringify(db.legacySnapshot, null, 2), 'noteforge-recovery-source.json', 'application/json');
      status.textContent =
        'Recovery source exported. This original storage snapshot is not a verified portable backup.';
    } catch (error) {
      status.textContent = `Recovery source could not be exported: ${error.message}`;
    }
  });
  const backup = root.querySelector('[data-backup]');
  backup.addEventListener('click', async () => {
    backup.disabled = true;
    status.textContent = 'Preparing and verifying backup…';
    try {
      const { createBackup, serializeBackup, verifyBackup } = await import('../core/backup.js');
      const envelope = await createBackup(await db.readCommittedVault());
      await verifyBackup(envelope);
      downloadText(serializeBackup(envelope), 'noteforge-recovery-backup.json', 'application/json');
      status.textContent = 'Portable backup verified and exported. Your stored vault has not been changed.';
    } catch (error) {
      status.textContent = `Backup could not be verified: ${error.message}. Download recovery source to preserve the original data.`;
    } finally {
      backup.disabled = false;
    }
  });
  document.body.replaceChildren(root);
  // Theme is a session preference here; it must not enqueue a vault mutation.
  new Theme({ config: db.config, setConfig() {} }, root.querySelector('[data-theme-toggle]'));
  root.querySelector('h2').focus();
}
