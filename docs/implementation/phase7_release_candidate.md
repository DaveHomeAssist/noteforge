# Phase 7 release candidate

Status: implemented and locally verified on 2026-08-20. Exact-SHA CI, mirror, and
canonical evidence follow the Phase 7 and Phase 8 release checkpoints.

## Migration and recovery

- Randomized schema-version-3 fixtures migrate through every sequential schema to
  the current version without changing note IDs, Markdown (including embedded data
  images), banners, tags, aliases, properties, hierarchy, Archive, Trash, or config.
- A 1,000-note migrated vault produces and verifies a deterministic portable
  backup, then creates an exact detached restore preview without mutating the live
  database.
- Browser-local revision records remain independently materializable across the
  schema migration. Derived indexes are excluded from backups and rebuildable.
- The integrated browser scenario combines two-pane editing, autosave, task and
  property index updates, folder-reconciliation backup/revision gates, portable
  restore, a post-backup browser-local revision restore, reload, and offline use.

## Scale and budgets

- Database subscribers receive exact changed note IDs after durable mutations.
  Task, calendar, and property indexes update only those records; full reset is
  reserved for initialization, restore, or detected corruption.
- A 1,000-note incremental task/calendar/property update and a representative
  20-query search p95 each complete below the 150 ms contract in Node 22 tests.
- Workspace repair retains at most 20 tabs. Reconciliation renders at most 50 rows
  per accessible page; existing sidebar/graph/task virtualization remains active.
- The production initial shell is 257,023 uncompressed bytes, 157 bytes below the
  authoritative ceiling. Exact artifact measurements are recorded in
  `performance_budgets.md`.

## Accessibility, security, and failure handling

- Automated browser coverage exercises keyboard/focus/modal announcements,
  reduced motion, increased contrast/forced colors, 200%-equivalent width, desktop,
  and 390 px. The audit found and fixed a mobile split-pane specificity defect that
  exposed and clipped both panes instead of the selected pane.
- Adversarial tests cover malformed YAML, prototype-shaped JSON keys, unsafe URLs,
  XSS/transclusion boundaries, path traversal, oversized clipper input, cyclic
  transclusion budgets, strict CSP, and scoped service-worker cache cleanup.
- Portable restore remains verification/preview/confirmation gated and atomic.
  Folder reconciliation remains read-only until explicit decisions, a verified
  portable backup, and browser-local revisions exist.

## Local release-candidate gates

- Node 22.22.1: 425 checks, zero failures.
- Browser: 394 component assertions, 120 integrated workflows, ten production/
  offline checks, zero unexpected console/page/request/HTTP errors.
- Vite 6.4.3: 172 modules, 71 production files, no unresolved build placeholders.
- `npm audit --audit-level=high`: zero vulnerabilities.

The commit, push, exact-SHA workflow, live mirror, and service-worker transition
are intentionally recorded only after they exist; local results are not presented
as deployment evidence.
