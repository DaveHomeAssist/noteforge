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
| CaptureService | Exact submitted note receipt; retained request for retry; current dialog owns completion | Per-pane/open-editor integration and atomic creation identity still need qualification |
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

## Reviewed history comparison contract

History now captures a detached destination note and mutation token before
asynchronous revision materialization. Restore receives that reviewed snapshot
from the dialog, including across its confirmation wait. It cannot capture a
new destination base after the user has confirmed an older comparison. The
shared conditional commit boundary still validates before and after safety
capture and inside the storage transaction. Safety history therefore describes
the exact accepted predecessor.

Core planned-write rejection now exposes `code: 'stale_plan'` from token/source
checks and link/bulk preflight checks. History uses that code to disable restore
and offer Refresh comparison. Refresh performs a consistent read of current
storage behind the app's pending-write and editor-draft checks. It displays the
new comparison without applying anything; a second restore and confirmation are
required. Dismissal or reopening invalidates pending confirmation and prevents
late completion from modifying the new dialog. Programmatic restore callers
without a preview retain the existing immediate-operation API; the History UI
always passes its reviewed preview.

Two maintained service regressions failed on the previous implementation:
an acknowledged edit during confirmation was overwritten, and a preview read
its current note only after materialization. Coverage also checks detached tag
metadata. Four browser scenarios use the actual History UI and app callback on
synthetically activated IndexedDB vaults: cross-window stale preview and renewed
confirmation with exact safety content, same-window confirmation interleaving,
dismiss/reopen, and an unqueued draft blocking refresh. These are added to all
three durability projects. Final verification is recorded in the local
`preview-checkpoint.md` artifact for this source commit.

This is one affected caller, not completion of planned mutation UX. Link tools,
vault find/replace, bulk actions, backup and reconciliation still require their
own explicit refresh and confirmation ownership coverage. Exact save-state UI,
activation safety, remaining failure/backup/derived-view gates, budgets, CI,
review and deployment remain release requirements. No migration gate or budget
limit was relaxed.

History checkpoint verification on the final runtime source:

- Full existing-plus-new durability matrix: 195/195, Chromium/Firefox/WebKit.
- Three additional keyboard/layout cases: 12 zero-violation axe scans across
  the same engines, light/dark themes and 1440/375 widths. These inspect History,
  not the whole application or physical devices.
- In-page feature suite: 505/505. Node 22/24: 555/555 each, with floor 555.
- Check passes after removing an extra blank line in the new test; the failed
  formatting log is preserved. Typecheck retains its existing 47-error baseline.
  Build succeeds and audit reports zero vulnerabilities.
- Shell 85,451/83,968 B and precache 246,722/243,712 B fail unchanged budgets.
  No full application/visual CI or production migration acceptance is claimed.
- The unclassified Vite warm-up `Unknown Error: [object Event]` remains visible;
  this checkpoint does not reclassify or suppress it.

## Explicit review across planned mutation views

Link tools, vault find/replace, bulk actions, portable/local backup restore,
folder reconciliation and Properties now receive the app's guarded preview
refresh. A rejected plan cannot simply be applied again: refresh reads saved
state, preserves the proposed input where meaningful and builds a new preview.
The user must apply again, including renewed destructive confirmation where the
operation requires it. Folder decisions reset because changed source/destination
pairs need new choices. Bulk retry displays the affected note names in a bounded
list. Properties retains raw YAML drafts and displays refreshed saved YAML
separately; its body comes from the newly reviewed source.

Properties captures a detached note/token before parsing for display, rather
than capturing its base when Save is clicked. Reconciliation captures its plan,
decisions, source readers and token before the first await. A concurrent newer
scan invalidates an older apply instead of supplying it a newer token. Starting
a new folder selection disables the previous plan before file/picker reads.
Whole-vault callers opt into typed stale rejection while the existing boolean
replacement API remains compatible. Transaction conflicts remain recoverable.

Dialog ownership invalidates pending confirmations and preview completions on
close/reopen or changed intent. Refresh never auto-applies. These checks do not
claim that closing a dialog rolls back a commit already in progress. Completion
after dismissal, pending editor drafts during every caller's preparation, local
snapshot retry, alias/mention identity changes and full derived-view refresh
still require expanded application acceptance before Phase 1 release.

The maintained service regressions for reviewed Properties source and an
in-flight reconciliation using a newer scan token both failed before repair.
Browser evidence uses synthetic vault activation; it does not establish safe
migration or ordinary production startup. Existing phone root overflow (F07)
is recorded separately from component accessibility and non-regression geometry.
No shell fix, migration activation, budget exception or deployment is included.

Cross-engine review found two additional issues in the affected surface. The
scrollable replacement preview needs a keyboard focus target; it and the new
bounded bulk review region are now labelled focusable regions. WebKit can deliver
a delayed input `change` while an asynchronous preview refresh is pending. Find
invalidation now compares actual values/options, so duplicate notifications do
not cancel an unchanged review; real input or scope changes still invalidate it.
The confirmation regression explicitly exercises both cases. Initial failures
and their traces remain in the checkpoint evidence.

Final checkpoint verification:

- Full durability matrix: 225/225 across Chromium, Firefox and WebKit. Six
  passing legacy diagnostics still demonstrate unsafe naive activation.
- The six new review surfaces cover 72 engine/theme/viewport combinations with
  zero axe violations and no additional root overflow. Saved geometry records
  show the existing 375×812 shell is 860 px tall with or without those surfaces.
  The included History checks cover another 12 zero-violation combinations.
- In-page feature suite: 505/505. Node 22.22.1 and 24.21.0: 557/557 each,
  sequentially. Static checks pass; typecheck retains 47 baseline diagnostics.
  Build passes; audit reports zero vulnerabilities.
- Synthetic ordinary-save measurements at 1,000/5,000 notes touch one note
  record per save without cursor scans; p95 was 1–1.9 ms across engines and
  whole-vault refresh took 22–269 ms. Coarse clocks can report zero; this is an
  isolated persistence measurement, not editor/history end-to-end performance.
- Shell/precache budgets still fail; exact values are in `performance_budgets.md`.
  Full application/visual CI, safe activation, review and deployment are open.
  This is a verified implementation checkpoint, not Phase 1 completion.

## Editor adoption and buffered drafts

The editor tracks its rendered/submitted Markdown separately from the current
Database value. This is a local source baseline, not a claim of durable saving.
A clean pane adopts committed source changes and resets incompatible undo history;
a dirty pane retains its text. Focused replacement content remains editable, and
unfinished title text/selection survive a source refresh. Change events from a
detached title input cannot start a new rename during that refresh.

The app supplies one synchronous draft flush covering all mounted workspace
editors. Planned writes and whole-vault replacement invoke it before validating
their preview. Planned writes, replacement and conflict resolution also flush
immediately after transaction acknowledgement but before advancing local versions
or replacing the model. New drafts therefore enter the existing queue with their
original version/generation and retain conflict recovery instead of silently
undoing the just-committed operation. No arbitrary asynchronous UI work runs
inside an IndexedDB transaction.

Application completion callbacks use a normal reopen or `syncAuthoritative` to
retain buffered typing; explicit `discardPending` remains an opt-in editor API.
History compatibility is checked after flushing the draft, so a same-source
rebuild retains legitimate undo steps. A clean obsolete source is a save no-op.
Composition text is serialized even
before its delayed input handler schedules autosave, and a same-note completion
does not replace a composing editor. Synthetic composition-event coverage is
automated race evidence, not physical IME acceptance.

The pre-fix application regression reproduced a stale clean pane and loss of
typing during acknowledgement. Maintained coverage includes safety-capture edits,
focused replacement/continued typing, title selection, both panes of a rename,
replacement generations, Properties completion and conflict resolution. See
`test/e2e/editor-adoption.spec.mjs`. Exact per-version acknowledgement UI, other
caller/failure combinations, end-to-end performance and production activation
remain release gates; this contract does not infer saved status from an empty queue.

Application behavior, accessibility and visual fixtures explicitly activate an
empty disposable vault before opening a fresh app instance. Each fixture first
asserts the ordinary startup is an empty read-only recovery reader. This lets
the existing application gates exercise editing without changing or bypassing
the production activation policy. These tests prove behavior after synthetic
activation, not safe migration of a real existing profile. The offline fixture
keeps its first page alive until the installing service worker controls it;
the subsequent page must independently satisfy the existing control/offline
assertions.

Properties keeps focus inside its loading dialog and returns to the current
trigger after editor replacement. A successful property mutation reads the
adopted model without a redundant storage refresh that can race derived writes;
opening the dialog or explicitly refreshing a stale review still performs the
guarded storage read. The malformed-YAML repair smoke verifies repaired source,
unchanged body and reload persistence, rather than merely checking a notice.

Checkpoint evidence: the complete local run finished with 330/332 passing
(256/258 durability, 27/27 application tests, 47/47 axe tests). The two failures
were the same conflict fixture in Chromium/Firefox: clean-window refresh could
adopt the independent write before the test began its conflicting edit. The
fixture now takes editor focus before that write and asserts a conflict exists;
three repetitions in each engine pass (9/9). The original failing report is
preserved; these are a full run plus a targeted correction, not a claimed single
332/332 local run. In-page checks are 505/505; Node 22/24 are 557/557 each.
Static checks pass and typecheck retains 47 baseline diagnostics. Build/audit
pass; shell/precache budgets still fail. CI, visual review and deployment remain
independent gates. All application fixtures here use synthetic activation.

## Recovery review initialization and rendering qualification

The application shell's `ready` promise does not cover deferred alias
reconciliation. That reconciliation can persist the frontmatter migration
marker after a conflict comparison has opened. The resulting local revision
change correctly invalidates the old choice. The ordinary recovery UI fixture
now waits for deferred Phase 5/6 initialization and current writes before
opening its comparison. A separate maintained test holds the actual Phase 5
module request until after review, releases it, verifies rejection without a
copy/archive write, and requires another explicit choice. Both original
contents survive; the accepted second choice creates exactly one recovered
copy and archive after reopen. Three repetitions in each engine pass (18/18
including the ordinary fixture). No storage precondition was relaxed.

The planned-review accessibility helper now waits for fonts, rendered frames
and completion of CSS animations/transitions, matching the existing main
accessibility lane's settled-rendering contract. Its former fixed 250 ms delay
failed a controlled slow-theme transition with measured contrast below the
unchanged 4.5:1 requirement. Maintained find/replace and backup cases exercise
two-second transitions/entrance animations. Review scans retain computed
colors, opacity and animation metadata for diagnosis, along with their existing
geometry evidence. This does not change application colors, suppress axe rules,
or change screenshot/accessibility baselines.

The original WebKit CI failures were intermittent. Six ordinary instrumented
local repetitions passed with no active animations in their 24 samples. The
slow-transition control proves the missing readiness guarantee, not the precise
renderer timing of those historical failures. Exact-head CI remains the next
qualification gate. Migration activation, exact save acknowledgement UI,
budgets and the other Phase 1 acceptance items above remain open.

CI retains Playwright reports after successful browser jobs as well as failed
ones. This preserves flaky first attempts and rendering attachments even when
the browser step succeeds and a later build or budget step fails. Retention is
still seven days; this does not alter retry policy or any gate result.

The complete affected conflict-recovery and planned-preview suites pass
105/105 across Chromium, Firefox and WebKit, including both slow-transition
controls. Static checks pass; typecheck remains at 47 baseline diagnostics.
The Playwright setup built the unchanged application successfully. The original
failed slow-transition report and all subsequent reports remain preserved.

## Exact note submission receipts

`saveNoteWithReceipt(note, options)` returns the existing mutable `note` and a
`completion` promise for that submitted snapshot. Existing `saveNote` callers
retain their return value and behavior. A receipt resolves with `noteId`, vault
`generation`, a detached `note` snapshot, and one terminal status:

- `committed`: the transaction was acknowledged; `version` is the exact committed
  note version. Optional history is outside this acknowledgement.
- `superseded`: a newer queued snapshot replaced this one before its write
  began. It was not individually committed, even if a later draft contains it.
- `conflict`: the precondition failed; `conflictId` identifies retained recovery.
- `failed` or `unavailable`: no successful acknowledgement was received. The
  draft remains pending; do not infer rollback or delete it.

Only `committed` supplies a version. A failed receipt is terminal and does not
turn into success when storage is retried. An explicit resubmission receives a
new receipt. A replacement submission during a failed drain is eligible for its
own attempt; the unchanged failed entry is not hot-retried. An in-flight older
submission can commit while a newer draft remains pending, and each receives
its own exact snapshot/version outcome. Mutable receipt data cannot alter the
stored note or the private saved baseline. Receipts from read-only or injected
unversioned storage report `unavailable`, never a fabricated committed version.

`getNoteSaveState(id)` describes the current model against that note's queued
snapshot or confirmed saved baseline, with pending, in-flight, dirty, committed,
conflict, failed, unavailable and missing states. An empty global queue is not
sufficient. `subscribePersistence` provides separate notifications so a save
indicator can update without rebuilding the editor. Its observers cannot change
a storage outcome and must unsubscribe when their owner is destroyed.

Conflict resolution now adopts the actual committed snapshot into saved
baselines/versions, then overlays retained drafts only into the local model.
Previously, the overlay was passed into authoritative adoption and could label
an uncommitted draft as the saved baseline. The maintained acknowledgement race
reproduced that mismatch in all three engines before the change. The original
draft remains on its original queued base, so this repair does not silently
rebase it or bypass conflict handling.

Receipt/adoption checks initially passed 18/18 across the three engines. The full
local run then passed 365/365: 291 durability checks, 27 application cases and 47
axe scans. This includes generation, unavailable-storage and observer cases.
Node 22/24 pass 557/557 each. Per-pane UI and application caller adoption remain
required: the API alone does not complete user-visible save acknowledgement.
Do not use receipt contents to replace newer buffered typing or treat a previous
committed version as proof of the current draft.

## Refreshing an invalidated initial conflict comparison

The preceding checkpoint's CI run 37175809809 completed with 341 clean browser
passes on Node 24, and 340 clean passes plus one retried WebKit recovery-export
case on Node 22. Both builds passed and both budget gates failed. The original
startup and contrast cases passed in both lanes. The new recovery case showed a
correct stale-preview rejection during initial loading, with blank comparisons
and no direct refresh action; no new data loss was established.

Recovery now exposes **Refresh comparison**. Loading clears the old comparison
and disables mutation choices; the still-existing selected conflict is retained.
Refresh never applies a choice. A delayed older read failure cannot replace the
status of a newer review. Refresh is disabled while a recovery commit is busy.
The ordinary export fixture now waits for actual deferred startup; the separate
adversarial startup case remains unchanged.

A held-read/config-change regression fails the prior UI because the refresh
control is missing. After the fix, all 63 recovery checks pass across Chromium,
Firefox and WebKit, including both new refresh races, export, axe and 1440x900 /
375x812 root geometry. The mobile recovery screenshot was inspected with all
footer controls inside the viewport. This affected-suite run follows the clean
365-case run; a combined exact-head CI run is still required.

Final static/typecheck checks pass (47 retained typecheck diagnostics). Build
succeeds. Gzip budgets still fail: shell 86,275 / 83,968 bytes and precache
251,148 / 243,712 bytes; conflicts is 6,247 / 7,168 bytes. Limits, accessibility
rules and visual baselines are unchanged. Migration activation, UI/caller
acknowledgements, remaining acceptance and release verification remain open.


## Quick Capture acknowledgement and form ownership

Quick Capture now waits for its own versioned submission receipt. An unrelated
note conflict does not turn an acknowledged capture into a failure. The returned
note is the detached committed snapshot; later destination typing is neither
reported as the captured content nor replaced by the completion callback.
`createNoteWithReceipt` adds the same contract for creation while preserving
`createNote`'s existing return value. Capture opts into `quick_capture` history
for its initial nonblank note as well as appends; ordinary blank creation keeps
its prior history behavior.

One request object identifies one capture attempt across retries. CaptureService
retains its original submission in a WeakMap. A retry resubmits that exact snapshot
only while the local destination still matches it; it never appends the Markdown
again. A changed destination requires review. Repeating an already successful
request returns the same acknowledgement without another write. Returned note
and receipt data are detached from retained request state. Callers must retain
the request object for retries and use a new object for a new capture; this is an
in-session contract, not persistent exactly-once delivery across browser restarts.

The capture dialog snapshots all text, title, URL, image and destination fields
before asynchronous image preparation. Closing before submission cancels that
preparation. Once queued, the write still completes, but a closed or reopened
dialog cannot be changed or navigated by an old completion. New input entered
while saving remains in the form and is explicitly described as unsaved. A
failed submission exposes Retry capture for the retained request. Successful
post-save navigation is separate from storage acknowledgement; navigation failure
does not turn a committed capture into an apparent failed save.

Four maintained baseline cases fail before this change: unrelated conflict,
returned newer content, lost newer form text, and duplicate append on retry.
The final capture suite passes 39/39 across Chromium, Firefox and WebKit,
including creation/history/reopen, immutable repeated acknowledgement, changed
retry destination, old dialog completion, real image preparation/dismissal and
post-save navigation failure. The launcher no longer blocks opening Capture
because another note is conflicted: it flushes editor buffers, retains the
storage warning and lets each destination submission decide its own outcome.
A real application regression first reproduces the blocked dialog, then proves
independent capture/reopen while the other editor draft remains recoverable.
A blocked post-save handoff is explicitly reported separately from the saved
capture. One invalid destination locator in the image
fixture was diagnosed from a live trace and corrected; its interrupted report
is preserved. The unversioned Node fixture now asserts unavailable acknowledgement;
real IndexedDB browser tests cover the previous happy-path integration. No fake
version is supplied to make a legacy backend look durable.

This checkpoint does not complete editor save indicators, all caller acceptance,
atomic creation-name/alias concurrency, migration activation, performance or
release gates. In particular, successful creation receipts alone do not prove
that two stale windows cannot independently create the same title or Inbox.


Final local capture checkpoint gates: 39/39 three-engine capture checks and
27/27 final application checks (including the 505-check in-page suite and offline
service-worker smoke). Before the final launcher-only change, the full
application/axe lane passed 74/74, including all 47 axe scans. Node 22/24 each
pass 557/557 on the final runtime; static/typecheck pass (47 retained typecheck
diagnostics), fresh build succeeds and audit reports zero vulnerabilities.
Budgets remain failing: shell 86,285/83,968 and precache 251,769/243,712 gzip
bytes; the daily route passes at 20,277/22,528. No limits or visual baselines
changed. Combined exact-head CI and visual qualification of this checkpoint are
still required; previous c12e379 CI passed 371 browser cases cleanly in both
Node lanes and pinned visuals, then failed budgets.

### Per-pane save state (2026-10-04, unreleased)

Each editor pane renders an in-place live status alongside Retry save and Review
and export actions when applicable. The status checks the current note's versioned
persistence state and the actual buffered content/title/composition. An older
acknowledgement or an unrelated note's successful write cannot label newer typing
as saved. "Saved on this device" describes the matching committed note snapshot;
it does not promise a remote backup or acknowledge an unconfirmed title change.

Pending/in-flight writes show Saving. Buffered content and composition remain
unsaved; title input awaiting the existing rename flow is explicitly unapplied.
Conflicts, failed transactions and unavailable storage take priority over the
buffered indication and retain recovery access. Retry submits the current draft
with its existing base; it does not silently overwrite a conflict. Review uses the
same recovery/export boundary as the persistent storage warning.

Persistence notifications update only the status and controls. They do not rebuild
the block editor or change title selection/focus. Editor destruction submits
buffered content, cancels its debounce, unsubscribes and tears down its owned
views; workspace destruction disposes the secondary editor while preserving the
primary editor returned to its parent.

`editor-save-state.spec.mjs` exercises buffered writes during delayed receipt,
title/content composition, unrelated-note isolation, failed-save retry, conflict
recovery, navigation to a different draft, read-only indication and listener
cleanup in Chromium, Firefox and WebKit. The real application case opens recovery
from a pane and scans the new status/actions with axe. The two original indicator
regressions failed before the implementation. The initial combined save-state,
adoption and capture run passed 93/93; the final title-composition follow-up passed
21/21 save-state cases. Full application/a11y and pinned visual gates remain
separately recorded release evidence. Physical IME/phone acceptance and the
existing F07 page-overflow finding remain open.

Prior capture-head CI at 97a7313 completed with 410/410 clean browser passes and
557 unit cases in each Node 22/24 lane; pinned visuals passed. Both lanes then
failed shell/precache budgets. That result covers the previous head, not these
new visible indicators. Migration activation, atomic creation identity, remaining
caller and end-to-end performance acceptance, budgets and release proof remain
required before this branch is releasable.
