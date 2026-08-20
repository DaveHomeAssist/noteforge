// Note editor shell: title, tag chips, the Notion-style block canvas, a
// backlinks panel, and live autosave. The content area is a BlockEditor (see
// block-editor.js); note.content stays a markdown string via its serialize().

import { BlockEditor } from './block-editor.js';
import { BannerControl } from './banner.js';
import { escapeHtml, debounce, formatDate } from '../utils/helpers.js';

export class Editor {
  /**
   * @param {HTMLElement} container
   * @param {import('../core/database.js').Database} db
   * @param {{ openNote:(id:string,opts?:object)=>void, openOrCreateByTitle:(t:string,fragment?:string)=>void,
   *   requestRename?:(id:string,title:string)=>void, previewMention?:(mention:object)=>void }} actions
   */
  constructor(container, db, actions) {
    this.container = container;
    this.db = db;
    this.actions = actions;
    this.currentId = null;
    this.blockEditor = null;
    this.banner = null;
    this.OutlineView = null;
    this.outlineReady = null;
    this.autosave = debounce(() => this.#save(), Number(db.config?.autosaveMs) || 400);
    this.#renderEmpty();
  }

  /** Change the autosave debounce interval (from Settings). Flushes anything pending. */
  setAutosaveInterval(ms) {
    const n = Number(ms) > 0 ? Number(ms) : 400;
    this.autosave.flush?.();
    this.autosave = debounce(() => this.#save(), n);
  }

  /** Load the optional heading outline after the first usable editor paint. */
  async enableOutline() {
    if (this.OutlineView) return this.outline;
    if (this.outlineReady) return this.outlineReady;
    this.outlineReady = import('./outline-view.js').then(({ OutlineView }) => {
      this.OutlineView = OutlineView;
      const note = this.currentId ? this.db.getNote(this.currentId) : null;
      if (note) this.#mountOutline(note.content);
      return this.outline;
    }).catch((error) => {
      this.outlineReady = null;
      throw error;
    });
    return this.outlineReady;
  }

  open(id, { focus = null, discardPending = false, headingAnchor = null } = {}) {
    // Persist the OUTGOING note's buffered (debounced) edits before we switch —
    // flush runs #save() synchronously while currentId/blockEditor still point at
    // the note being left, so a fast note-switch never drops unsaved typing.
    if (discardPending) this.autosave.cancel();
    else this.autosave.flush();
    const note = this.db.getNote(id);
    if (!note) return this.#renderEmpty();
    this.currentId = id;
    this.#render(note);
    if (focus === 'title') {
      const el = this.container.querySelector('.editor__title');
      if (el) { el.focus(); el.select(); }
    } else if (focus === 'content') {
      this.blockEditor?.focusFirst();
    } else if (headingAnchor) {
      queueMicrotask(() => this.blockEditor?.jumpToHeading(headingAnchor));
    }
  }

  /**
   * Re-render on an external store change. Bail while the title is focused or
   * the block editor is mid-edit, so autosave never yanks the caret; the
   * sidebar list updates independently.
   */
  refresh() {
    if (!this.currentId) return;
    const note = this.db.getNote(this.currentId);
    if (!note) {
      this.currentId = null;
      this.#renderEmpty();
      return;
    }
    const active = document.activeElement;
    if (active && active.classList.contains('editor__title')) return;
    if (this.blockEditor && this.blockEditor.isEditing()) return;
    if (this.banner && this.banner.isBusy()) return; // banner picker/reposition in progress
    // Defense-in-depth: never rebuild the editor over block edits that haven't
    // been persisted yet (e.g. a foreign emit lands during the autosave debounce
    // window). The pending autosave will persist them and a later refresh will
    // rebuild cleanly.
    if (this.blockEditor && this.blockEditor.serialize() !== note.content) return;

    const wasTagInput = active && active.classList.contains('editor__tag-input');
    const wasPin = active && active.classList.contains('editor__pin');
    this.#render(note);
    if (wasTagInput) {
      const ti = this.container.querySelector('.editor__tag-input');
      if (ti) ti.focus();
    } else if (wasPin) {
      this.container.querySelector('.editor__pin')?.focus();
    }
  }

  /** Update just the pin button in place — used when a full refresh() is
   *  suppressed (e.g. a non-text block is selected), so the toolbar can't go stale. */
  reflectPin(id) {
    if (id !== this.currentId) return;
    const btn = this.container.querySelector('.editor__pin');
    const note = this.db.getNote(id);
    if (!btn || !note) return;
    btn.classList.toggle('editor__pin--on', note.pinned);
    btn.title = note.pinned ? 'Unpin' : 'Pin to top';
    btn.setAttribute('aria-pressed', String(note.pinned));
  }

  reflectTitle(id) {
    if (id !== this.currentId) return;
    const input = this.container.querySelector('.editor__title');
    const note = this.db.getNote(id);
    if (input && note) input.value = note.title;
  }

  // --- rendering ----------------------------------------------------------

  #teardown() {
    if (this.blockEditor) {
      this.blockEditor.destroy();
      this.blockEditor = null;
    }
    if (this.banner) {
      this.banner.destroy();
      this.banner = null;
    }
    if (this.outline) {
      this.outline.destroy();
      this.outline = null;
    }
  }

  #renderEmpty() {
    this.#teardown();
    this.currentId = null;
    this.container.innerHTML = `
      <div class="editor__empty">
        <div class="editor__empty-art">📝</div>
        <p>Select a note, or create a new one.</p>
        <p class="muted">Tip: type <code>/</code> for blocks, link notes with <code>[[Note title]]</code>.</p>
      </div>`;
  }

  #render(note) {
    // Carry the block editor's undo/redo history across a re-render of the SAME
    // note (metadata edits trigger refresh()), so it isn't silently wiped.
    const history = this.blockEditor && this._blockEditorNoteId === note.id
      ? this.blockEditor.exportHistory()
      : null;
    this.#teardown();
    const backlinks = this.db.backlinkOccurrencesFor(note.id);
    const mentions = this.db.unlinkedMentionsFor(note.id);
    this._mentions = mentions;
    this.container.innerHTML = `
      <div class="editor__banner"></div>
      ${this.#breadcrumbHtml(note)}
      <div class="editor__bar">
        <input type="text" class="editor__title" value="${escapeHtml(note.title)}"
               placeholder="Untitled" />
        <div class="editor__tools">
          <button class="btn btn--ghost editor__pin ${note.pinned ? 'editor__pin--on' : ''}"
                  title="${note.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${note.pinned}">📌</button>
          <button class="btn btn--danger-ghost editor__delete" title="Delete note">🗑</button>
        </div>
      </div>

      <div class="editor__tags">
        ${note.tags.map((t) => `
          <span class="chip">#${escapeHtml(t)}<button class="chip__x" data-tag="${escapeHtml(t)}" title="Remove tag">×</button></span>
        `).join('')}
        <input type="text" class="editor__tag-input" placeholder="+ add tag" />
      </div>

      <div class="editor__workspace">
        <div class="editor__document">
          <div class="editor__blocks"></div>

          <section class="backlinks" aria-labelledby="backlinks-title">
            <h3 class="backlinks__title" id="backlinks-title">🔗 Backlinks <span class="muted">(${backlinks.length})</span></h3>
            ${backlinks.length === 0
              ? `<p class="muted backlinks__empty">No other notes link here yet.</p>`
              : `<ul class="backlinks__list">${backlinks.map((b) => `
                  <li><a href="#" class="backlinks__item" data-id="${escapeHtml(b.sourceId)}" data-context-anchor="${escapeHtml(b.headingAnchor || '')}" aria-label="Open ${escapeHtml(b.sourceTitle)}${b.heading ? ` at ${escapeHtml(b.heading)}` : ''}">
                    <strong>${escapeHtml(b.sourceTitle)}</strong>
                    ${b.heading ? `<span class="backlinks__heading">${escapeHtml(b.heading)}</span>` : ''}
                    <span class="backlinks__snippet">${escapeHtml(b.snippet || b.target)}</span>
                  </a></li>
                `).join('')}</ul>`
            }
          </section>

          <section class="mentions" aria-labelledby="mentions-title">
            <h3 class="backlinks__title" id="mentions-title">💬 Unlinked mentions <span class="muted">(${mentions.length})</span></h3>
            ${mentions.length === 0
              ? `<p class="muted backlinks__empty">No unlinked mentions found.</p>`
              : `<ul class="mentions__list">${mentions.map((mention, index) => `
                  <li class="mentions__item">
                    <div><strong>${escapeHtml(mention.sourceTitle)}</strong>${mention.heading ? `<span class="mentions__heading">${escapeHtml(mention.heading)}</span>` : ''}<p>${escapeHtml(mention.snippet || mention.text)}</p></div>
                    <button type="button" class="btn btn--ghost mention-convert" data-mention-index="${index}" aria-label="Preview converting mention in ${escapeHtml(mention.sourceTitle)} to a wikilink">Convert</button>
                  </li>`).join('')}</ul>`
            }
          </section>

          <div class="editor__meta muted">
            Created ${formatDate(note.createdAt)} · Updated ${formatDate(note.updatedAt)}
          </div>
        </div>
        <aside class="editor__outline" aria-label="Note outline"></aside>
      </div>
    `;

    const host = this.container.querySelector('.editor__blocks');
    this.blockEditor = new BlockEditor(host, {
      initialMarkdown: note.content,
      history,
      onChange: () => {
        this.autosave();
        this.outline?.update(this.blockEditor.serialize());
      },
      onOpenWikilink: (title, fragment) => {
        this.autosave.flush();
        this.actions.openOrCreateByTitle(title, fragment);
      },
      getTitles: () => this.db.allLinkNames(),
    });
    this._blockEditorNoteId = note.id;

    if (this.OutlineView) this.#mountOutline(note.content);

    this.banner = new BannerControl(this.container.querySelector('.editor__banner'), {
      getBanner: () => this.db.getNote(note.id)?.banner || null,
      onChange: (banner) => this.#setBanner(note.id, banner),
    });

    this.#wire(note);
  }

  #mountOutline(markdown) {
    const host = this.container.querySelector('.editor__outline');
    if (!host || !this.OutlineView) return;
    this.outline?.destroy();
    this.outline = new this.OutlineView(host, {
      scrollRoot: this.container,
      onJump: (anchor) => this.blockEditor?.jumpToHeading(anchor),
    });
    this.outline.update(markdown);
  }

  /** Ancestor breadcrumb ("Parent › Sub › This") for a nested note. */
  #breadcrumbHtml(note) {
    const anc = this.db.ancestorsOf(note.id);
    if (!anc.length) return '';
    const sep = '<span class="crumb-sep">›</span>';
    const crumbs = anc.map((a) => `<a href="#" class="crumb" data-id="${escapeHtml(a.id)}">${escapeHtml(a.title || 'Untitled')}</a>`).join(sep);
    return `<nav class="editor__breadcrumb" aria-label="Breadcrumb">${crumbs}${sep}<span class="crumb crumb--current">${escapeHtml(note.title || 'Untitled')}</span></nav>`;
  }

  // --- events -------------------------------------------------------------

  #wire(note) {
    this.container.querySelectorAll('.editor__breadcrumb .crumb[data-id]').forEach((a) =>
      a.addEventListener('click', (e) => { e.preventDefault(); this.actions.openNote(a.dataset.id); })
    );

    const titleInput = this.container.querySelector('.editor__title');
    titleInput.addEventListener('change', () => {
      const proposed = titleInput.value.trim() || 'Untitled';
      if (proposed === note.title) return;
      this.actions.requestRename?.(note.id, proposed);
      this.reflectTitle(note.id);
    });
    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); titleInput.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); this.reflectTitle(note.id); titleInput.blur(); }
    });

    this.container.querySelector('.editor__pin').addEventListener('click', () => {
      this.actions.togglePin(note.id); // the app flushes pending edits + persists
    });

    this.container.querySelector('.editor__delete').addEventListener('click', () => {
      // The app owns the confirm + selection-advance; delete is now a recoverable
      // move to Trash (see App.deleteNote), not a hard delete.
      this.autosave.flush(); // persist buffered edits before the store mutates
      this.actions.deleteNote(note.id);
    });

    const tagInput = this.container.querySelector('.editor__tag-input');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const value = tagInput.value.replace(/,/g, '').trim();
        if (value) {
          this.autosave.flush(); // persist buffered block edits before the emit rebuilds us
          const fresh = this.db.getNote(note.id);
          fresh.addTag(value.replace(/^#/, ''));
          this.db.saveNote(fresh);
        }
      }
    });

    this.container.querySelectorAll('.chip__x').forEach((btn) =>
      btn.addEventListener('click', () => {
        this.autosave.flush(); // persist buffered block edits before the emit rebuilds us
        const fresh = this.db.getNote(note.id);
        fresh.removeTag(btn.dataset.tag);
        this.db.saveNote(fresh);
      })
    );

    this.container.querySelectorAll('.backlinks__item').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.actions.openNote(a.dataset.id, { headingAnchor: a.dataset.contextAnchor || null });
      })
    );

    this.container.querySelectorAll('.mention-convert').forEach((button) => {
      button.addEventListener('click', () => {
        const mention = this._mentions?.[Number(button.dataset.mentionIndex)];
        if (mention) this.actions.previewMention?.(mention);
      });
    });
  }

  #setBanner(id, banner) {
    this.autosave.flush(); // persist buffered block edits before the emit rebuilds us
    const note = this.db.getNote(id);
    if (!note) return;
    note.setBanner(banner);
    this.db.saveNote(note);
  }

  /** Commit any pending debounced autosave immediately (e.g. before unload). */
  flushPending() {
    this.autosave.flush();
  }

  // --- persistence --------------------------------------------------------

  #save() {
    if (!this.currentId) return;
    const note = this.db.getNote(this.currentId);
    if (!note) return;
    const nextContent = this.blockEditor ? this.blockEditor.serialize() : note.content;
    if (nextContent === note.content) return; // no-op
    note.update({ content: nextContent });
    this.db.saveNote(note);
  }
}
