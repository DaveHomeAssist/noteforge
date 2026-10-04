# Durable mutation implementation record

Phase 1 reliability repair, based on main 7114047aca10ad9b25839774a22d06370a6456bd.

## Status

In progress, not releasable. The production Database now uses the conditional
transaction module when a vault has been explicitly activated. Both original
P1 reproductions pass through that Database across Chromium, Firefox and WebKit.
Activation in these tests is explicit and limited to disposable synthetic vaults;
it is not evidence that production upgrades are safe.

Normal startup does not activate either empty or populated legacy storage. It
opens a dedicated read-only recovery reader until compatibility is proved. The
reader exports the original loaded storage snapshot and a separately verified
portable backup without starting an editor, sample creation, history, or startup
configuration writes. Legacy recovery reads no longer copy localStorage into
IndexedDB. The application still needs a complete upgrade/activation protocol,
conflict resolution UI, and clean/dirty window refresh integration. Do not merge
or deploy this intermediate state.

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

The CI and local test:all gate include the durability projects. Passing these
does not override incomplete application startup, migration or recovery gates.

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

## Database integration checkpoint, 2026-10-03

- Each ordinary note/lifecycle mutation queues only its affected identities.
  Queue entries retain their generation, base version and detached metadata.
  A same-note conflict retains the draft in IndexedDB and does not prevent an
  unrelated queued note from committing. The aggregate flush remains false while
  any draft is unresolved.
- Planned operations validate the local preview revision around preparation and
  use the observed vault sequence plus note versions at the final IDB boundary.
  This conservatively catches new backlink/title dependencies. A draft queued
  during acknowledgement remains in memory with its old base, so it cannot
  silently undo the committed plan.
- Rename, aliases, mention conversion, bulk plans, Properties, alias migration,
  task commits, revision restore, backup restore and folder reconciliation now
  use the conditional boundary or its guarded whole-vault replacement. Per-caller
  browser acceptance and dirty-editor integration remain to be expanded.
- Revision restore captures its safety state once through the shared commit
  preparation hook. Portable restore retains the reviewed destination token and
  compares the reverified source with the original source fingerprint. Backup
  creation and rolling snapshots read one consistent committed vault.
- Latest integrated browser run: 48/48 pass (16 per engine), including both
  original P1 cases, lifecycle writes, conflicts, queued drafts, phantom backlinks,
  replacement generations, detached metadata/history, config fields, backup
  freshness, persistence timestamps and both activation gates.
- The preceding combined durability run passed 63/63: 42 Database cases, 15
  transaction primitive cases and 6 legacy hazard diagnostics. The six diagnostic
  passes still demonstrate an unsafe naive upgrade, not compatible old clients.
- Node 22.22.1 and Node 24.21.0: 549/549 pass. The count floor is now 549.
  Static checks pass; typecheck baseline decreased from 56 to 48 without raising
  any file allowance. The in-page browser feature suite also passes; it does
  not cover the gated production startup/recovery flow. Build/budgets pass (shell 81.5 KiB / 82.0 KiB; precache
  229.9 KiB / 238.0 KiB); audit reports zero vulnerabilities.
- An earlier development run was interrupted by page reloads during source edits
  (7/9 pass, 2 invalid observations). Its log is preserved separately; fixed-source
  runs above establish the current database results.

### Remaining release requirements

1. Prove and implement the old/new-client activation barrier using real builds,
   including cached navigation, suspended/back-forward pages and fallback writes.
   The IndexedDB specification explicitly rejects lower-version opens and waits
   for old connections to close; a version bump is therefore not a full client
   compatibility solution. [IndexedDB open algorithm](https://www.w3.org/TR/IndexedDB/#opening)
2. Complete the upgrade action, conflict comparison/resolution, draft export and
   exact save-state UI. The read-only recovery reader now avoids automatic sample
   creation and startup config writes; it does not authorize activation or replace
   the required editing/conflict recovery experience.
3. Refresh clean views on notifications/resume while preserving dirty editors and
   pending conflicts. Revalidate every affected caller with real editor drafts,
   history/backup failures and migration interruptions.
4. Complete performance measurements, full Node/browser/a11y/golden/visual gates,
   exact-head CI/review, merge/deploy, provenance and both-origin live acceptance.

A service worker is not assumed to be able to evict every old runtime: the
navigation algorithm rejects a window whose document is not fully active. Test
the actual suspended-page boundary rather than substituting a successful active
tab handshake. [Service Worker navigation](https://www.w3.org/TR/service-workers/#client-navigate)

## Read-only recovery checkpoint, 2026-10-03

The production entry point now opens a dedicated recovery reader when the
Database is read only. It does not initialize the editor, sample notes, startup
config writes, optional history, or background feature controllers. Users can
read Markdown source (including Trash/Archive), export the original loaded
notes/settings/schema snapshot, and create an independently verified portable
backup. Theme changes do not queue vault writes. Reload reads the source again;
there is deliberately no migration bypass button.

The legacy recovery read uses one IndexedDB read transaction and does not copy
fallback localStorage entries into IndexedDB. Source export and portable backup
are distinct: the former preserves the loaded pre-normalization values; the
latter validates the current note model and integrity digest. This does not yet
cover malformed/future-schema startup failures or concurrent conflict drafts.

Verification on this checkpoint:

- 57/57 browser scenarios pass (19 per engine): 48 existing Database cases plus
  nine production recovery cases covering IndexedDB legacy notes, localStorage
  legacy notes, and unavailable IndexedDB. Downloads are read back and verified;
  original note/config/schema records stay unchanged; localStorage recovery does
  not create IndexedDB note records; current/history queues remain empty.
- Recovery axe scans have zero violations. Light/dark toggles and root overflow
  checks pass at 1440×900, 375×812 and 3840×1080; the mobile status remains fully
  visible. The phone screenshot was inspected.
- Node 22.22.1 and 24.21.0 each pass 549/549 in sequential runs. An earlier run
  under heavy host load failed the existing 150 ms alias-index budget (198.8 ms;
  isolated retry 233.5 ms). The prior commit and current code then passed the
  targeted check, and both full sequential suites passed unchanged. Preserve the
  initial failure logs; no timing allowance was raised.
- Check and typecheck pass (48 existing baseline errors, no increase). The
  production build and budgets pass: shell 81.7/82.0 KiB gzip, precache
  232.2/238.0 KiB. The development warm-up still emits the previously recorded
  unclassified `[Unhandled error] Unknown Error: [object Event]` diagnostic;
  the production recovery tests report zero page errors.

This closes the unusable gated-startup recovery path, not the migration or
ordinary editing acceptance. Full application smoke/visual gates must still
pass once safe activation is implemented. The previous integration commit's
visual CI job failed; no merge or deployment is authorized by these local passes.
