// Command palette command list (the palette's "Commands" group). A lazy module,
// loaded with ../components/command-palette.js on first palette open, so the list
// stays out of the first-paint shell. The app passes a context: `app` for its public
// methods and state, plus one bound function for each private action a command runs
// (see App#paletteContext in ./main.js).

import { TEMPLATES } from './templates.js';

/** Live command set for the palette (recomputed each keystroke → reflects state). */
export function buildCommands(ctx) {
  const { app } = ctx;
  const cur = app.currentId ? app.db.getNote(app.currentId) : null;
  const cmds = [
    { id: 'new', title: 'New note', hint: 'Create', keys: ['Ctrl/⌘', 'N'], icon: 'plus', run: () => app.newNote() },
    {
      id: 'today',
      title: 'Open Today’s Note',
      hint: 'Local Daily note',
      keys: ['Ctrl/⌘', 'Shift', 'D'],
      icon: 'calendar-days',
      run: () => app.openDailyNote(),
    },
    {
      id: 'capture',
      title: 'Quick Capture',
      hint: 'Text, URL, clipboard, image',
      keys: ['Ctrl/⌘', 'Shift', 'C'],
      icon: 'inbox',
      run: () => ctx.showQuickCapture(),
    },
    {
      id: 'tasks',
      title: 'Open task dashboard',
      hint: 'Today, overdue, upcoming',
      icon: 'square-check-big',
      run: () => ctx.showTaskDashboard(),
    },
    {
      id: 'calendar',
      title: 'Open calendar',
      hint: 'Month and week',
      icon: 'calendar',
      run: () => ctx.showCalendar(),
    },
    ...TEMPLATES.map((t) => ({
      id: 'tpl-' + t.id,
      title: `New ${t.label.toLowerCase()}`,
      hint: 'Template',
      icon: t.icon,
      run: () => app.newFromTemplate(t),
    })),
    {
      id: 'search',
      title: 'Search notes',
      hint: 'Sidebar',
      keys: ['Ctrl/⌘', 'K'],
      icon: 'search',
      run: () => ctx.focusSearch(),
    },
    {
      id: 'back',
      title: 'Go back to previous note',
      hint: 'Navigation',
      keys: ['Alt', '←'],
      icon: 'arrow-left',
      run: () => app.goBack(),
    },
    {
      id: 'forward',
      title: 'Go forward to next note',
      hint: 'Navigation',
      keys: ['Alt', '→'],
      icon: 'arrow-right',
      run: () => app.goForward(),
    },
    {
      id: 'graph',
      title: app.view === 'graph' ? 'Close graph view' : 'Open graph view',
      hint: 'View',
      keys: ['Ctrl/⌘', 'G'],
      icon: 'waypoints',
      run: () => app.toggleGraph(),
    },
    {
      id: 'theme',
      title: 'Toggle dark / light theme',
      hint: 'Appearance',
      icon: 'sun-moon',
      run: () => app.theme.toggle(),
    },
    {
      id: 'find',
      title: 'Find and replace in current note',
      hint: 'Source Markdown',
      keys: ['Ctrl/⌘', 'F'],
      icon: 'text-search',
      run: () => ctx.showFindReplace('current'),
    },
    {
      id: 'find-vault',
      title: 'Find and replace across vault',
      hint: 'Preview required',
      icon: 'text-search',
      run: () => ctx.showFindReplace('vault'),
    },
    {
      id: 'archive-view',
      title: 'Open Archive',
      hint: `${app.db.getArchived().length} archived`,
      icon: 'archive',
      run: () => ctx.showArchive(),
    },
    {
      id: 'trash',
      title: 'Open Trash',
      hint: `${app.db.getTrash().length} in trash`,
      icon: 'trash-2',
      run: () => ctx.showTrash(),
    },
    {
      id: 'settings',
      title: 'Open settings',
      hint: 'Preferences',
      icon: 'settings',
      run: () => ctx.showSettings(),
    },
    { id: 'backup', title: 'Open Backup center', hint: 'Recovery', icon: 'life-buoy', run: () => ctx.showBackup() },
    {
      id: 'clipper',
      title: 'Set up web clipper',
      hint: 'Capture web pages',
      icon: 'scissors',
      run: () => ctx.showClipper(),
    },
    {
      id: 'reconcile',
      title: 'Reconcile Markdown folder',
      hint: 'Preview, backup, then apply',
      icon: 'folder-sync',
      run: () => ctx.showReconciliation(),
    },
    {
      id: 'link-report',
      title: 'Open link integrity report',
      hint: 'Knowledge graph',
      icon: 'link',
      run: () => ctx.showLinkReport(),
    },
    { id: 'export', title: 'Export notes as JSON', hint: 'Data', icon: 'download', run: () => ctx.export() },
    {
      id: 'import',
      title: 'Import notes from JSON',
      hint: 'Data',
      icon: 'upload',
      run: () => app.el.importFile.click(),
    },
    { id: 'seed', title: 'Load sample notes', hint: 'Data', icon: 'sparkles', run: () => ctx.seed() },
    ...(app.savedSearches?.commands() || []),
  ];
  // Save-to-folder needs the File System Access API (Chromium) — only offer it there.
  if (window.showDirectoryPicker) {
    cmds.push({
      id: 'save-folder',
      title: 'Save all notes to a folder…',
      hint: 'Markdown vault',
      icon: 'folder',
      run: () => app.saveVaultToFolder(),
    });
  }
  if (cur) {
    cmds.push({
      id: 'properties',
      title: 'Edit note properties',
      hint: 'YAML frontmatter',
      icon: 'sliders-horizontal',
      run: () => ctx.showProperties(cur.id),
    });
    cmds.push({
      id: 'history',
      title: 'Open revision history',
      hint: cur.title,
      icon: 'history',
      run: () => ctx.showHistory(),
    });
    cmds.push({
      id: 'archive',
      title: 'Archive current note',
      hint: cur.title,
      icon: 'archive',
      run: () => ctx.archiveCurrent(),
    });
    cmds.push({
      id: 'child',
      title: 'New sub-note under current',
      hint: cur.title,
      icon: 'corner-down-right',
      run: () => app.newChild(cur.id),
    });
    if (cur.parentId)
      cmds.push({
        id: 'unnest',
        title: 'Move current note to top level',
        hint: cur.title,
        icon: 'arrow-up-to-line',
        run: () => app.reparent(cur.id, null),
      });
    cmds.push({
      id: 'pin',
      title: cur.pinned ? 'Unpin current note' : 'Pin current note to top',
      hint: cur.title,
      icon: 'pin',
      run: () => app.togglePin(cur.id),
    });
    cmds.push({
      id: 'export-html',
      title: 'Export note as HTML',
      hint: 'Shareable page',
      icon: 'globe',
      run: () => app.exportNoteHtml(cur),
    });
    cmds.push({
      id: 'export-md',
      title: 'Download note as Markdown',
      hint: 'Save .md',
      icon: 'file-down',
      run: () => app.downloadNoteMarkdown(cur),
    });
    cmds.push({
      id: 'del',
      title: 'Delete current note',
      hint: cur.title,
      icon: 'trash-2',
      run: () => app.deleteNote(cur.id),
    });
  }
  return cmds;
}
