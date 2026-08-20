import './workspace-view.css';
import { Editor } from './editor.js';
import {
  WORKSPACE_PANES,
  activateWorkspacePane,
  closeWorkspaceTab,
  moveWorkspaceTab,
  normalizeWorkspaceState,
  openWorkspaceNote,
  reopenWorkspaceTab,
  reorderWorkspaceTab,
  setWorkspaceRatio,
  setWorkspaceScroll,
  setWorkspaceSplit,
} from '../utils/workspace.js';
import { escapeHtml } from '../utils/helpers.js';

const otherPane = (name) => name === 'primary' ? 'secondary' : 'primary';

export class WorkspaceView {
  constructor({
    primaryElement,
    primaryEditor,
    db,
    actions,
    beforeHandoff,
    onCommitOpen,
    onEmpty,
    onArchived,
    onStorageError,
    announce = () => {},
  }) {
    this.db = db;
    this.actions = actions;
    this.beforeHandoff = beforeHandoff;
    this.onCommitOpen = onCommitOpen;
    this.onEmpty = onEmpty;
    this.onArchived = onArchived;
    this.onStorageError = onStorageError;
    this.announce = announce;
    this.primaryEditor = primaryEditor;
    this.state = normalizeWorkspaceState(db.config.workspace, [...db.notes.values()]);
    if (!this.state.panes.primary.tabs.length && !this.state.panes.secondary.tabs.length && primaryEditor.currentId) {
      this.state = openWorkspaceNote(this.state, primaryEditor.currentId, 'primary');
    }
    this.#mount(primaryElement);
    this.secondaryEditor = new Editor(this.secondaryElement, db, actions);
    if (primaryEditor.phase5Enhancer) this.secondaryEditor.enablePhase5(primaryEditor.phase5Enhancer);
    if (primaryEditor.OutlineView) void this.secondaryEditor.enableOutline();
    this.editors = { primary: primaryEditor, secondary: this.secondaryEditor };
    this.scrollTimers = new Map();
    this.dragged = null;
    this.paneActivations = new Map();
    this.#wire();
    this.#render();
  }

  async initialize() {
    const primaryId = this.state.panes.primary.activeNoteId;
    const secondaryId = this.state.panes.secondary.activeNoteId;
    const outgoingId = this.primaryEditor.currentId;
    const activeId = this.state.panes[this.state.activePane].activeNoteId || primaryId || secondaryId;
    const transfersOwner = Boolean(outgoingId && (primaryId !== outgoingId || activeId !== outgoingId));
    if (transfersOwner && !await this.#durableHandoff()) {
      this.#preservePrimaryOwner(outgoingId);
      this.#render();
      this.#restoreScroll('primary');
      return this;
    }
    if (primaryId && primaryId !== outgoingId) this.primaryEditor.open(primaryId, { discardPending: true });
    if (secondaryId) this.secondaryEditor.open(secondaryId, { discardPending: true });
    if (activeId && activeId !== outgoingId) {
      this.state.activePane = this.#locate(activeId)?.pane || this.state.activePane;
      await this.onCommitOpen(activeId, {
        origin: 'reload', replay: true, workspaceCommitted: true, preserveEditor: true,
      });
    }
    this.#restoreScroll();
    this.#persist();
    return this;
  }

  #mount(primaryElement) {
    this.element = document.createElement('section');
    this.element.id = 'workspace';
    this.element.className = 'workspace';
    this.element.innerHTML = `
      <header class="workspace__toolbar" aria-label="Workspace controls">
        <div class="workspace__pane-switch" role="group" aria-label="Visible pane on small screens">
          <button type="button" class="btn btn--ghost" data-pane-visible="primary">Pane 1</button>
          <button type="button" class="btn btn--ghost" data-pane-visible="secondary">Pane 2</button>
        </div>
        <span class="workspace__status muted" aria-live="polite"></span>
        <button type="button" class="btn btn--ghost" data-reopen>Reopen tab</button>
        <button type="button" class="btn btn--ghost" data-split aria-pressed="false">Split view</button>
      </header>
      <div class="workspace__panes">
        <section class="workspace__pane" data-pane="primary" aria-label="Primary note pane">
          <div class="workspace-tabs" role="tablist" aria-label="Primary open notes"></div>
        </section>
        <div class="workspace__splitter" role="separator" aria-label="Resize note panes" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" tabindex="0"></div>
        <section class="workspace__pane" data-pane="secondary" aria-label="Secondary note pane">
          <div class="workspace-tabs" role="tablist" aria-label="Secondary open notes"></div>
          <section class="editor editor--secondary"></section>
        </section>
      </div>`;
    primaryElement.parentNode.insertBefore(this.element, primaryElement);
    this.element.querySelector('[data-pane="primary"]').appendChild(primaryElement);
    this.secondaryElement = this.element.querySelector('.editor--secondary');
    this.panesElement = this.element.querySelector('.workspace__panes');
    this.statusElement = this.element.querySelector('.workspace__status');
    this.splitter = this.element.querySelector('.workspace__splitter');
  }

  get currentId() { return this.editors?.[this.state.activePane]?.currentId || null; }
  get blockEditor() { return this.editors?.[this.state.activePane]?.blockEditor || null; }
  get container() { return this.editors?.[this.state.activePane]?.container || this.primaryEditor.container; }
  get activeEditor() { return this.editors[this.state.activePane]; }

  open(id, options = {}) {
    const located = this.#locate(id);
    const pane = located?.pane || this.state.activePane;
    this.state.activePane = pane;
    if (!options.preserveEditor || this.editors[pane].currentId !== id) this.editors[pane].open(id, options);
    this.#render();
    this.#restoreScroll(pane);
  }

  async requestOpen(id, options = {}) {
    const note = this.db.getNote(id);
    if (!note) return false;
    const located = this.#locate(id);
    if (!located || located.pane !== this.state.activePane || this.state.panes[located.pane].activeNoteId !== id) {
      if (!await this.#durableHandoff()) return false;
      this.state = openWorkspaceNote(this.state, id, located?.pane || this.state.activePane);
      this.#persist();
    }
    await this.onCommitOpen(id, { ...options, workspaceCommitted: true });
    return true;
  }

  async activate(noteId, { focusTab = false, preserveEditor = false } = {}) {
    const located = this.#locate(noteId);
    if (!located) return false;
    const note = this.db.notes.get(noteId);
    if (note?.isArchived) {
      this.onArchived?.(noteId);
      this.announce('Archived notes open in the Archive review instead of an editor pane.');
      return false;
    }
    if (!note || note.isTrashed) return false;
    if (!await this.#durableHandoff()) return false;
    this.state = activateWorkspacePane(this.state, located.pane);
    this.state.panes[located.pane].activeNoteId = noteId;
    this.#persist();
    await this.onCommitOpen(noteId, { workspaceCommitted: true, preserveEditor });
    if (focusTab) this.#tab(noteId)?.focus();
    return true;
  }

  async closeTab(noteId) {
    const located = this.#locate(noteId);
    if (!located || !await this.#durableHandoff()) return false;
    const wasGlobalActive = this.state.activePane === located.pane
      && this.state.panes[located.pane].activeNoteId === noteId;
    this.state = closeWorkspaceTab(this.state, noteId);
    this.#persist();
    this.#syncPaneEditor(located.pane);
    this.#render();
    if (wasGlobalActive) {
      const nextId = this.state.panes[this.state.activePane].activeNoteId;
      if (nextId) await this.onCommitOpen(nextId, { workspaceCommitted: true });
      else this.onEmpty();
    }
    const focusId = this.state.panes[located.pane].activeNoteId
      || this.state.panes[this.state.activePane].activeNoteId;
    this.#tab(focusId)?.focus();
    this.announce(`Closed ${this.db.notes.get(noteId)?.title || 'note'} tab.`);
    return true;
  }

  async reopen() {
    const noteId = this.state.recentlyClosed[0];
    const note = noteId ? this.db.notes.get(noteId) : null;
    if (!noteId || !note || note.isTrashed) return this.announce('There is no available tab to reopen.');
    if (note.isArchived) return this.onArchived?.(noteId);
    if (!await this.#durableHandoff()) return false;
    this.state = reopenWorkspaceTab(this.state);
    this.#persist();
    await this.onCommitOpen(noteId, { workspaceCommitted: true });
    this.#tab(noteId)?.focus();
    this.announce(`Reopened ${note.title}.`);
    return true;
  }

  async moveToOtherPane(noteId) {
    const located = this.#locate(noteId);
    if (!located || !await this.#durableHandoff()) return false;
    const target = otherPane(located.pane);
    this.state = moveWorkspaceTab(this.state, noteId, target);
    this.#syncPaneEditor(located.pane);
    this.#persist();
    await this.onCommitOpen(noteId, { workspaceCommitted: true });
    this.#tab(noteId)?.focus();
    this.announce(`Moved ${this.db.notes.get(noteId)?.title || 'note'} to ${target === 'primary' ? 'pane 1' : 'pane 2'}.`);
    return true;
  }

  async cycle(direction) {
    const tabs = this.state.panes[this.state.activePane].tabs.filter((id) => this.db.getNote(id));
    if (tabs.length < 2) return false;
    const current = tabs.indexOf(this.state.panes[this.state.activePane].activeNoteId);
    const index = (current + direction + tabs.length) % tabs.length;
    return this.activate(tabs[index], { focusTab: true });
  }

  async toggleSplit() {
    if (!await this.#durableHandoff()) return false;
    this.state = setWorkspaceSplit(this.state, !this.state.split.enabled);
    this.#persist();
    this.#render();
    this.announce(this.state.split.enabled ? 'Split view enabled.' : 'Split view collapsed to the active pane.');
    return true;
  }

  setAutosaveInterval(ms) { Object.values(this.editors).forEach((editor) => editor.setAutosaveInterval(ms)); }
  flushPending() { Object.values(this.editors).forEach((editor) => editor.flushPending()); }
  refresh() {
    const normalized = normalizeWorkspaceState(this.state, [...this.db.notes.values()]);
    const changed = JSON.stringify(normalized) !== JSON.stringify(this.state);
    this.state = normalized;
    Object.values(this.editors).forEach((editor) => editor.refresh());
    if (changed) {
      for (const pane of WORKSPACE_PANES) this.#syncPaneEditor(pane);
      this.#persist();
      this.#render();
    }
  }
  syncAuthoritative(noteIds) {
    const ids = new Set(Array.isArray(noteIds) ? noteIds : []);
    for (const pane of WORKSPACE_PANES) {
      const id = this.editors[pane].currentId;
      if (id && ids.has(id)) this.editors[pane].open(id, { discardPending: true });
    }
  }
  reflectPin(id) { Object.values(this.editors).forEach((editor) => editor.reflectPin(id)); }
  reflectTitle(id) { Object.values(this.editors).forEach((editor) => editor.reflectTitle(id)); this.#renderTabs(); }
  focusTask(occurrence) { return this.activeEditor.focusTask(occurrence); }
  findEntries() { return this.activeEditor.findEntries(); }
  getSourceMarkdown() { return this.activeEditor.getSourceMarkdown(); }
  selectFindRange(...args) { return this.activeEditor.selectFindRange(...args); }
  applyFindReplacement(...args) { return this.activeEditor.applyFindReplacement(...args); }
  enablePhase5(enhancer) { Object.values(this.editors).forEach((editor) => editor.enablePhase5(enhancer)); }
  async enableOutline() { return Promise.all(Object.values(this.editors).map((editor) => editor.enableOutline())); }

  destroy() {
    for (const timer of this.scrollTimers.values()) clearTimeout(timer);
    this.scrollTimers.clear();
    const parent = this.element.parentNode;
    if (parent) parent.insertBefore(this.primaryEditor.container, this.element);
    this.element.remove();
  }

  #locate(noteId) {
    for (const pane of WORKSPACE_PANES) {
      const index = this.state.panes[pane].tabs.indexOf(noteId);
      if (index >= 0) return { pane, index };
    }
    return null;
  }

  async #durableHandoff() {
    this.flushPending();
    const saved = await this.beforeHandoff();
    if (!saved) {
      this.onStorageError();
      this.announce('Tab switch blocked because current edits are not durably saved.');
    }
    return saved;
  }

  #persist() {
    this.db.setConfig({ workspace: structuredClone(this.state) });
  }

  #render() {
    this.element.dataset.activePane = this.state.activePane;
    this.element.classList.toggle('workspace--split', this.state.split.enabled);
    this.panesElement.style.setProperty('--workspace-ratio', `${this.state.split.ratio * 100}%`);
    this.splitter.setAttribute('aria-valuenow', String(Math.round(this.state.split.ratio * 100)));
    this.element.querySelector('[data-split]').setAttribute('aria-pressed', String(this.state.split.enabled));
    this.element.querySelector('[data-reopen]').disabled = this.state.recentlyClosed.length === 0;
    for (const pane of WORKSPACE_PANES) {
      const button = this.element.querySelector(`[data-pane-visible="${pane}"]`);
      button.classList.toggle('btn--active', this.state.activePane === pane);
      button.setAttribute('aria-pressed', String(this.state.activePane === pane));
    }
    this.#renderTabs();
  }

  #renderTabs() {
    for (const pane of WORKSPACE_PANES) {
      const tablist = this.element.querySelector(`[data-pane="${pane}"] .workspace-tabs`);
      const active = this.state.panes[pane].activeNoteId;
      const panelId = pane === 'primary' ? 'editor' : 'workspace-secondary-panel';
      tablist.innerHTML = this.state.panes[pane].tabs.map((id, index) => {
        const note = this.db.notes.get(id);
        if (!note || note.isTrashed) return '';
        const selected = id === active;
        const tabIndex = selected || (!active && this.state.panes[pane].tabs[0] === id) ? '0' : '-1';
        return `<div class="workspace-tab-wrap" data-tab-wrap="${escapeHtml(id)}">
          <button type="button" class="workspace-tab" role="tab" id="workspace-${pane}-tab-${index}"
            data-tab="${escapeHtml(id)}" draggable="true" aria-controls="${panelId}"
            aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
            aria-selected="${selected}" tabindex="${tabIndex}" title="${escapeHtml(note.title)}${note.isArchived ? ' — archived' : ''}">
            <span>${escapeHtml(note.title || 'Untitled')}</span>${note.isArchived ? '<span class="workspace-tab__state">Archived</span>' : ''}
          </button>
          <button type="button" class="workspace-tab__move" data-move="${escapeHtml(id)}" aria-label="Move ${escapeHtml(note.title)} to other pane">⇄</button>
          <button type="button" class="workspace-tab__close" data-close-tab="${escapeHtml(id)}" aria-label="Close ${escapeHtml(note.title)} tab">×</button>
        </div>`;
      }).join('');
      const panel = this.editors[pane].container;
      const activeIndex = this.state.panes[pane].tabs.indexOf(active);
      panel.id = panelId;
      panel.setAttribute('role', 'tabpanel');
      if (activeIndex >= 0) {
        panel.setAttribute('aria-labelledby', `workspace-${pane}-tab-${activeIndex}`);
        panel.removeAttribute('aria-label');
      } else {
        panel.removeAttribute('aria-labelledby');
        panel.setAttribute('aria-label', `${pane === 'primary' ? 'Primary' : 'Secondary'} note editor`);
      }
    }
  }

  #tab(noteId) { return this.element.querySelector(`[data-tab="${CSS.escape(noteId)}"]`); }

  #restoreScroll(paneName = null) {
    const panes = paneName ? [paneName] : WORKSPACE_PANES;
    requestAnimationFrame(() => {
      for (const pane of panes) this.editors[pane].container.scrollTop = this.state.panes[pane].scrollTop;
    });
  }

  #syncPaneEditor(pane) {
    const expected = this.state.panes[pane].activeNoteId;
    if (this.editors[pane].currentId === expected) return;
    this.editors[pane].open(expected, { discardPending: true });
    this.#restoreScroll(pane);
  }

  #preservePrimaryOwner(noteId) {
    const located = this.#locate(noteId);
    if (located?.pane === 'secondary') this.state = moveWorkspaceTab(this.state, noteId, 'primary', 0);
    else if (!located) {
      try {
        this.state = openWorkspaceNote(this.state, noteId, 'primary');
      } catch (error) {
        if (error?.code !== 'workspace_tab_limit') throw error;
        const victim = [...this.state.panes.secondary.tabs, ...this.state.panes.primary.tabs]
          .reverse()
          .find((id) => id !== noteId);
        if (victim) this.state = closeWorkspaceTab(this.state, victim);
        this.state = openWorkspaceNote(this.state, noteId, 'primary');
      }
    }
    this.state.activePane = 'primary';
    this.state.panes.primary.activeNoteId = noteId;
  }

  #scheduleScrollSave(pane) {
    clearTimeout(this.scrollTimers.get(pane));
    this.scrollTimers.set(pane, setTimeout(() => {
      this.scrollTimers.delete(pane);
      this.state = setWorkspaceScroll(this.state, pane, this.editors[pane].container.scrollTop);
      this.#persist();
    }, 160));
  }

  #activatePaneFromEditor(pane) {
    if (this.state.activePane === pane) return Promise.resolve(true);
    if (this.paneActivations.has(pane)) return this.paneActivations.get(pane);
    const noteId = this.state.panes[pane].activeNoteId;
    if (!noteId) return Promise.resolve(false);
    const activation = this.activate(noteId, { preserveEditor: true }).then((activated) => {
      if (!activated) this.#tab(this.state.panes[this.state.activePane].activeNoteId)?.focus();
      return activated;
    }).finally(() => this.paneActivations.delete(pane));
    this.paneActivations.set(pane, activation);
    return activation;
  }

  #wire() {
    for (const pane of WORKSPACE_PANES) {
      const container = this.editors[pane].container;
      container.addEventListener('pointerdown', () => {
        if (this.state.activePane !== pane) void this.#activatePaneFromEditor(pane);
      }, { capture: true });
      container.addEventListener('click', (event) => {
        if (this.state.activePane === pane) return;
        const control = event.target.closest('button, a[href]');
        if (!control) return;
        event.preventDefault();
        event.stopPropagation();
        void this.#activatePaneFromEditor(pane).then((activated) => {
          if (activated && control.isConnected) control.click();
        });
      }, { capture: true });
    }
    this.element.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      const close = event.target.closest('[data-close-tab]');
      const move = event.target.closest('[data-move]');
      const pane = event.target.closest('[data-pane-visible]');
      if (close) void this.closeTab(close.dataset.closeTab);
      else if (move) void this.moveToOtherPane(move.dataset.move);
      else if (tab) void this.activate(tab.dataset.tab);
      else if (pane) {
        const noteId = this.state.panes[pane.dataset.paneVisible].activeNoteId;
        if (noteId) void this.activate(noteId);
      } else if (event.target.closest('[data-reopen]')) void this.reopen();
      else if (event.target.closest('[data-split]')) void this.toggleSplit();
    });
    this.element.addEventListener('keydown', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab && event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const located = this.#locate(tab.dataset.tab);
        if (!located) return;
        const nextIndex = Math.max(0, Math.min(
          this.state.panes[located.pane].tabs.length - 1,
          located.index + (event.key === 'ArrowRight' ? 1 : -1),
        ));
        this.state = reorderWorkspaceTab(this.state, located.pane, tab.dataset.tab, nextIndex);
        this.#persist();
        this.#render();
        this.#tab(tab.dataset.tab)?.focus();
        this.announce(`Moved tab to position ${nextIndex + 1}.`);
      } else if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
        const current = buttons.indexOf(tab);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      } else if (tab && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        void this.activate(tab.dataset.tab, { focusTab: true });
      } else if (tab && event.key === 'Delete') {
        event.preventDefault();
        void this.closeTab(tab.dataset.tab);
      } else if (event.target === this.splitter && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0.25 : event.key === 'End' ? 0.75 : this.state.split.ratio + (event.key === 'ArrowRight' ? 0.05 : -0.05);
        this.state = setWorkspaceRatio(this.state, next);
        this.#persist();
        this.#render();
      }
    });
    this.element.addEventListener('dragstart', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      this.dragged = this.#locate(tab.dataset.tab);
      this.dragged.noteId = tab.dataset.tab;
      event.dataTransfer?.setData('text/plain', tab.dataset.tab);
    });
    this.element.addEventListener('dragover', (event) => {
      if (event.target.closest('[data-tab], .workspace-tabs')) event.preventDefault();
    });
    this.element.addEventListener('dragend', () => { this.dragged = null; });
    this.element.addEventListener('drop', (event) => {
      const targetTab = event.target.closest('[data-tab]');
      const tablist = event.target.closest('.workspace-tabs');
      if (!this.dragged || (!targetTab && !tablist)) return;
      event.preventDefault();
      const targetPane = (targetTab || tablist).closest('[data-pane]').dataset.pane;
      const targetIndex = targetTab ? this.state.panes[targetPane].tabs.indexOf(targetTab.dataset.tab) : this.state.panes[targetPane].tabs.length;
      void this.#dropTab(targetPane, targetIndex);
    });
    for (const pane of WORKSPACE_PANES) this.editors[pane].container.addEventListener('scroll', () => this.#scheduleScrollSave(pane), { passive: true });
    this.splitter.addEventListener('pointerdown', (event) => {
      if (!this.state.split.enabled) return;
      event.preventDefault();
      const resize = (move) => {
        const box = this.panesElement.getBoundingClientRect();
        this.state = setWorkspaceRatio(this.state, (move.clientX - box.left) / box.width);
        this.#render();
      };
      const done = () => {
        document.removeEventListener('pointermove', resize);
        document.removeEventListener('pointerup', done);
        this.#persist();
      };
      document.addEventListener('pointermove', resize);
      document.addEventListener('pointerup', done, { once: true });
    });
  }

  async #dropTab(targetPane, targetIndex) {
    const dragged = this.dragged;
    this.dragged = null;
    if (!dragged) return;
    if (dragged.pane === targetPane) {
      if (dragged.index < targetIndex) targetIndex -= 1;
      this.state = reorderWorkspaceTab(this.state, targetPane, dragged.noteId, targetIndex);
      this.#persist();
      this.#render();
      this.#tab(dragged.noteId)?.focus();
      return;
    }
    if (!await this.#durableHandoff()) return;
    this.state = moveWorkspaceTab(this.state, dragged.noteId, targetPane, targetIndex);
    this.#syncPaneEditor(dragged.pane);
    this.#persist();
    await this.onCommitOpen(dragged.noteId, { workspaceCommitted: true });
    this.#tab(dragged.noteId)?.focus();
  }
}
