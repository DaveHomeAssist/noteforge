# Feature loading and invocation recovery

Scope: Phase 2, F04/F05/F10, based on main cf5a8dee. The six component UI release is preserved.

## Problem and outcome

Failed lazy assets currently reject event-handler promises; deferred openings can outlive Escape or navigation; a failed Properties stylesheet can be retained by preload machinery. Users need a bounded, accessible recovery path and predictable dismissal without losing drafts.

## Contract

Share feature loading and singleton creation independently of invocation lifetime. Each explicit opening owns a generation and checks it after every wait before opening, focusing or mutating. Escape, a newer opening, navigation and owner teardown cancel pending invocations. Global Capture retains its explicitly supplied payload and destination while loading; navigation cancels its opening rather than silently retargeting it. Cancellation never cancels another consumer's shared module load.

Expose loading, ready, recoverable failure, reload-required and cancelled states. Essential recovery UI and dialog geometry are part of the shell. Feature JavaScript remains lazy. A recoverable transport failure permits one explicit retry; persistent or module-evaluation failure requires a controlled reload after confirmed durable writes, with a draft export alternative. No automatic reload or cache-busting imports.

Adopt the boundary for Properties, Capture, Palette and Backup and audit adjacent openings. Deduplicate singleton construction. Preserve per-note storage, activation, legacy capture and existing note content.

## Acceptance and delivery

Promote the original delayed-opening, failed-import and stylesheet reproductions to maintained production-preview tests before fixes. Cover Escape, note/pane changes, supersession, repeated clicks, cached evaluation failures, bounded retry, computed layout, warm offline first use, zero unhandled rejections and no duplicate mounts/focus theft. Run affected tests across all three browser engines, full Node 22/24 CI, a11y, pinned visuals, audit/build and unchanged budgets (shell 99,328 B; precache 281,600 B). Verify both published origins and saved-note upgrade flows before closure.

No Phase 3/4 defects, six-hour soak, physical-device campaign, new dependencies or spending are included. Physical/human acceptance and prior Phase 1 residuals stay open.

## Evidence

The six production-preview reproductions failed against the PR43 main baseline:
four delayed dialogs opened after cancellation, Capture evaluation failure had no
recovery surface, and Properties lost its dialog layout after CSS failure.
`test/e2e/feature-recovery.spec.mjs` retains those contracts and expands coverage
across Chromium, Firefox and WebKit; `test/feature-loader.test.mjs` covers load
sharing, failure caching and the single explicit retry.

The shell owns a `FeatureActions` invocation generation and a separate
`FeatureLoader` cache. Main entry points for History, link tools, Tasks, Calendar,
Clipper, reconciliation, Trash, Settings, Archive, Find, Graph and Daily notes use
the same boundary. Existing view-specific mutation epochs remain in place.
Opening another modal cancels a pending invocation. Daily creation checks the
owner after loading and saving. Phase controller public fixture APIs remain
compatible; this change does not replace every internal mutation/confirmation
with the loading boundary.

Properties, Capture, Palette and common recovery geometry are shell CSS. History
presentation remains lazy. A failed optional stylesheet requires reload because
preload helpers can retain a failed link; retrying it could open an unstyled view.
No imports are cache-busted and no recovery action reloads automatically.
Reload verifies and preserves drafts and starts a new app invocation state; it
cannot guarantee repair of a failed asset retained by a browser or still served
by the deployment. In the WebKit fault fixture, failed asset loading survived
reload. Repeated failures remain bounded and export remains available.

Release evidence belongs to the associated PR and exact-revision CI and deployed
build stamps. Physical acceptance, the six-hour soak and prior Phase 1 residuals
remain outside this repair.
