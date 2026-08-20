import { consumeClipperIntake } from '../utils/clipper.js';

export class Phase6Controller {
  constructor({
    db,
    primaryEditor,
    primaryElement,
    onWorkspaceCreated,
    commitOpen,
    clearActive,
    openArchived,
    ensureRecovery,
    showQuickCapture,
    showStorageError,
    announce,
  }) {
    this.db = db;
    this.primaryEditor = primaryEditor;
    this.primaryElement = primaryElement;
    this.onWorkspaceCreated = onWorkspaceCreated;
    this.commitOpen = commitOpen;
    this.clearActive = clearActive;
    this.openArchived = openArchived;
    this.ensureRecovery = ensureRecovery;
    this.showQuickCapture = showQuickCapture;
    this.showStorageError = showStorageError;
    this.announce = announce;
    this.workspace = null;
    this.clipper = null;
    this.clipperReady = null;
    this.reconciliation = null;
    this.reconciliationReady = null;
    this.ready = this.#initializeWorkspace();
  }

  get open() {
    return Boolean(this.clipper?.open || this.reconciliation?.open);
  }

  async #initializeWorkspace() {
    const { WorkspaceView } = await import('../components/workspace-view.js');
    this.workspace = new WorkspaceView({
      primaryElement: this.primaryElement,
      primaryEditor: this.primaryEditor,
      db: this.db,
      actions: this.primaryEditor.actions,
      beforeHandoff: () => this.db.flushCurrentWrites(),
      onCommitOpen: (id, options) => this.commitOpen(id, options),
      onEmpty: () => this.clearActive(),
      onArchived: (id) => this.openArchived(id),
      onStorageError: () => this.showStorageError(),
      announce: (message) => this.announce(message),
    });
    this.onWorkspaceCreated(this.workspace);
    await this.workspace.initialize();
    return this;
  }

  async #ensureClipper() {
    if (this.clipper) return this.clipper;
    if (this.clipperReady) return this.clipperReady;
    this.clipperReady = import('../components/clipper-view.js').then(({ ClipperView, createClipperElements }) => {
      const appUrl = new URL(window.location.href);
      appUrl.search = '';
      appUrl.hash = '';
      this.clipper = new ClipperView(createClipperElements(), { appUrl: appUrl.href });
      return this.clipper;
    }).catch((error) => { this.clipperReady = null; throw error; });
    return this.clipperReady;
  }

  async showClipper() {
    await this.ready;
    (await this.#ensureClipper()).show();
  }

  async openClipperIntake(input = window.location.href) {
    let intake;
    try {
      intake = consumeClipperIntake(input);
    } finally {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
    }
    if (!intake?.matched) return false;
    await this.showQuickCapture({ payload: intake.payload });
    if (intake.clipboardFallback) this.announce('Paste the clipboard handoff into Quick Capture, review it, then choose Save capture.');
    else this.announce('Clipped page content is ready to review. Nothing is saved until you choose Save capture.');
    return true;
  }

  async #ensureReconciliation() {
    if (this.reconciliation) return this.reconciliation;
    if (this.reconciliationReady) return this.reconciliationReady;
    this.reconciliationReady = Promise.all([
      import('../components/reconciliation-view.js'),
      import('../core/reconciliation-service.js'),
      this.ensureRecovery(),
    ]).then(([{ ReconciliationView, createReconciliationElements }, { ReconciliationService }, recovery]) => {
      const service = new ReconciliationService({ db: this.db, recovery });
      this.reconciliation = new ReconciliationView(createReconciliationElements(), this.db, service, {
        confirmApply: ({ message }) => confirm(message),
        onApplied: (report) => this.workspace.syncAuthoritative(
          report.items.filter((item) => item.decision === 'apply').map((item) => item.noteId),
        ),
      });
      return this.reconciliation;
    }).catch((error) => { this.reconciliationReady = null; throw error; });
    return this.reconciliationReady;
  }

  async showReconciliation() {
    await this.ready;
    const view = await this.#ensureReconciliation();
    this.workspace.flushPending();
    if (!await this.db.flushCurrentWrites()) return this.showStorageError();
    view.show();
  }
}
