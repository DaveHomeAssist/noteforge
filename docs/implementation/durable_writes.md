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
IndexedDB. Conflict comparison, resolution and export now have a lazy recovery
UI for explicitly activated vaults. The application still needs a complete
upgrade/activation protocol and complete release qualification. Clean-window
refresh is implemented with conservative dirty-window deferral below. Do not merge
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
2. Complete the upgrade action and exact save-state UI; broaden conflict recovery
   acceptance across real editor callers. The read-only recovery reader avoids automatic sample
   creation and startup config writes; it does not authorize activation or replace
   the required editing/conflict recovery experience.
3. Qualify refresh across the remaining application views and lifecycle
   combinations. Revalidate every affected caller with real editor drafts,
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

## Conflict recovery checkpoint

An activated vault now offers Review and export from the persistence warning,
including conflicts loaded after reopening. The bounded modal compares saved
source with retained drafts, exposes complete metadata, and supports keeping the
saved version, creating a new note copy, or explicitly replacing a saved version.
Settings conflicts use the same conditional boundary. Planned operations and
old-generation drafts cannot be blindly reapplied; they need a new plan or copy.

The preview keeps a private, detached commit contract. Resolution compares the
vault generation/sequence and exact conflict record in one IndexedDB transaction.
The transaction archives the original conflict and any replaced note/config
values before removing the active conflict. Archive identities include the
generation and commit sequence, so a later draft cannot overwrite an older
resolution archive. A failed/aborted resolution leaves current data and the
original conflict intact. Explicit note replacement captures safety history for
the exact saved version before the conditional commit.

Queue entries are removed only when they are the entries actually resolved.
Newer queued drafts and raw model edits during acknowledgement are preserved on
their original base and must resolve any resulting conflict. Local edits after
review invalidate the choice. Conflicts from other windows discovered during
preview remain visible after adopting the committed snapshot. Adoption uses the
transaction-proven snapshot rather than a fallible post-commit read.

Recovery JSON includes local notes/config, known and newly read stored conflicts,
and archived resolutions. Active conflicts are read before the archive so a
concurrent resolution cannot vanish between those reads. If either read fails,
local draft export remains available and records the missing data. This file is explicitly not a portable backup;
users must not substitute it for a verified vault backup. Resolved archives have
no automatic pruning policy yet; retention/export UX and storage growth need
qualification before release. The recovery UI remains lazy; the revision-only
lease fallback is also deferred. Current-note correctness never depends on that
lease or Web Locks.

This checkpoint does not close safe activation, window refresh/resume, all
affected-caller acceptance, malformed/future-schema recovery, performance,
ordinary application/visual CI, or either deployed-origin gate. Migration remains
disabled and the branch must remain draft until the complete phase is releasable.

Checkpoint verification:

- 129/129 durability cases pass across Chromium, Firefox and WebKit: Database,
  conflict recovery, read-only recovery, atomic primitive and old-client hazard
  diagnostics. Six passing legacy diagnostics still establish unsafe upgrade
  behavior, not safe activation. UI checks include axe, viewport bounds and
  downloaded recovery files. The added invalid-batch cases prove validation
  cannot partially write a valid note alongside an invalid note/setting.
- Node 22.22.1 and 24.21.0 each pass 549/549 sequentially; audit reports zero
  vulnerabilities. Static check passes and the typecheck ratchet falls from 48
  to 47 after typing the extracted lease-release promise. No allowance was raised.
- After the final export change, six affected UI cases pass across all three
  engines, including newly stored conflicts and local draft export when both
  stored-conflict and archive reads fail. The mobile screenshot was inspected.
- Production build passes. Budget gate fails: shell 84,022/83,968 B and precache
  243,817/243,712 B gzip. Existing limits remain unchanged. The conflict and
  read-only recovery routes use the documented new-route budget calculation.
- The full application/visual release gates remain incomplete while startup
  activation is gated. These local checks do not establish CI, deployment or
  either live origin. The development warm-up's previously recorded unclassified
  error diagnostic remains visible in the logs.

## Window refresh contract

After the usable editor is ready, a lazy watcher listens for committed-write
hints, BroadcastChannel notifications, window focus/pageshow, visibility changes
and focus departure. A visible window also checks every 15 seconds so notification
loss is not permanent. Hidden windows do not read for polling. Disposal removes
listeners/timers and prevents an in-flight read from adopting after teardown.
Messages contain no note content and do not acknowledge or authorize writes.

The Database tracks detached serialized note baselines and saved configuration
values from adoption and exact write acknowledgements. A refresh is deferred if
there are queued writes, a drain/replacement in progress, a raw model/config edit,
an active or dirty editor, a banner operation or a modal. The same guards run
after the consistent read; a changed local revision or another completed refresh
also rejects the old read. Failed reads leave local state and tokens intact.

Clean adoption updates notes, tombstones, settings, conflict records and derived
indexes together, invalidates earlier local plans, and emits changed IDs with an
external-origin flag. Editor source replacement resets incompatible undo/redo
history; metadata-only refresh retains that history. The app updates settings
without persisting them again and removes an invalid deleted-note selection.
Workspace normalization may select another valid note or show an empty editor.
Current pane state remains local; refresh does not open another window's tabs.

Checkpoint verification: the fixed-source durability matrix passed 177/177
cases across Chromium, Firefox and WebKit. Node 22 and Node 24 each passed all
549 cases, static/typecheck gates passed, the production build succeeded and
audit reported zero vulnerabilities. Shell and precache budgets still fail;
measurements and scope are recorded in `performance_budgets.md`. No production
activation, exact-head CI acceptance, merge, deployment or live proof is claimed.
Earlier fixture errors and the integrated run deliberately interrupted to fix
pending version-zero adoption remain preserved as failed/incomplete evidence.

This deliberately defers the whole window while dirty. It does not claim that
every clean pane advances independently of a dirty pane, or that remote changes
are collaborative edits. A draft that later saves against a changed note or
generation reaches the existing explicit conflict flow. This avoids rebasing
an old draft onto a new generation merely to make the display appear current.

Startup migration is still gated. All derived-view acceptance,
real suspended-page/offline behavior and production
delivery remain requirements; passing resume-event injection is not a claim of
physical browser suspension acceptance.

## Shared configuration and window state

`WindowState` owns only `workspace`, `recentNoteIds` and `collapsed` in versioned
`sessionStorage`. App startup, the navigation controller, NoteList and WorkspaceView use
that store explicitly. Opening, closing, reordering, splitting and scrolling
tabs do not enqueue shared configuration writes or advance the vault sequence.
Each top-level window restores its own layout on reload; a duplicated browser
tab may inherit the browser's initial sessionStorage copy and then diverges.
Closing a session does not promise cross-session workspace restoration.

Legacy config can seed a window that has no session record. The seed is detached;
it is never kept synchronized with other windows. Existing legacy fields remain
in preserved data/backups for compatibility, but new navigation does not update
them. Session layout contains note IDs/presentation only, not source or drafts.
Existing workspace/recent normalizers prune missing/deleted IDs and retain limits.

Shared preferences (theme, font, width, autosave, templates, sort and
sidebar), saved searches, folder mappings, property schemas and backup
metadata retain field-level version checks. Different fields can commit
independently; competing changes to one field preserve an explicit conflict.
Array/object fields are replaced conditionally as a unit, never blindly merged.

If sessionStorage reads/writes fail, navigation continues in memory with one
accessible warning about layout persistence. It never falls back to shared
vault or localStorage writes. Malformed/future session records are left intact
and unused; durable note writes retain their own independent success/failure
contract. Portable backup authority remains the committed vault, not the current
window's open tabs or navigation history.

Session-state checkpoint verification:

- Final durability matrix: 183/183 across Chromium, Firefox and WebKit. The
  six window-state cases exercise nested-note expansion, independent layout and
  recents, reload, unavailable session storage, unchanged vault sequence/plan
  token and durable note writes. All activation remains synthetic.
- In-page feature suite: 505/505 checks after adapting the isolated component
  fixtures to the explicit window-state dependency. The initial missing
  WorkspaceView fixture dependency failed visibly and its trace/log are retained.
  An earlier nested fixture used the wrong parent-setting API; that attempt was
  deliberately interrupted and corrected, not counted as a pass.
- Node 22/24: 553 cases each, zero failures; case floor raised to 553. Static
  checks and the 47-diagnostic typecheck ratchet pass. Production build passes
  and audit reports zero vulnerabilities. Shell/precache budget failures remain
  as recorded in `performance_budgets.md`, with no raised limit or exception.
- Remaining delivery gates are unchanged. In particular, the rename dialog
  currently re-enables its old preview after a stale-plan error; explicit
  re-preview across planned mutation callers is still required. Production
  migration, full application/visual CI, both deployments and live acceptance
  are not established by these local tests.
