# Browser compatibility

NoteForge is a local-first progressive web app. The current release candidate
targets current evergreen desktop and mobile browsers with IndexedDB, ES modules,
CSS custom properties, and service workers. Markdown and portable JSON backups
remain the authority when a browser-specific convenience API is unavailable.

## Verified matrix

| Browser/surface | Evidence | Result |
| --- | --- | --- |
| Playwright Chromium on Node 22 CI/local | 394 component assertions, 120 integrated workflows, ten production/offline checks | Supported; release gate |
| Current system Chrome, fresh disposable profile | Desktop and 390 px layouts, create/edit/autosave/reload, search, Trash, recovery, two panes, reconciliation, offline update, cache sentinel | Supported; live smoke surface |
| Safari on macOS | Manual release-candidate pass | Pending the final Phase 7 release check |
| Firefox | Standards/static review; no installed local Firefox in this release environment | Expected to support core notes/recovery; not a release-gated browser |

## Progressive fallbacks

- IndexedDB is authoritative when available. If opening IndexedDB is unavailable,
  current-note persistence falls back to `localStorage`; revision history and local
  snapshots report unavailable because the smaller quota is not safe for them.
- Chromium can keep a selected folder handle through the File System Access API.
  Other browsers use the labelled file/directory input for read-only ingestion;
  NoteForge never claims background two-way folder sync.
- Clipboard, share-target, and download capabilities are checked before use and
  produce visible instructions or a normal file download when unavailable.
- Installation UI is browser-owned. The app remains fully usable as a normal tab.

## Accessibility and responsive coverage

The browser gate covers keyboard focus/trapping, WAI tabs, status announcements,
forced-colors, increased contrast, reduced motion, a 200%-equivalent viewport, and
390 px layout. At mobile width a split workspace exposes one pane at a time while
retaining both panes' tabs and state. Long task and reconciliation results use
bounded pages/windows so assistive technology does not inherit an unbounded DOM.

Browser-specific gaps are release notes, not silent feature loss. A browser that
cannot provide a folder handle, persistent storage estimate, clipboard permission,
or share target must show its fallback and leave the vault unchanged until the
user explicitly saves.
