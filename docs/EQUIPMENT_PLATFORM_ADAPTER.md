# Equipment data adapter guidance

Contract: [ECP-1.0 revision 1.0](EQUIPMENT_PLATFORM_CONTRACT.md).
Instruction adoption date: 2026-10-17. This guidance implements no database
adapter, catalog synchronization, ownership transfer or migration.

## Ownership and identity

NoteForge owns its notes, blocks, properties, relationships, views, local storage
and recovery according to its current source and accepted product requirements.
Equipment model/component/port/control IDs and evidence revisions are separate
from NoteForge note/block/record IDs and application instances. Link them through
explicit source mappings; do not replace native IDs or silently deduplicate units
because model names or geometry match.

The equipment publisher owns published runtime definitions. Review databases
support evidence and corrections but do not silently overwrite that publisher.
Define one write owner per field and conflict/revision rules before any transfer.
Keep source claims, scoped owned-unit observations, simulated outcomes and
physical state distinct. Unknown values and unsupported fields remain visible.

## Qualification before database ownership

The [NoteForge 2 roadmap](roadmap/NOTEFORGE_2_ROADMAP.md) owns the broader database
direction. Equipment records are a bounded qualification candidate, not proof of
Notion database parity or permission to migrate important data. Test actual
supported typed properties, relations, rollups/formulas and saved views rather
than inferring compatibility from similar labels or rendered tables.

Define the supported schema subset, IDs, aliases, field types, cardinality,
source/revision mapping and unknown-field preservation. Start with one disposable
record/collection fixture and valid, invalid, unknown, missing and conflicting
cases. Prove import/export/reload preserves identities, relationships, source
scope, history and portable content, then qualify backup/restore and recovery
before changing write ownership. Keep the last valid published catalog usable
when an editor/database is unavailable; expose conflicts and failures explicitly.

## Next proof and handoff

Use existing roadmap/brief and durability workflows for any later adapter code.
No private vault content, coordination links, venue records or credentials belong
in public equipment bundles. Shared geometry, definitions and database records
do not transfer another app's gameplay, cue timing or live-output authority.
Selection/import cannot arm hardware or strengthen an unsupported capability.

At handoff record ECP revision, adapter/source/schema revisions, field owners,
producer/consumer impact, executed fidelity/recovery checks and unresolved proof.
Instruction discovery/loading, database capability, migration readiness and
physical/human acceptance are separate gates. Existing notes, saves and unrelated
editor work are preserved; this instruction adoption claims none of those later
gates complete.
