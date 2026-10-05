# Storage recovery archive

Status: implemented on the Phase 1 branch, not a migration activation or portable
restore mechanism. The release gate in `durable_writes.md` still applies.

After activation the archive also carries `vault:legacy-backup` (both legacy
backends as activation read them), `vault:legacy-capture` (the capture baseline)
and any `vault:legacy-archive:` records (legacy settings captured but not applied).

## Recovery surface

The basic read-only screen and its CSS are part of the initial shell. A separate
lazy asset is not required to read supported legacy source, download loaded source,
change theme or reload. Portable backup conversion and full storage archive export
remain independent actions with caught failures. Failure of either action cannot
remove the basic recovery screen or enable editing.

A newer IndexedDB database version or a blocked open stops startup before legacy
fallback can masquerade as an empty vault. The archive opens the existing database
without specifying a version, so it can preserve stores that this app cannot
interpret. It aborts creation if no database exists; it never upgrades for export.
A queued open times out after ten seconds. A connection arriving after timeout is
closed, so a failed export cannot keep a future upgrade blocked.

The guidance panel can scroll, while the result/status stays visible inside its
bounded section. Notes scroll independently; root bounds and accessibility are
checked at desktop and phone sizes, with ultrawide root bounds also covered.

## Capture contract

The archive reads all object stores in `my-notes-app` in one readonly transaction.
It includes each store's name, key path, auto-increment flag, index definitions,
and every key/value pair, including revision, snapshot, conflict and unknown
namespaces. The export connection closes before binary encoding begins.

It separately reads every `my-notes-app:` localStorage value as a raw string.
Other applications' keys and per-window session state are outside this archive.
Close other NoteForge windows before exporting. This is not a common atomic
snapshot across the two backends: the HTML storage standard does not provide the
cross-window locking or cross-backend transaction that would guarantee one.

A read/transaction/encoding failure prevents download; no partial file is called
successful. When the IndexedDB API is absent, the archive records that unavailability
explicitly and can preserve accessible localStorage. It does not assert that an
inaccessible database is empty. Absence and unavailability are distinct states.

## Format and decoding

`noteforge-storage-archive` version 1 contains capture time, IndexedDB availability,
consistency/restore limitations, and a `structured-source-v1` graph. The graph
preserves ordinary objects, null-prototype objects, arrays/holes, shared references,
cycles, undefined, numeric edge values, bigint, Date, RegExp, Map, Set, ArrayBuffer,
standard integer/float/bigint views, DataView, Blob and File. Unsupported types
fail explicitly rather than becoming empty objects or disappearing from JSON.

`encodeRecoveryValue` and `decodeRecoveryValue` in
`src/core/recovery-archive-codec.js` specify the encoding. Decoding returns source
in memory and never writes storage. Special field names, including `__proto__`,
remain own data properties. The archive is not accepted by portable backup import.
Restoration needs a schema-compatible recovery workflow and a reviewed destination;
this export does not authorize overwriting a vault or activating a newer schema.

The web API exposes the auto-increment flag, but not the current key-generator
counter. Record keys and index metadata are preserved; this is not a byte-for-byte
browser-profile clone. Future schema-compatible recovery must explicitly handle
subsequent generated keys, especially if higher generated keys were deleted.

## Qualification

Maintained tests cover the pre-repair lazy JS/CSS failures, newer database version
with an unknown indexed object store and binary values, history keys and raw
fallback bytes, namespace exclusion, interrupted reads, denied local reads,
archive-asset failure and queued-open timeout/late connection cleanup. The codec
has independent round-trip tests through actual JSON serialization, including
cycles, binary view sharing, files, sparse arrays and dangerous property names.

This does not prove old-client migration safety or whole-application feature-loader
recovery. Those gates remain separate. No production activation or deployment is
part of this archive checkpoint.

## Platform references

- [IndexedDB object stores, transactions and key generators](https://www.w3.org/TR/IndexedDB/)
- [HTML Web Storage concurrency](https://html.spec.whatwg.org/multipage/webstorage.html)
