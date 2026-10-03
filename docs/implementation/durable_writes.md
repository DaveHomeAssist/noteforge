# Durable mutation implementation record

Phase 1 reliability repair, based on main 7114047aca10ad9b25839774a22d06370a6456bd.

## Status

In progress. The maintained P1 regressions reproduce both data-loss defects on
the baseline in Chromium, Firefox and WebKit (nine failed assertions). The new
transaction module is a foundation; it is not yet wired into the production
Database. No migration is enabled and this branch is not releasable.

## Persistence writer inventory

| Caller | Existing acknowledgement / hazard | Required integration |
| --- | --- | --- |
| Database.saveNote and CRUD | Memory updates first; whole notes array queue; flushCurrentWrites returns true when local queue drains | Per-note base versions, exact committed acknowledgement, durable conflicts, tombstones |
| Database.setConfig | Whole config object queued without field preconditions | Field versions; explicit shared versus workspace/session policy |
| Database.init | Separate reads and automatic whole-array migration writes | Consistent read; guarded migration with preserved original snapshot |
| Database.commitPlannedNotes | Flush, asynchronous capture, unconditional whole-array batch | Immutable plan dependencies checked atomically after capture |
| LinkOperations | Preview fingerprint checked before asynchronous commit | Capture immutable source/dependency versions at preview and revalidate at commit |
| BulkOperations / TaskService | Planned changes through commitPlannedNotes | Shared conditional plan contract, including scope dependencies |
| Phase5Controller | Properties and alias migration prepare replacements across awaits | Snapshot inputs before awaits; reject stale source and identity plans |
| CaptureService | Synchronous append prepares note; awaits flush | Exact note result; keep draft on conflict; safe creation identity |
| RecoveryService.restore | prepareRestore awaits, then unconditional saveNote | Conditional restoration of the reviewed version after safety capture |
| RecoveryService backups/snapshots | Reads in-memory vault following flush | Consistent committed snapshot plus explicit pending/conflict recovery |
| RecoveryService.restoreBackup | Rechecks imported backup, captures safety, calls replaceVault | Vault-generation/sequence precondition spanning preview and safety capture |
| ReconciliationService | Rechecks folder plan before safety capture and asynchronous hashes; replaceVault | Preserve source and destination dependencies through final atomic commit |
| RevisionStore | Own locked history key batches; optional post-commit history | Preserve history isolation and exact acknowledged-note captures; never treat optional history locks as current-note concurrency control |
| Editor / WorkspaceView / settings / views | Editor drafts precede queued saves; workspace handoff uses flush | Conflict-visible handoff, dirty-editor preservation, refresh on resume; config callers cannot bypass version checks |

## Selected storage contract

`vault-transactions.js` provides transaction-scoped initialization, consistent
snapshot reads, and conditional mutations. `note:<id>` stores a value and version;
null values retain tombstone versions. Settings have per-field versions.
`vault:meta` holds the generation and sequence. A planned batch can require the
sequence to catch changes to its full read scope, including new title/link
dependencies. Full replacement changes generation so older queued mutations fail.

The transaction reads versions and writes changes atomically. It acknowledges
only on transaction completion. A conflicting draft can be recorded in the same
transaction without changing current notes. No Web Locks or expiring lease is
required for this boundary. Async hashing and revision preparation stay outside
the transaction, followed by final precondition checks.

The initialization primitive preserves the exact caller-verified legacy snapshot
and installs records/metadata in one transaction. Calling it is not sufficient
proof that old clients have been fenced. Production activation remains separate.

## Compatibility constraint to resolve before activation

The exact deployed storage module is retained byte-for-byte under
`test/fixtures/legacy/storage-7114047.js`. It opens IndexedDB version 1, keeps the
connection, has no versionchange handler, and falls back to localStorage when
open fails. `legacy-storage.spec.mjs` tests both hazards:

1. An old open connection blocks a version upgrade.
2. After a naive upgrade, a newly loaded old module sees VersionError and returns
   a successful acknowledgement for a localStorage write outside the new IDB
   authority.

Do not solve this by assuming a new broadcast, version field or lease constrains
old JavaScript. Do not make incompatible migration automatic. A compatibility
bridge and its activation boundary must be proved with actual old/new application
builds, offline/cache states and reopen behavior. Module-level tests diagnose the
mechanism; they do not replace full application upgrade acceptance.

## Required completion evidence

- Original nine P1 regressions pass through the production Database.
- Atomic primitive tests cover independent writes, conflict retention,
  multi-note rejection, deletion, config preconditions, full replacement and abort.
- Add migration/restart, dirty/in-flight editor, conflict UI, every planned
  mutation caller, backup/history and old/new build interleavings.
- Run Node 22/24, all three durability browser projects, existing feature/a11y,
  golden corpus, build/budgets/audit and pinned visual gates without weakening them.
- Measure representative vault sizes; verify exact-SHA CI, both deployments,
  provenance and synthetic user behavior. Leave P2 and final soak work separate.

The CI and local test:all gate now include the durability projects. Their current
expected failures are visible release blockers, not skipped tests or a pass.

## Foundation verification, 2026-10-03

- Baseline production Database regressions: 9/9 fail with the expected lost
  content, across Chromium, Firefox and WebKit; each engine covers cross-window
  saves with and without Web Locks and the safety-capture rename race.
- Transaction foundation: 15/15 pass across those engines. These prove the new
  primitive in an isolated IndexedDB fixture, not application integration.
- Exact legacy-module compatibility diagnostics: 6/6 pass, demonstrating both
  upgrade hazards. They are evidence against a naive migration, not a migration
  acceptance pass.
- Typecheck ratchet: no new errors (56 existing baseline errors). Static check
  passes with the existing redundant-block informational diagnostic.
- First Node run: 546/547 pass; the unchanged alias-index performance check takes
  248.3 ms while browser tests run concurrently. Re-run without browser load
  before drawing a performance conclusion; the original failure is retained.
  The isolated rerun passed all 547 cases. The production build and all route
  budgets passed; the unused transaction module does not yet enter that bundle.

Original evidence is retained separately from the evolving implementation under
the local execution artifacts. Complete Phase 1 acceptance remains open.
