# AGENTS.md

## Workspace contract

Read `~/Code/ops-hub/90-governance/WORKSPACE_OPERATING_RULES.md` before project rules, including COMMS (one entry on the shared Agent Communications Page per session).

## Equipment compatibility

For equipment records, catalog/database interchange or cross-product mappings,
read the pinned [ECP-1.0 contract](docs/EQUIPMENT_PLATFORM_CONTRACT.md) and
[NoteForge data adapter guidance](docs/EQUIPMENT_PLATFORM_ADAPTER.md).
Preserve native identities, unknowns, field ownership, portable content and
recovery. Instruction adoption does not authorize synchronization or migration.

## Status naming

Name work with one string everywhere (chat status title, session title, Notion
Status Check Runs "Human Name"):

`Project | 🚦 | Phase | Title → state, reason | MM-DD`

- 🚦: 🟢 complete and verified · 🟡 partial · 🔴 not started, blocked or failed · ⚪ unverifiable.
  Add ⏳ scheduled, 🙋 awaiting Dave or 🚧 blocked to 🟡/🔴/⚪, never to 🟢.
- Phase: Research, Design, Build, Audit or Scheduled. MM-DD: date of the latest light change.
- Every light change gets a new name: a `RENAME:` line in chat and the Notion row updated.
- Canonical source: https://github.com/DaveHomeAssist/skills/blob/master/status-naming.md
