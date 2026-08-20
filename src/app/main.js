// Application controller: owns the database, wires the components together,
// coordinates the single "currently open note", handles global shortcuts, the
// graph/editor view switch, Trash, and JSON export/import.

import { Database } from '../core/database.js';
import { storage } from '../core/storage.js';
import { Editor } from '../components/editor.js';
import { NoteList } from '../components/note-list.js';
import { Theme } from '../ui/theme.js';
import { normalizeSettings } from '../ui/settings.js';
import { TEMPLATES, templateById } from './templates.js';
import { registerServiceWorker } from './pwa.js';
import { extractHeadings, resolveHeadingAnchor } from '../utils/headings.js';
import { renderMarkdown, setKnownTitles } from '../utils/markdown.js';

class App {
  constructor() {
    this.db = new Database();
    this.currentId = null;
    this.view = 'editor'; // 'editor' | 'graph'
    this.navigation = { back: [], current: null, forward: [] };
    this.recentNoteIds = [];

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
      settingsBtn: document.getElementById('settings-btn'),
      historyBtn: document.getElementById('history-btn'),
      backupBtn: document.getElementById('backup-btn'),
      clipperBtn: document.getElementById('clipper-btn'),
      reconcileBtn: document.getElementById('reconcile-btn'),
      linkReportBtn: document.getElementById('link-report-btn'),
      archiveBtn: document.getElementById('archive-btn'),
      findReplaceBtn: document.getElementById('find-replace-btn'),
      todayBtn: document.getElementById('today-btn'),
      captureBtn: document.getElementById('capture-btn'),
      tasksBtn: document.getElementById('tasks-btn'),
      calendarBtn: document.getElementById('calendar-btn'),
      appStatus: document.getElementById('app-status'),
      navBack: document.getElementById('nav-back'),
      navForward: document.getElementById('nav-forward'),
      mobileNavBack: document.getElementById('mobile-nav-back'),
      mobileNavForward: document.getElementById('mobile-nav-forward'),
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

    this.ready = this.#init()
      .then(() => {
        this.#scheduleNavigationInitialization();
        this.#scheduleKnowledgeInitialization();
        this.#scheduleRecoveryInitialization();
        this.#scheduleSavedSearchesInitialization();
        this.#schedulePhase5Initialization();
        this.#schedulePhase6Initialization();
        const intakeUrl = new URL(window.location.href);
        if (['clipper', 'clipboard'].includes(intakeUrl.searchParams.get('capture'))) {
          window.history.replaceState(window.history.state, '', `${intakeUrl.pathname}${intakeUrl.hash}`);
          void this.#openClipperIntake(intakeUrl.href).catch((error) => {
            console.warn('[clipper] intake unavailable:', error);
            this.#announce(error?.message || 'Clipped content could not be opened.');
          });
        }
        else if (intakeUrl.searchParams.get('source') === 'share-target') void this.#openShareTarget().catch((error) => {
          console.warn('[capture] shared intake unavailable:', error);
          this.#announce(error?.message || 'Shared content could not be opened.');
        });
        return this;
      })
      .catch((err) => {
        console.error('[app] initialization failed:', err);
        throw err;
      });
  }

  async #init() {
    await this.db.init(); // async: load + migrate persisted state before rendering
    this.recentNoteIds = [...new Set(Array.isArray(this.db.config.recentNoteIds) ? this.db.config.recentNoteIds : [])]
      .filter((id) => typeof id === 'string' && this.db.getNote(id))
      .slice(0, 50);
    if (JSON.stringify(this.recentNoteIds) !== JSON.stringify(this.db.config.recentNoteIds || [])) {
      this.db.setConfig({ recentNoteIds: this.recentNoteIds });
    }
    // Surface a persistence failure (both storage backends down) so silent
    // data loss becomes a visible, dismissible warning instead of console-only.
    this.db.onPersistError = () => this.#showStorageError();
    this.db.onHistoryError = () => this.#showHistoryError();

    const actions = {
      openNote: (id) => this.openNote(id),
      openOrCreateByTitle: (title, fragment) => this.openOrCreateByTitle(title, fragment),
      deleteNote: (id) => this.deleteNote(id),
      togglePin: (id) => this.togglePin(id),
      requestRename: (id, title) => this.#showRename(id, title),
      previewMention: (mention) => this.#showMention(mention),
      showProperties: (id) => this.#showProperties(id),
      announce: (message) => this.#announce(message),
    };

    this.editor = new Editor(this.el.editor, this.db, actions);
    this.noteList = new NoteList(
      { list: this.el.list, tags: this.el.tags, count: this.el.count, search: this.el.search, sort: this.el.sort },
      this.db,
      {
        onOpen: (id) => this.openNote(id),
        onOpenArchived: (id) => this.#showArchive(id),
        onTogglePin: (id) => this.togglePin(id),
        onReparent: (id, parentId) => this.reparent(id, parentId),
        onNewChild: (parentId) => this.newChild(parentId),
        onSelectionChange: (ids) => this.#selectionChanged(ids),
      }
    );
    this.theme = new Theme(this.db, this.el.themeBtn);
    this.history = null; // loaded on first open to keep recovery UI out of the initial shell
    this.backup = null;
    // Apply persisted font/width/autosave on load (Theme already applied the theme).
    this.#applySettings(normalizeSettings(this.db.config));

    // Re-render list/graph whenever the store changes; editor refreshes itself.
    this.db.subscribe(() => {
      this.noteList.render();
      this.noteList.setActive(this.currentId);
      this.editor.refresh();
      this.el.historyBtn.disabled = !this.currentId || !this.db.getNote(this.currentId);
      this.#pruneNavigationState();
      if (this.view === 'graph') this.graph?.render(this.currentId);
    });

    this.#wireChrome();
    this.#wireShortcuts();
    this.#wireDurability();
    this.#syncSidebarInert(); // initial mobile inert state

    // First-run seeding only when the vault is truly empty — NOT when every note
    // merely sits in the Trash (otherwise a reload of an all-deleted vault would
    // silently re-inject the sample notes alongside the user's trashed ones).
    if (this.db.notes.size === 0) {
      await this.#seed();
    } else {
      this.noteList.render();
      const savedWorkspace = this.db.config.workspace;
      const savedPane = savedWorkspace?.panes?.[savedWorkspace?.activePane];
      const savedId = savedPane?.activeNoteId
        || savedWorkspace?.panes?.primary?.activeNoteId
        || savedWorkspace?.panes?.secondary?.activeNoteId;
      const first = this.db.getNote(savedId) || this.db.getNotesSorted()[0];
      if (first) this.openNote(first.id, { origin: 'reload' }); // undefined when all notes are trashed -> empty editor
    }
  }

  // --- note selection -----------------------------------------------------

  openNote(id, opts = {}) {
    if (this.phase6?.workspace && !opts.workspaceCommitted) return this.phase6.workspace.requestOpen(id, opts);
    return this.#openNoteNow(id, opts);
  }

  #openNoteNow(id, opts = {}) {
    const note = this.db.getNote(id);
    if (!note) return false;
    if (opts.origin === 'reload') {
      if (this.navigationController) {
        this.navigationController.replaceCurrent(id);
        this.#syncNavigationFrom(this.navigationController);
      } else {
        this.navigation = { ...this.navigation, current: id };
      }
    }
    else void this.#ensureNavigation().then((navigation) => {
      navigation.recordOpen(id, { replay: Boolean(opts.replay) });
      this.#syncNavigationFrom(navigation);
    }).catch((error) => {
      console.warn('[navigation] note-open history unavailable:', error);
    });
    this.currentId = id;
    this.el.historyBtn.disabled = false;
    this.setView('editor');
    const fragment = String(opts.fragment || '');
    const blockId = fragment.startsWith('^') ? fragment.slice(1) : null;
    const headingAnchor = blockId ? null : opts.headingAnchor || resolveHeadingAnchor(extractHeadings(note.content), fragment);
    this.editor.open(id, { ...opts, headingAnchor, blockId });
    this.noteList.reveal(id); // expand collapsed ancestors so the active note is visible in the outline
    this.noteList.setActive(id);
    this.#syncNavigationControls();
    this.#closeSidebar(); // on mobile, reveal the editor after picking a note
    return true;
  }

  #clearWorkspaceActive() {
    this.currentId = null;
    this.el.historyBtn.disabled = true;
    this.noteList.setActive(null);
    this.#syncNavigationControls();
    this.el.newBtn.focus();
  }

  #pruneNavigationState() {
    const valid = (id) => Boolean(this.db.getNote(id));
    if (this.navigationController) {
      this.navigationController.prune(valid);
      this.#syncNavigationFrom(this.navigationController);
    } else {
      this.navigation.back = this.navigation.back.filter(valid);
      this.navigation.forward = this.navigation.forward.filter(valid);
      if (this.navigation.current && !valid(this.navigation.current)) this.navigation.current = null;
      this.recentNoteIds = this.recentNoteIds.filter(valid);
    }
    this.#syncNavigationControls();
  }

  #syncNavigationControls() {
    const backDisabled = !this.navigation.back.some((id) => Boolean(this.db.getNote(id)));
    const forwardDisabled = !this.navigation.forward.some((id) => Boolean(this.db.getNote(id)));
    for (const button of [this.el.navBack, this.el.mobileNavBack]) if (button) button.disabled = backDisabled;
    for (const button of [this.el.navForward, this.el.mobileNavForward]) if (button) button.disabled = forwardDisabled;
  }

  async goBack() {
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.#showStorageError();
    const navigation = await this.#ensureNavigation();
    const id = navigation.back((noteId) => Boolean(this.db.getNote(noteId)));
    if (!id) return;
    this.#syncNavigationFrom(navigation);
    await this.openNote(id, { origin: 'back', replay: true });
  }

  async goForward() {
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.#showStorageError();
    const navigation = await this.#ensureNavigation();
    const id = navigation.forward((noteId) => Boolean(this.db.getNote(noteId)));
    if (!id) return;
    this.#syncNavigationFrom(navigation);
    await this.openNote(id, { origin: 'forward', replay: true });
  }

  newNote() {
    this.editor?.flushPending(); // persist the outgoing note's buffered title/block edits first
    const tpl = templateById(this.db.config.defaultTemplate); // null unless a default is set
    if (tpl) return this.newFromTemplate(tpl);
    const note = this.db.createNote({ title: this.db.availableTitle('Untitled'), content: '' });
    this.openNote(note.id, { focus: 'title' });
  }

  newFromTemplate(tpl) {
    this.editor?.flushPending();
    const { title, content } = tpl.build();
    const note = this.db.createNote({ title: this.db.availableTitle(title), content });
    this.openNote(note.id, { focus: 'content' });
  }

  async openDailyNote(date = null) {
    this.#closeMenu();
    this.#closeSidebar();
    return (await this.#ensurePhase4()).openDailyNote(date);
  }

  /** Create a new note nested under `parentId`. */
  newChild(parentId) {
    this.editor?.flushPending();
    const note = this.db.createNote({ title: this.db.availableTitle('Untitled'), content: '', parentId });
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

  #announce(message) {
    if (!this.el.appStatus) return;
    this.el.appStatus.textContent = '';
    requestAnimationFrame(() => { this.el.appStatus.textContent = String(message || ''); });
  }

  #anyModalOpen() {
    return !!(this.trash?.open || this.palette?.open || this.settings?.open || this.history?.open || this.backup?.open || this.linkTools?.open || this.archive?.open || this.savedSearches?.open || this.phase4?.open || this.phase5?.properties?.open || this.phase6?.open);
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

  /** Current-note persistence succeeded, but optional browser-local recovery did not. */
  #showHistoryError() {
    if (this._historyErrorBar && document.body.contains(this._historyErrorBar)) return;
    const bar = document.createElement('div');
    bar.className = 'storage-error storage-error--history';
    bar.setAttribute('role', 'status');
    const msg = document.createElement('span');
    msg.textContent = 'Your note was saved, but browser-local revision history is unavailable. Download a JSON backup from Backup center.';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'storage-error__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => bar.remove());
    bar.append(msg, close);
    this._historyErrorBar = bar;
    document.body.appendChild(bar);
  }

  async #captureRollingSnapshots() {
    await this.#ensureRecovery();
    await this.db.flushCurrentWrites();
    const status = await this.revisionStore.getStatus();
    if (!status.available) return;
    try {
      await this.recovery.ensureRollingSnapshots();
    } catch (error) {
      console.warn('[recovery] rolling local snapshots unavailable:', error);
    }
  }

  async #showHistory() {
    this.#closeMenu();
    await this.#ensureHistory();
    const note = this.currentId ? this.db.getNote(this.currentId) : null;
    if (!note) return;
    this.editor?.flushPending();
    await this.db.flush();
    await this.history.show(note.id);
  }

  async #showBackup() {
    this.#closeMenu();
    await this.#ensureBackup();
    this.editor?.flushPending();
    await this.db.flush();
    await this.backup.show();
  }

  async #ensureLinkTools() {
    if (this.linkTools) return this.linkTools;
    if (this.linkToolsReady) return this.linkToolsReady;
    this.linkToolsReady = Promise.all([
      import('../components/link-tools-view.js'),
      import('../core/knowledge-index.css'),
      this.db.initializeKnowledgeIndex(),
    ]).then(([{ LinkToolsView, createLinkToolsElements }]) => {
      this.linkTools = new LinkToolsView(createLinkToolsElements(), this.db, {
        onApplied: ({ mode, result }) => {
          if (mode === 'rename' && result.note) this.openNote(result.note.id, { discardPending: true, replay: true });
          else if (mode === 'mention' && result.target) this.editor?.refresh();
          this.linkTools?.modal.setReturnFocus(this.editor?.container?.querySelector('.editor__title'));
        },
      });
      return this.linkTools;
    }).catch((error) => {
      this.linkToolsReady = null;
      throw error;
    });
    return this.linkToolsReady;
  }

  async #showRename(noteId, proposedTitle) {
    const note = this.db.getNote(noteId);
    if (!note) return;
    this.editor?.flushPending();
    await this.db.flush();
    const tools = await this.#ensureLinkTools();
    tools.showRename(noteId, proposedTitle);
  }

  async #showMention(mention) {
    this.editor?.flushPending();
    await this.db.flush();
    const tools = await this.#ensureLinkTools();
    tools.showMention(mention);
  }

  async #showLinkReport() {
    this.#closeMenu();
    const tools = await this.#ensureLinkTools();
    tools.showReport();
  }

  async #ensureHistory() {
    if (this.history) return this.history;
    const [{ HistoryView, createHistoryElements }] = await Promise.all([
      import('../components/history-view.js'),
      this.#ensureRecovery(),
    ]);
    this.history = new HistoryView(
      createHistoryElements(),
      this.recovery,
      {
        confirmRestore: ({ message }) => confirm(message),
        onRestored: ({ note }) => this.openNote(note.id, { discardPending: true }),
        onRestoreCopy: ({ note }) => this.openNote(note.id),
      }
    );
    return this.history;
  }

  async #ensureBackup() {
    if (this.backup) return this.backup;
    const [{ BackupView, createBackupElements }] = await Promise.all([
      import('../components/backup-view.js'),
      this.#ensureRecovery(),
    ]);
    this.backup = new BackupView(
      createBackupElements(),
      this.recovery,
      {
        confirmRestore: ({ message }) => confirm(message),
        onRestored: () => this.#openFirstRestoredNote(),
      }
    );
    return this.backup;
  }

  #ensureRecovery() {
    if (this.recoveryReady) return this.recoveryReady;
    if (this.recovery) return Promise.resolve(this.recovery);
    this.recoveryReady = Promise.all([
      import('../core/revision-store.js'),
      import('../core/recovery-service.js'),
    ]).then(async ([{ RevisionStore }, { RecoveryService }]) => {
      this.revisionStore = new RevisionStore(storage);
      this.recovery = new RecoveryService({ db: this.db, revisionStore: this.revisionStore, storage });
      await this.recovery.ready;
      return this.recovery;
    }).catch((error) => {
      this.recoveryReady = null;
      this.recovery = null;
      this.revisionStore = null;
      throw error;
    });
    return this.recoveryReady;
  }

  #scheduleRecoveryInitialization() {
    const initialize = () => {
      void this.#ensureRecovery()
        .then(() => this.#captureRollingSnapshots())
        .catch((error) => {
          console.warn('[recovery] deferred initialization unavailable:', error);
          this.#showHistoryError();
        });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 2_000 });
    else setTimeout(initialize, 0);
  }

  #scheduleKnowledgeInitialization() {
    const initialize = () => {
      void Promise.all([
        import('../core/knowledge-index.css'),
        this.db.initializeKnowledgeIndex(),
        this.editor.enableOutline(),
      ]).catch((error) => {
        console.warn('[links] deferred contextual index unavailable:', error);
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 1_000 });
    else setTimeout(initialize, 0);
  }

  #ensureNavigation() {
    if (this.navigationController) return Promise.resolve(this.navigationController);
    if (this.navigationReady) return this.navigationReady;
    this.navigationReady = import('../utils/navigation.js').then(({ NavigationController }) => {
      this.navigationController = new NavigationController(this.db, {
        state: this.navigation,
        recentIds: this.recentNoteIds,
      });
      this.#syncNavigationFrom(this.navigationController);
      return this.navigationController;
    }).catch((error) => {
      this.navigationReady = null;
      throw error;
    });
    return this.navigationReady;
  }

  #scheduleNavigationInitialization() {
    const initialize = () => void this.#ensureNavigation().catch((error) => {
      console.warn('[navigation] deferred initialization unavailable:', error);
    });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 500 });
    else setTimeout(initialize, 0);
  }

  #ensureGraph() {
    if (this.graph) return Promise.resolve(this.graph);
    if (this.graphReady) return this.graphReady;
    this.graphReady = import('../components/graph.js').then(({ GraphView }) => {
      this.graph = new GraphView(this.el.graph, this.db, (id) => {
        this.setView('editor');
        this.openNote(id);
      });
      return this.graph;
    }).catch((error) => {
      this.graphReady = null;
      throw error;
    });
    return this.graphReady;
  }

  #ensureTrash() {
    if (this.trash) return Promise.resolve(this.trash);
    if (this.trashReady) return this.trashReady;
    this.trashReady = import('../components/trash-view.js').then(({ TrashView, createTrashElements }) => {
      this.trash = new TrashView(createTrashElements({ badge: this.el.trashBadge }), this.db, (id, { archived = false } = {}) => {
        if (archived) void this.#showArchive(id);
        else this.openNote(id);
      });
      return this.trash;
    }).catch((error) => {
      this.trashReady = null;
      throw error;
    });
    return this.trashReady;
  }

  #ensurePalette() {
    if (this.palette) return Promise.resolve(this.palette);
    if (this.paletteReady) return this.paletteReady;
    this.paletteReady = import('../components/command-palette.js').then(({ CommandPalette, createCommandPaletteElements }) => {
      this.palette = new CommandPalette(createCommandPaletteElements(), {
        getNotes: () => this.db.getAllNotes(),
        getRecentNotes: () => this.recentNoteIds.map((id) => this.db.getNote(id)).filter(Boolean),
        getCommands: () => this.#commands(),
        onOpenNote: (id) => this.openNote(id),
        onOpenHeading: (id, headingAnchor) => this.openNote(id, { headingAnchor }),
      });
      return this.palette;
    }).catch((error) => {
      this.paletteReady = null;
      throw error;
    });
    return this.paletteReady;
  }

  #ensureSettings() {
    if (this.settings) return Promise.resolve(this.settings);
    if (this.settingsReady) return this.settingsReady;
    this.settingsReady = import('../components/settings-view.js').then(({ SettingsView, createSettingsElements }) => {
      this.settings = new SettingsView(createSettingsElements(), this.db, (settings) => this.#applySettings(settings));
      return this.settings;
    }).catch((error) => {
      this.settingsReady = null;
      throw error;
    });
    return this.settingsReady;
  }

  #ensureArchive() {
    if (this.archive) return Promise.resolve(this.archive);
    if (this.archiveReady) return this.archiveReady;
    this.archiveReady = import('../components/archive-view.js').then(({ ArchiveView, createArchiveElements }) => {
      this.archive = new ArchiveView(createArchiveElements(), this.db, {
        onRestored: (id) => this.openNote(id, { discardPending: true }),
      });
      return this.archive;
    }).catch((error) => {
      this.archiveReady = null;
      throw error;
    });
    return this.archiveReady;
  }

  #ensureFindReplace() {
    if (this.findReplace) return Promise.resolve(this.findReplace);
    if (this.findReplaceReady) return this.findReplaceReady;
    this.findReplaceReady = Promise.all([
      import('../components/find-replace-view.js'),
      this.#ensureRecovery(),
    ]).then(([{ FindReplaceView, createFindReplaceElements }]) => {
      this.findReplace = new FindReplaceView(createFindReplaceElements(), this.db, this.editor, {
        confirmVaultApply: ({ message }) => confirm(message),
        onApplied: () => this.noteList.render(),
      });
      return this.findReplace;
    }).catch((error) => {
      this.findReplaceReady = null;
      throw error;
    });
    return this.findReplaceReady;
  }

  #ensureSavedSearches() {
    if (this.savedSearches) return Promise.resolve(this.savedSearches);
    if (this.savedSearchesReady) return this.savedSearchesReady;
    this.savedSearchesReady = import('../components/saved-searches-view.js').then(({ SavedSearchesView, createSavedSearchElements }) => {
      this.savedSearches = new SavedSearchesView(createSavedSearchElements(), this.db, this.noteList, {
        onRun: () => this.#closeSidebar(),
      });
      return this.savedSearches;
    }).catch((error) => {
      this.savedSearchesReady = null;
      throw error;
    });
    return this.savedSearchesReady;
  }

  #scheduleSavedSearchesInitialization() {
    const initialize = () => void this.#ensureSavedSearches().catch((error) => {
      console.warn('[search] deferred saved views unavailable:', error);
    });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 1_500 });
    else setTimeout(initialize, 0);
  }

  #ensurePhase4() {
    if (this.phase4) return Promise.resolve(this.phase4);
    if (this.phase4Ready) return this.phase4Ready;
    this.phase4Ready = import('./phase4.js').then(({ Phase4Controller }) => {
      this.phase4 = new Phase4Controller({
        db: this.db,
        editor: this.editor,
        openNote: (id, options) => this.openNote(id, options),
        showStorageError: () => this.#showStorageError(),
        announce: (message) => this.#announce(message),
      });
      return this.phase4;
    }).catch((error) => { this.phase4Ready = null; throw error; });
    return this.phase4Ready;
  }

  #ensurePhase5() {
    if (this.phase5Ready) return this.phase5Ready;
    if (this.phase5) return Promise.resolve(this.phase5);
    this.phase5Ready = Promise.all([
      import('./phase5.js'),
      import('../components/properties-view.css'),
      this.#ensureRecovery(),
    ]).then(async ([{ Phase5Controller }]) => {
      this.phase5 = new Phase5Controller({
        db: this.db,
        editor: this.editor,
        ensureRecovery: () => this.#ensureRecovery(),
        announce: (message) => this.#announce(message),
        refreshSearch: () => this.noteList.render(),
      });
      await this.phase5.ready;
      return this.phase5;
    }).catch((error) => {
      this.phase5Ready = null;
      this.phase5 = null;
      throw error;
    });
    return this.phase5Ready;
  }

  #schedulePhase5Initialization() {
    const initialize = () => void this.#ensurePhase5().catch((error) => {
      console.warn('[properties] deferred initialization unavailable:', error);
    });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 2_500 });
    else setTimeout(initialize, 0);
  }

  #ensurePhase6() {
    if (this.phase6Ready) return this.phase6Ready;
    if (this.phase6) return this.phase6.ready;
    const primaryEditor = this.editor;
    this.phase6Ready = import('./phase6.js').then(async ({ Phase6Controller }) => {
      this.phase6 = new Phase6Controller({
        db: this.db,
        primaryEditor,
        primaryElement: this.el.editor,
        onWorkspaceCreated: (workspace) => {
          this.workspace = workspace;
          this.editor = workspace;
          workspace.element.hidden = this.view === 'graph';
          if (this.phase4) this.phase4.editor = workspace;
          if (this.phase5) this.phase5.editor = workspace;
          if (this.findReplace) this.findReplace.editor = workspace;
        },
        commitOpen: (id, options) => this.#openNoteNow(id, options),
        clearActive: () => this.#clearWorkspaceActive(),
        openArchived: (id) => this.#showArchive(id),
        ensureRecovery: () => this.#ensureRecovery(),
        showQuickCapture: (options) => this.#showQuickCapture(options),
        showStorageError: () => this.#showStorageError(),
        announce: (message) => this.#announce(message),
      });
      await this.phase6.ready;
      return this.phase6;
    }).catch((error) => {
      this.phase6?.workspace?.destroy?.();
      this.phase6Ready = null;
      this.phase6 = null;
      this.workspace = null;
      this.editor = primaryEditor;
      throw error;
    });
    return this.phase6Ready;
  }

  #schedulePhase6Initialization() {
    const initialize = () => void this.#ensurePhase6().catch((error) => {
      console.warn('[workspace] deferred initialization unavailable:', error);
    });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(initialize, { timeout: 3_000 });
    else setTimeout(initialize, 0);
  }

  async #showProperties(noteId = this.currentId) {
    this.#closeMenu();
    const phase5 = await this.#ensurePhase5();
    this.editor?.flushPending();
    await this.db.flush();
    await phase5.showProperties(noteId);
  }

  async #showQuickCapture(options = {}) {
    this.#closeMenu();
    this.#closeSidebar();
    return (await this.#ensurePhase4()).showQuickCapture(options);
  }

  async #showTaskDashboard() {
    this.#closeMenu();
    this.#closeSidebar();
    await this.#ensureRecovery();
    return (await this.#ensurePhase4()).showTaskDashboard();
  }

  async #showCalendar(options = {}) {
    this.#closeMenu();
    this.#closeSidebar();
    return (await this.#ensurePhase4()).showCalendar(options);
  }

  async #openShareTarget() {
    return (await this.#ensurePhase4()).openShareTarget();
  }

  async #openClipperIntake() {
    return (await this.#ensurePhase6()).openClipperIntake();
  }

  async #showClipper() {
    this.#closeMenu();
    return (await this.#ensurePhase6()).showClipper();
  }

  async #showReconciliation() {
    this.#closeMenu();
    this.#closeSidebar();
    return (await this.#ensurePhase6()).showReconciliation();
  }

  #selectionChanged(ids) {
    if (!ids.length && !this.bulkActions) return;
    void this.#ensureBulkActions().then((view) => view.update(ids)).catch((error) => {
      console.warn('[bulk] actions unavailable:', error);
    });
  }

  #ensureBulkActions() {
    if (this.bulkActions) return Promise.resolve(this.bulkActions);
    if (this.bulkActionsReady) return this.bulkActionsReady;
    this.bulkActionsReady = Promise.all([
      import('../components/bulk-actions-view.js'),
      this.#ensureRecovery(),
    ]).then(([{ BulkActionsView, createBulkActionElements }]) => {
      this.bulkActions = new BulkActionsView(createBulkActionElements(), this.db, this.noteList, {
        confirmAction: ({ message }) => confirm(message),
        onApplied: () => this.#syncCurrentAfterBatch(),
      });
      return this.bulkActions;
    }).catch((error) => {
      this.bulkActionsReady = null;
      throw error;
    });
    return this.bulkActionsReady;
  }

  #syncCurrentAfterBatch() {
    if (!this.currentId || this.db.getNote(this.currentId)) return;
    this.currentId = null;
    const next = this.db.getNotesSorted()[0];
    if (next) this.openNote(next.id);
    else this.editor?.refresh();
  }

  async #showTrash() {
    this.#closeMenu();
    (await this.#ensureTrash()).show();
  }

  async #showPalette(prefill = '') {
    this.#closeMenu();
    (await this.#ensurePalette()).show(prefill);
  }

  async #showSettings() {
    this.#closeMenu();
    (await this.#ensureSettings()).show();
  }

  async #showArchive(selectedId = null) {
    this.#closeMenu();
    (await this.#ensureArchive()).show({ selectedId });
  }

  async #showFindReplace(scope = 'current') {
    this.#closeMenu();
    this.#closeSidebar();
    const view = await this.#ensureFindReplace();
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.#showStorageError();
    view.show({ scope });
  }

  #syncNavigationFrom(controller) {
    this.navigation = controller.state;
    this.recentNoteIds = controller.recentIds;
    this.#syncNavigationControls();
  }

  #openFirstRestoredNote() {
    this.currentId = null;
    const first = this.db.getNotesSorted()[0];
    if (first) this.openNote(first.id, { discardPending: true });
    else this.editor?.refresh();
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
      { id: 'today', title: "Open Today’s Note", hint: 'Local Daily note · Ctrl/⌘ Shift D', icon: '◫', run: () => this.openDailyNote() },
      { id: 'capture', title: 'Quick Capture', hint: 'Text, URL, clipboard, image · Ctrl/⌘ Shift C', icon: '↘', run: () => this.#showQuickCapture() },
      { id: 'tasks', title: 'Open task dashboard', hint: 'Today, overdue, upcoming', icon: '☑', run: () => this.#showTaskDashboard() },
      { id: 'calendar', title: 'Open calendar', hint: 'Month and week', icon: '▦', run: () => this.#showCalendar() },
      ...TEMPLATES.map((t) => ({
        id: 'tpl-' + t.id,
        title: `New ${t.label.toLowerCase()}`,
        hint: 'Template',
        icon: t.icon,
        run: () => this.newFromTemplate(t),
      })),
      { id: 'search', title: 'Search notes', hint: 'Sidebar', icon: '🔍', run: () => this.#focusSearch() },
      { id: 'back', title: 'Go back to previous note', hint: 'Navigation · Alt+Left', icon: '←', run: () => this.goBack() },
      { id: 'forward', title: 'Go forward to next note', hint: 'Navigation · Alt+Right', icon: '→', run: () => this.goForward() },
      { id: 'graph', title: this.view === 'graph' ? 'Close graph view' : 'Open graph view', hint: 'View', icon: '🕸️', run: () => this.toggleGraph() },
      { id: 'theme', title: 'Toggle dark / light theme', hint: 'Appearance', icon: '🌓', run: () => this.theme.toggle() },
      { id: 'find', title: 'Find and replace in current note', hint: 'Source Markdown · Ctrl/⌘ F', icon: '⌕', run: () => this.#showFindReplace('current') },
      { id: 'find-vault', title: 'Find and replace across vault', hint: 'Preview required', icon: '⌕', run: () => this.#showFindReplace('vault') },
      { id: 'archive-view', title: 'Open Archive', hint: `${this.db.getArchived().length} archived`, icon: '🗄', run: () => this.#showArchive() },
      { id: 'trash', title: 'Open Trash', hint: `${this.db.getTrash().length} in trash`, icon: '🗑', run: () => this.#showTrash() },
      { id: 'settings', title: 'Open settings', hint: 'Preferences', icon: '⚙', run: () => this.#showSettings() },
      { id: 'backup', title: 'Open Backup center', hint: 'Recovery', icon: '🛟', run: () => this.#showBackup() },
      { id: 'clipper', title: 'Set up web clipper', hint: 'Capture web pages', icon: '✂', run: () => this.#showClipper() },
      { id: 'reconcile', title: 'Reconcile Markdown folder', hint: 'Preview, backup, then apply', icon: '⇄', run: () => this.#showReconciliation() },
      { id: 'link-report', title: 'Open link integrity report', hint: 'Knowledge graph', icon: '🔗', run: () => this.#showLinkReport() },
      { id: 'export', title: 'Export notes as JSON', hint: 'Data', icon: '⬇', run: () => this.#export() },
      { id: 'import', title: 'Import notes from JSON', hint: 'Data', icon: '⬆', run: () => this.el.importFile.click() },
      { id: 'seed', title: 'Load sample notes', hint: 'Data', icon: '✨', run: () => this.#seed() },
      ...(this.savedSearches?.commands() || []),
    ];
    // Save-to-folder needs the File System Access API (Chromium) — only offer it there.
    if (window.showDirectoryPicker) {
      cmds.push({ id: 'save-folder', title: 'Save all notes to a folder…', hint: 'Markdown vault', icon: '📁', run: () => this.saveVaultToFolder() });
    }
    if (cur) {
      cmds.push({ id: 'properties', title: 'Edit note properties', hint: 'YAML frontmatter', icon: '◇', run: () => this.#showProperties(cur.id) });
      cmds.push({ id: 'history', title: 'Open revision history', hint: cur.title, icon: '↶', run: () => this.#showHistory() });
      cmds.push({ id: 'archive', title: 'Archive current note', hint: cur.title, icon: '🗄', run: () => this.#archiveCurrent() });
      cmds.push({ id: 'child', title: 'New sub-note under current', hint: cur.title, icon: '↳', run: () => this.newChild(cur.id) });
      if (cur.parentId) cmds.push({ id: 'unnest', title: 'Move current note to top level', hint: cur.title, icon: '↤', run: () => this.reparent(cur.id, null) });
      cmds.push({ id: 'pin', title: cur.pinned ? 'Unpin current note' : 'Pin current note to top', hint: cur.title, icon: '📌', run: () => this.togglePin(cur.id) });
      cmds.push({ id: 'export-html', title: 'Export note as HTML', hint: 'Shareable page', icon: '🌐', run: () => this.exportNoteHtml(cur) });
      cmds.push({ id: 'export-md', title: 'Download note as Markdown', hint: 'Save .md', icon: '⬇', run: () => this.downloadNoteMarkdown(cur) });
      cmds.push({ id: 'del', title: 'Delete current note', hint: cur.title, icon: '🗑', run: () => this.deleteNote(cur.id) });
    }
    return cmds;
  }

  openOrCreateByTitle(title, fragment = null) {
    const resolution = this.db.resolveTitleResult(title);
    if (resolution.status === 'resolved') return this.openNote(resolution.note.id, { fragment });
    if (resolution.status === 'ambiguous') {
      void this.#showLinkReport();
      return;
    }
    // If a note with this title is sitting in the Trash, restore it rather than
    // forking a second, live note with a duplicate title (which would make
    // wikilink/backlink/graph resolution ambiguous once both are live).
    const trashed = this.db.findTrashedByTitle(title);
    if (trashed) {
      this.db.restoreNote(trashed.id);
      return this.openNote(trashed.id, { fragment });
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

  async #archiveCurrent() {
    const note = this.currentId ? this.db.getNote(this.currentId) : null;
    if (!note) return;
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.#showStorageError();
    const id = note.id;
    if (!this.db.archiveNote(id)) return;
    const next = this.db.getNotesSorted()[0];
    this.currentId = null;
    if (next) this.openNote(next.id);
    else this.editor?.refresh();
  }

  // --- views --------------------------------------------------------------

  setView(view) {
    this.view = view;
    const showGraph = view === 'graph';
    this.el.graph.hidden = !showGraph;
    (this.workspace?.element || this.el.editor).hidden = showGraph;
    this.el.graphBtn.classList.toggle('btn--active', showGraph);
    if (showGraph) this.graph?.render(this.currentId);
  }

  async toggleGraph() {
    if (this.view === 'graph') return this.setView('editor');
    await this.#ensureGraph();
    this.editor?.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.#showStorageError();
    this.setView('graph');
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
    this.el.trashBtn.addEventListener('click', () => this.#showTrash());
    this.el.paletteBtn?.addEventListener('click', () => this.#showPalette());
    this.el.templateBtn?.addEventListener('click', () => this.#showPalette('> new '));
    this.el.settingsBtn?.addEventListener('click', () => this.#showSettings());
    this.el.historyBtn?.addEventListener('click', () => this.#showHistory());
    this.el.backupBtn?.addEventListener('click', () => this.#showBackup());
    this.el.clipperBtn?.addEventListener('click', () => this.#showClipper());
    this.el.reconcileBtn?.addEventListener('click', () => this.#showReconciliation());
    this.el.linkReportBtn?.addEventListener('click', () => this.#showLinkReport());
    this.el.archiveBtn?.addEventListener('click', () => this.#showArchive());
    this.el.findReplaceBtn?.addEventListener('click', () => this.#showFindReplace('current'));
    this.el.todayBtn?.addEventListener('click', () => this.openDailyNote());
    this.el.captureBtn?.addEventListener('click', () => this.#showQuickCapture());
    this.el.tasksBtn?.addEventListener('click', () => this.#showTaskDashboard());
    this.el.calendarBtn?.addEventListener('click', () => this.#showCalendar());
    for (const button of [this.el.navBack, this.el.mobileNavBack]) button?.addEventListener('click', () => this.goBack());
    for (const button of [this.el.navForward, this.el.mobileNavForward]) button?.addEventListener('click', () => this.goForward());
    this.el.sidebarToggle?.addEventListener('click', () => this.#toggleSidebar());
    this.el.sidebarBackdrop?.addEventListener('click', () => this.#closeSidebar());
  }

  async #export() {
    // Archive is a live lifecycle state, not deletion. Keep archived notes and
    // archivedAt in the legacy merge-export format; Trash remains exclusive to
    // the complete portable backup flow.
    const data = JSON.stringify(this.db.getNotesInScope('nontrash').map((n) => n.toJSON()), null, 2);
    await this.#downloadBlob(data, `noteforge-export-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    this.#closeMenu();
  }

  /** Download arbitrary text as a file (shared by all export paths). */
  async #downloadBlob(text, filename, type) {
    const { downloadText } = await import('../utils/download.js');
    downloadText(text, filename, type);
  }

  /** Export one note as a self-contained, shareable HTML page. */
  async exportNoteHtml(note) {
    if (!note) return;
    const { buildNoteHtmlDoc, flattenExportWikilinks, noteFileStem } = await import('../utils/export.js');
    setKnownTitles(this.db.allTitles()); // so renderMarkdown resolves wikilink styling
    const inner = flattenExportWikilinks(renderMarkdown(note.content, { resolveNote: (title) => this.db.resolveTitle(title), sourceNoteId: note.id }));
    await this.#downloadBlob(buildNoteHtmlDoc(note.title, inner), `${noteFileStem(note.title)}.html`, 'text/html');
  }

  /** Download one note's raw markdown. */
  async downloadNoteMarkdown(note) {
    if (!note) return;
    const { noteFileStem } = await import('../utils/export.js');
    await this.#downloadBlob(note.content, `${noteFileStem(note.title)}.md`, 'text/markdown');
  }

  /** Save the whole (live) vault to a chosen folder as Obsidian-compatible .md files. */
  async saveVaultToFolder() {
    if (!window.showDirectoryPicker) {
      alert("Saving to a folder needs a Chromium-based browser (Chrome/Edge). Use Export JSON instead.");
      return;
    }
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch {
      return; // user dismissed the picker
    }
    try {
      const { writeVaultToDir } = await import('../utils/vault.js');
      const written = await writeVaultToDir(dir, this.db.getAllNotes());
      alert(`Saved ${written} note${written === 1 ? '' : 's'} to the folder as Markdown files.`);
    } catch (err) {
      console.warn('[vault] save failed:', err);
      alert("Couldn't finish saving to that folder. Check the folder's write permission and try again.");
    }
  }

  async #import(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const { parseNoteMergeImport, selectImportableNotes } = await import('../utils/json-import.js');
      const parsed = parseNoteMergeImport(await file.text());
      let imported = 0;
      // Two passes so the outline survives import: notes get fresh ids (avoids
      // colliding with existing notes), and parentId is remapped old->new. A
      // parentId that referenced a non-imported note falls through to top level.
      const idMap = new Map(); // oldId -> newId
      const pendingParents = []; // { id, oldParent }
      for (const data of selectImportableNotes(parsed)) {
        const note = this.db.createNote({
          title: data.title || 'Untitled',
          content: data.content,
          tags: Array.isArray(data.tags) ? data.tags : [],
          banner: data.banner || null,
          pinned: !!data.pinned,
          aliases: Array.isArray(data.aliases) ? data.aliases : [],
          archivedAt: typeof data.archivedAt === 'string' ? data.archivedAt : null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        }, { allowIdentityConflicts: true });
        if (data.id) idMap.set(data.id, note.id);
        if (typeof data.parentId === 'string') pendingParents.push({ id: note.id, oldParent: data.parentId });
        imported++;
      }
      for (const { id, oldParent } of pendingParents) {
        const newParent = idMap.get(oldParent);
        if (newParent) this.db.setParent(id, newParent, { includeArchived: true }); // db rejects cycles / missing parents
      }
      this.noteList.render();
      // Land the user in a note rather than the empty-state placeholder (matters
      // most when the vault was empty/all-trashed before the import).
      if (!this.currentId) {
        const first = this.db.getNotesSorted()[0];
        if (first) this.openNote(first.id);
      }
      const tools = await this.#ensureLinkTools();
      const report = tools.integrityReport();
      if (report.healthy) {
        alert(`Imported ${imported} note${imported === 1 ? '' : 's'}.`);
      } else {
        alert(`Imported ${imported} note${imported === 1 ? '' : 's'}. ${report.ambiguities.length} ambiguous title or alias group${report.ambiguities.length === 1 ? '' : 's'} need repair; NoteForge will never guess those link targets.`);
        tools.showReport();
      }
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      event.target.value = ''; // allow re-importing the same file
    }
  }

  async #seed() {
    const { sampleNotes } = await import('./seed.js');
    let firstId = null;
    for (const data of sampleNotes) {
      const existing = this.db.resolveTitleResult(data.title);
      if (existing.status === 'resolved') {
        if (!firstId) firstId = existing.note.id;
        continue;
      }
      if (existing.status === 'ambiguous') continue;
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
        if (this.#anyModalOpen() && !this.palette?.open) return; // don't stack over another modal
        if (this.palette?.open) this.palette.close();
        else void this.#showPalette();
        return;
      }
      // While a modal is open it owns the keyboard (each has its own Esc handler).
      // Don't let global shortcuts create notes / swap views / move focus behind it.
      if (this.#anyModalOpen()) return;
      if (e.ctrlKey && e.key === 'PageUp' && this.workspace) {
        e.preventDefault();
        void this.workspace.cycle(-1);
      } else if (e.ctrlKey && e.key === 'PageDown' && this.workspace) {
        e.preventDefault();
        void this.workspace.cycle(1);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        this.newNote();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void this.openDailyNote();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void this.#showQuickCapture();
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.#focusSearch();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void this.#showFindReplace('current');
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault(); // autosave already handles it; just prevent the dialog
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        this.toggleGraph();
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        void this.goBack();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void this.goForward();
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
