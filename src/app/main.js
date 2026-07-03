// Application controller: owns the database, wires the components together,
// coordinates the single "currently open note", handles global shortcuts, the
// graph/editor view switch, Trash, and JSON export/import.

import { Database } from '../core/database.js';
import { Editor } from '../components/editor.js';
import { NoteList } from '../components/note-list.js';
import { GraphView } from '../components/graph.js';
import { TrashView } from '../components/trash-view.js';
import { CommandPalette } from '../components/command-palette.js';
import { SettingsView } from '../components/settings-view.js';
import { Theme } from '../ui/theme.js';
import { normalizeSettings, FONT_SCALES } from '../ui/settings.js';
import { sampleNotes } from './seed.js';
import { TEMPLATES, templateById } from './templates.js';
import { registerServiceWorker } from './pwa.js';
import { renderMarkdown, setKnownTitles } from '../utils/markdown.js';
import { buildNoteHtmlDoc, flattenExportWikilinks, noteFileStem } from '../utils/export.js';

class App {
  constructor() {
    this.db = new Database();
    this.currentId = null;
    this.view = 'editor'; // 'editor' | 'graph'

    this.el = {
      editor: document.getElementById('editor'),
      graph: document.getElementById('graph'),
      list: document.getElementById('note-list'),
      tags: document.getElementById('tag-filter'),
      count: document.getElementById('note-count'),
      search: document.getElementById('search-input'),
      sort: document.getElementById('sort-select'),
      newBtn: document.getElementById('new-note-btn'),
      paletteBtn: document.getElementById('palette-btn'),
      templateBtn: document.getElementById('template-btn'),
      paletteOverlay: document.getElementById('palette-overlay'),
      paletteInput: document.getElementById('palette-input'),
      paletteList: document.getElementById('palette-list'),
      themeBtn: document.getElementById('theme-btn'),
      graphBtn: document.getElementById('graph-btn'),
      menuBtn: document.getElementById('menu-btn'),
      menuDropdown: document.getElementById('menu-dropdown'),
      exportBtn: document.getElementById('export-btn'),
      importBtn: document.getElementById('import-btn'),
      importFile: document.getElementById('import-file'),
      seedBtn: document.getElementById('seed-btn'),
      trashBtn: document.getElementById('trash-btn'),
      trashBadge: document.getElementById('trash-badge'),
      trashOverlay: document.getElementById('trash-overlay'),
      trashList: document.getElementById('trash-list'),
      trashEmpty: document.getElementById('trash-empty'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsOverlay: document.getElementById('settings-overlay'),
      settingsForm: document.getElementById('settings-form'),
      app: document.getElementById('app'),
      sidebar: document.querySelector('.sidebar'),
      mainEl: document.querySelector('.main'),
      sidebarToggle: document.getElementById('sidebar-toggle'),
      sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    };

    // Track the mobile breakpoint so the off-canvas sidebar can be made `inert`
    // when it's hidden off-screen (and the content inert when it's open over it).
    this.mobileMql = window.matchMedia('(max-width: 760px)');
    this.mobileMql.addEventListener
      ? this.mobileMql.addEventListener('change', () => this.#syncSidebarInert())
      : this.mobileMql.addListener?.(() => this.#syncSidebarInert());

    registerServiceWorker(); // production-only PWA offline support

    this.ready = this.#init().catch((err) => {
      console.error('[app] initialization failed:', err);
    });
  }

  async #init() {
    await this.db.init(); // async: load + migrate persisted state before rendering
    // Surface a persistence failure (both storage backends down) so silent
    // data loss becomes a visible, dismissible warning instead of console-only.
    this.db.onPersistError = () => this.#showStorageError();

    const actions = {
      openNote: (id) => this.openNote(id),
      openOrCreateByTitle: (title) => this.openOrCreateByTitle(title),
      deleteNote: (id) => this.deleteNote(id),
      togglePin: (id) => this.togglePin(id),
    };

    this.editor = new Editor(this.el.editor, this.db, actions);
    this.noteList = new NoteList(
      { list: this.el.list, tags: this.el.tags, count: this.el.count, search: this.el.search, sort: this.el.sort },
      this.db,
      {
        onOpen: (id) => this.openNote(id),
        onTogglePin: (id) => this.togglePin(id),
        onReparent: (id, parentId) => this.reparent(id, parentId),
        onNewChild: (parentId) => this.newChild(parentId),
      }
    );
    this.graph = new GraphView(this.el.graph, this.db, (id) => {
      this.setView('editor');
      this.openNote(id);
    });
    this.trash = new TrashView(
      { overlay: this.el.trashOverlay, list: this.el.trashList, empty: this.el.trashEmpty, badge: this.el.trashBadge },
      this.db,
      (id) => this.openNote(id)
    );
    this.palette = new CommandPalette(
      { overlay: this.el.paletteOverlay, input: this.el.paletteInput, list: this.el.paletteList },
      {
        getNotes: () => this.db.getAllNotes(),
        getCommands: () => this.#commands(),
        onOpenNote: (id) => this.openNote(id),
      }
    );
    this.theme = new Theme(this.db, this.el.themeBtn);
    this.settings = new SettingsView(
      { overlay: this.el.settingsOverlay, form: this.el.settingsForm },
      this.db,
      (s) => this.#applySettings(s)
    );
    // Apply persisted font/width/autosave on load (Theme already applied the theme).
    this.#applySettings(normalizeSettings(this.db.config));

    // Re-render list/graph whenever the store changes; editor refreshes itself.
    this.db.subscribe(() => {
      this.noteList.render();
      this.noteList.setActive(this.currentId);
      this.editor.refresh();
      if (this.view === 'graph') this.graph.render(this.currentId);
    });

    this.#wireChrome();
    this.#wireShortcuts();
    this.#wireDurability();
    this.#syncSidebarInert(); // initial mobile inert state

    // First-run seeding only when the vault is truly empty — NOT when every note
    // merely sits in the Trash (otherwise a reload of an all-deleted vault would
    // silently re-inject the sample notes alongside the user's trashed ones).
    if (this.db.notes.size === 0) {
      this.#seed();
    } else {
      this.noteList.render();
      const first = this.db.getNotesSorted()[0];
      if (first) this.openNote(first.id); // undefined when all notes are trashed -> empty editor
    }
  }

  // --- note selection -----------------------------------------------------

  openNote(id, opts) {
    const note = this.db.getNote(id);
    if (!note) return;
    this.currentId = id;
    this.setView('editor');
    this.editor.open(id, opts);
    this.noteList.reveal(id); // expand collapsed ancestors so the active note is visible in the outline
    this.noteList.setActive(id);
    this.#closeSidebar(); // on mobile, reveal the editor after picking a note
  }

  newNote() {
    this.editor?.flushPending(); // persist the outgoing note's buffered title/block edits first
    const tpl = templateById(this.db.config.defaultTemplate); // null unless a default is set
    if (tpl) return this.newFromTemplate(tpl);
    const note = this.db.createNote({ title: 'Untitled', content: '' });
    this.openNote(note.id, { focus: 'title' });
  }

  newFromTemplate(tpl) {
    this.editor?.flushPending();
    const { title, content } = tpl.build();
    const note = this.db.createNote({ title, content });
    this.openNote(note.id, { focus: 'content' });
  }

  /** Create a new note nested under `parentId`. */
  newChild(parentId) {
    this.editor?.flushPending();
    const note = this.db.createNote({ title: 'Untitled', content: '', parentId });
    this.noteList.expandTo(note.id); // reveal it if the parent was collapsed
    this.noteList.render();
    this.openNote(note.id, { focus: 'title' });
  }

  /** Re-nest a note under `parentId` (null = top level). Rejects cycles in the DB. */
  reparent(id, parentId) {
    if (this.currentId === id) this.editor?.flushPending();
    if (!this.db.setParent(id, parentId)) return; // no-op / rejected (cycle, missing parent)
    if (parentId) { this.noteList.expandTo(id); this.noteList.render(); } // reveal under new parent
  }

  /** Pin/unpin a note, flushing the editor first so buffered edits aren't lost. */
  togglePin(id) {
    const note = this.db.getNote(id);
    if (!note) return;
    if (this.currentId === id) this.editor?.flushPending();
    this.db.setPinned(id, !note.pinned);
    this.editor?.reflectPin(id); // keep the toolbar correct even if refresh() was suppressed
  }

  // --- settings + mobile sidebar ------------------------------------------

  #applySettings(s) {
    const root = document.documentElement;
    root.dataset.font = s.fontScale;   // CSS: html[data-font] .editor { font-size }
    root.dataset.width = s.editorWidth; // CSS: html[data-width] { --editor-measure }
    if (this.theme) this.theme.setMode(s.themeMode);
    if (this.editor) this.editor.setAutosaveInterval(s.autosaveMs);
  }

  #anyModalOpen() {
    return !!(this.trash?.open || this.palette?.open || this.settings?.open);
  }

  #toggleSidebar() {
    const open = this.el.app.classList.toggle('sidebar-open');
    this.el.sidebarBackdrop.hidden = !open;
    this.el.sidebarToggle?.setAttribute('aria-expanded', String(open));
    this.#syncSidebarInert();
  }

  #closeSidebar() {
    if (!this.el.app.classList.contains('sidebar-open')) return;
    this.el.app.classList.remove('sidebar-open');
    this.el.sidebarBackdrop.hidden = true;
    this.el.sidebarToggle?.setAttribute('aria-expanded', 'false');
    this.#syncSidebarInert();
  }

  // Dropdown menu (a disclosure): keep the button's aria-expanded synced with it.
  #setMenuOpen(open) {
    this.el.menuDropdown.hidden = !open;
    this.el.menuBtn.setAttribute('aria-expanded', String(open));
  }

  #closeMenu() {
    this.#setMenuOpen(false);
  }

  /** Persistent, dismissible banner shown when a save fails on both storage
   *  backends — the only user-visible signal that edits are no longer durable. */
  #showStorageError() {
    if (this._storageErrorBar && document.body.contains(this._storageErrorBar)) return;
    const bar = document.createElement('div');
    bar.className = 'storage-error';
    bar.setAttribute('role', 'alert');
    const msg = document.createElement('span');
    msg.textContent = "⚠️ Your changes couldn't be saved to storage. Export your notes (⋯ → Export JSON) to avoid losing them.";
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'storage-error__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => bar.remove());
    bar.append(msg, close);
    this._storageErrorBar = bar;
    document.body.appendChild(bar);
  }

  /** Focus the sidebar search — revealing the off-canvas sidebar first on mobile,
   *  where it would otherwise be inert and swallow the focus silently. */
  #focusSearch() {
    if (this.mobileMql.matches && !this.el.app.classList.contains('sidebar-open')) this.#toggleSidebar();
    this.noteList.focusSearch();
  }

  /** On mobile, keep the off-screen sidebar (or the covered content) out of the
   *  tab order and a11y tree. On desktop the sidebar is always live. */
  #syncSidebarInert() {
    const mobile = this.mobileMql.matches;
    const open = this.el.app.classList.contains('sidebar-open');
    if (this.el.sidebar) this.el.sidebar.inert = mobile && !open;
    if (this.el.mainEl) this.el.mainEl.inert = mobile && open;
  }

  /** Live command set for the palette (recomputed each keystroke → reflects state). */
  #commands() {
    const cur = this.currentId ? this.db.getNote(this.currentId) : null;
    const cmds = [
      { id: 'new', title: 'New note', hint: 'Create', icon: '📝', run: () => this.newNote() },
      ...TEMPLATES.map((t) => ({
        id: 'tpl-' + t.id,
        title: `New ${t.label.toLowerCase()}`,
        hint: 'Template',
        icon: t.icon,
        run: () => this.newFromTemplate(t),
      })),
      { id: 'search', title: 'Search notes', hint: 'Sidebar', icon: '🔍', run: () => this.#focusSearch() },
      { id: 'graph', title: this.view === 'graph' ? 'Close graph view' : 'Open graph view', hint: 'View', icon: '🕸️', run: () => this.toggleGraph() },
      { id: 'theme', title: 'Toggle dark / light theme', hint: 'Appearance', icon: '🌓', run: () => this.theme.toggle() },
      { id: 'trash', title: 'Open Trash', hint: `${this.db.getTrash().length} in trash`, icon: '🗑', run: () => this.trash.show() },
      { id: 'settings', title: 'Open settings', hint: 'Preferences', icon: '⚙', run: () => this.settings.show() },
      { id: 'export', title: 'Export notes as JSON', hint: 'Data', icon: '⬇', run: () => this.#export() },
      { id: 'import', title: 'Import notes from JSON', hint: 'Data', icon: '⬆', run: () => this.el.importFile.click() },
      { id: 'seed', title: 'Load sample notes', hint: 'Data', icon: '✨', run: () => this.#seed() },
    ];
    if (cur) {
      cmds.push({ id: 'child', title: 'New sub-note under current', hint: cur.title, icon: '↳', run: () => this.newChild(cur.id) });
      if (cur.parentId) cmds.push({ id: 'unnest', title: 'Move current note to top level', hint: cur.title, icon: '↤', run: () => this.reparent(cur.id, null) });
      cmds.push({ id: 'pin', title: cur.pinned ? 'Unpin current note' : 'Pin current note to top', hint: cur.title, icon: '📌', run: () => this.togglePin(cur.id) });
      cmds.push({ id: 'export-html', title: 'Export note as HTML', hint: 'Shareable page', icon: '🌐', run: () => this.exportNoteHtml(cur) });
      cmds.push({ id: 'export-md', title: 'Download note as Markdown', hint: 'Save .md', icon: '⬇', run: () => this.downloadNoteMarkdown(cur) });
      cmds.push({ id: 'del', title: 'Delete current note', hint: cur.title, icon: '🗑', run: () => this.deleteNote(cur.id) });
    }
    return cmds;
  }

  openOrCreateByTitle(title) {
    const existing = this.db.resolveTitle(title);
    if (existing) return this.openNote(existing.id);
    // If a note with this title is sitting in the Trash, restore it rather than
    // forking a second, live note with a duplicate title (which would make
    // wikilink/backlink/graph resolution ambiguous once both are live).
    const trashed = this.db.findTrashedByTitle(title);
    if (trashed) {
      this.db.restoreNote(trashed.id);
      return this.openNote(trashed.id);
    }
    const note = this.db.createNote({ title: title.trim() || 'Untitled', content: '' });
    this.openNote(note.id, { focus: 'content' });
  }

  /** Move a note to the Trash (recoverable) and advance to the next note. */
  deleteNote(id) {
    const note = this.db.getNote(id);
    if (!note) return;
    if (!confirm(`Move "${note.title || 'Untitled'}" to Trash? You can restore it later.`)) return;
    const wasCurrent = this.currentId === id;
    this.db.deleteNote(id); // soft-delete; the emit refreshes the (now empty) editor
    if (wasCurrent) {
      const next = this.db.getNotesSorted()[0];
      if (next) this.openNote(next.id);
      else this.currentId = null;
    }
  }

  // --- views --------------------------------------------------------------

  setView(view) {
    this.view = view;
    const showGraph = view === 'graph';
    this.el.graph.hidden = !showGraph;
    this.el.editor.hidden = showGraph;
    this.el.graphBtn.classList.toggle('btn--active', showGraph);
    if (showGraph) this.graph.render(this.currentId);
  }

  toggleGraph() {
    this.setView(this.view === 'graph' ? 'editor' : 'graph');
  }

  // --- chrome (buttons, menu, import/export) ------------------------------

  #wireChrome() {
    this.el.newBtn.addEventListener('click', () => this.newNote());
    this.el.graphBtn.addEventListener('click', () => this.toggleGraph());

    // Dropdown menu (a disclosure: keep aria-expanded in sync with visibility)
    this.el.menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#setMenuOpen(this.el.menuDropdown.hidden);
    });
    document.addEventListener('click', () => this.#closeMenu());
    this.el.menuDropdown.addEventListener('click', (e) => e.stopPropagation());

    this.el.exportBtn.addEventListener('click', () => this.#export());
    this.el.importBtn.addEventListener('click', () => this.el.importFile.click());
    this.el.importFile.addEventListener('change', (e) => this.#import(e));
    this.el.seedBtn.addEventListener('click', () => this.#seed());
    this.el.trashBtn.addEventListener('click', () => {
      this.#closeMenu();
      this.trash.show();
    });
    this.el.paletteBtn?.addEventListener('click', () => {
      this.#closeMenu();
      this.palette.show();
    });
    this.el.templateBtn?.addEventListener('click', () => {
      this.#closeMenu();
      this.palette.show('> new '); // pre-filter the palette to the New / template commands
    });
    this.el.settingsBtn?.addEventListener('click', () => {
      this.#closeMenu();
      this.settings.show();
    });
    this.el.sidebarToggle?.addEventListener('click', () => this.#toggleSidebar());
    this.el.sidebarBackdrop?.addEventListener('click', () => this.#closeSidebar());
  }

  #export() {
    const data = JSON.stringify(this.db.getAllNotes().map((n) => n.toJSON()), null, 2);
    this.#downloadBlob(data, `noteforge-export-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    this.#closeMenu();
  }

  /** Download arbitrary text as a file (shared by all export paths). */
  #downloadBlob(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Export one note as a self-contained, shareable HTML page. */
  exportNoteHtml(note) {
    if (!note) return;
    setKnownTitles(this.db.allTitles()); // so renderMarkdown resolves wikilink styling
    const inner = flattenExportWikilinks(renderMarkdown(note.content));
    this.#downloadBlob(buildNoteHtmlDoc(note.title, inner), `${noteFileStem(note.title)}.html`, 'text/html');
  }

  /** Download one note's raw markdown. */
  downloadNoteMarkdown(note) {
    if (!note) return;
    this.#downloadBlob(note.content, `${noteFileStem(note.title)}.md`, 'text/markdown');
  }

  async #import(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of notes.');
      let imported = 0;
      // Two passes so the outline survives import: notes get fresh ids (avoids
      // colliding with existing notes), and parentId is remapped old->new. A
      // parentId that referenced a non-imported note falls through to top level.
      const idMap = new Map(); // oldId -> newId
      const pendingParents = []; // { id, oldParent }
      for (const data of parsed) {
        if (data && typeof data.content === 'string') {
          const note = this.db.createNote({
            title: data.title || 'Untitled',
            content: data.content,
            tags: Array.isArray(data.tags) ? data.tags : [],
            banner: data.banner || null,
            pinned: !!data.pinned,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          });
          if (data.id) idMap.set(data.id, note.id);
          if (typeof data.parentId === 'string') pendingParents.push({ id: note.id, oldParent: data.parentId });
          imported++;
        }
      }
      for (const { id, oldParent } of pendingParents) {
        const newParent = idMap.get(oldParent);
        if (newParent) this.db.setParent(id, newParent); // db rejects cycles / missing parents
      }
      this.noteList.render();
      // Land the user in a note rather than the empty-state placeholder (matters
      // most when the vault was empty/all-trashed before the import).
      if (!this.currentId) {
        const first = this.db.getNotesSorted()[0];
        if (first) this.openNote(first.id);
      }
      alert(`Imported ${imported} note${imported === 1 ? '' : 's'}.`);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      event.target.value = ''; // allow re-importing the same file
    }
  }

  #seed() {
    let firstId = null;
    for (const data of sampleNotes) {
      const note = this.db.createNote(data);
      if (!firstId) firstId = note.id;
    }
    this.noteList.render();
    if (firstId) this.openNote(firstId);
  }

  // --- keyboard -----------------------------------------------------------

  #wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Command palette toggles even from within itself.
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if ((this.trash?.open || this.settings?.open) && !this.palette?.open) return; // don't stack over another modal
        this.palette.toggle();
        return;
      }
      // While a modal is open it owns the keyboard (each has its own Esc handler).
      // Don't let global shortcuts create notes / swap views / move focus behind it.
      if (this.#anyModalOpen()) return;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        this.newNote();
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.#focusSearch();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault(); // autosave already handles it; just prevent the dialog
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        this.toggleGraph();
      } else if (e.key === 'Escape') {
        if (!this.el.menuDropdown.hidden) { this.#closeMenu(); this.el.menuBtn.focus(); }
        else if (this.el.app.classList.contains('sidebar-open')) this.#closeSidebar();
        else if (this.view === 'graph') this.setView('editor');
      }
    });
  }

  // --- durability ---------------------------------------------------------

  #wireDurability() {
    // Best-effort durability before the tab goes away: first commit any pending
    // debounced autosave (so an edit typed within the 400ms window is queued),
    // then drain the write queue to storage.
    const flush = () => {
      this.editor?.flushPending();
      void this.db.flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
