# Equipment Platform Compatibility Contract
Contract: ECP-1.0
Revision: 1.0
Effective: 2026-10-17
Scope: equipment knowledge, visual assets, rig simulation, learning, planning, show control, games and database adapters.
## Direction
Develop reusable equipment definitions with purpose-specific representations and explicit application adapters. Preserve the owning application's approved behavior, saved data and execution authority. This contract sets compatibility requirements; exact implementation schemas and new integrations remain subject to the owning project's brief and acceptance.
## Shared package
Keep the following separate but linked:
- Equipment model identity, manufacturer/model/variant, definition revision and claim/source references.
- Stable component, port and control IDs, independent of array order, labels, mesh numbering or camera angle.
- Owned-unit identity, modifications and observed condition.
- Detailed inspection assets, optimized game assets and approved drafting symbols.
- Representation units, axes, forward vector, pivot, origin, dimensions, asset hashes and rights/provenance.
- Optional control capability/profile references with exact mode, revision, units, limits and supporting evidence.
- Application instance IDs, per-context connections/settings and explicit source-to-destination mappings.
Use glTF/GLB as the first interchange candidate for compatible geometry. Use versioned JSON for semantic definitions and fixtures, and purpose-made SVG/symbol assets for drafting. Validate the subset actually supported by each consumer. A file-format match does not establish scale, material, component-ID, behavior or rights compatibility. Existing procedural models need an exporter or source-owned factory adapter.
## Ownership and behavior
1. Manufacturer sources and scoped observations support equipment claims. Preserve unknown, reported and inferred values without strengthening them.
2. The owning catalog repository publishes equipment definitions. Editorial/review databases do not silently overwrite published runtime definitions.
3. Each app owns its own show, plot, game, cue, lesson and user state. Share reviewed snapshots and explicit mappings rather than creating an automatic universal show record.
4. Model inspection and camera selection are inert. Simulation changes only through explicit supported actions. Physical state is a separately evidenced dataset.
5. A modeled control does not establish remote controllability. Capability and route mappings need independent evidence.
6. Live output remains with the owning execution runtime, including its arming, exact-route, stop and recovery checks. An import, preview or selection cannot arm or restart it.
7. Game costs, capacity, maintenance, acoustics and balance are application rules. Geometry and equipment specifications do not automatically provide those rules.
8. Preserve schema migrations, saved IDs and unknown fields. Reject incompatible schemas, stale targets and unsupported actions visibly; retain the last valid data where appropriate.
9. Keep private coordination links, machine paths, venue data and secrets out of public/shipped asset bundles and public repository documentation.
10. Engines and authoring tools remain consumer choices. This contract does not mandate a renderer, framework, backend or engine migration.
## Consumer roles
<table header-row="true">
<tr>
<td>Consumer</td>
<td>Shared input</td>
<td>Local responsibility</td>
</tr>
<tr>
<td>Equipment library</td>
<td>Detailed model, facts and component map</td>
<td>Inspection and educational presentation</td>
</tr>
<tr>
<td>Rig trainer</td>
<td>Endpoints, capabilities and scenario</td>
<td>Logical signal state, lesson checks and attempt history</td>
</tr>
<tr>
<td>Production workspace</td>
<td>Equipment/rig snapshot</td>
<td>Its production document and context</td>
</tr>
<tr>
<td>Planning/plot app</td>
<td>Dimensions, symbols, model/profile references</td>
<td>Plot instances, focus, numbering, patch and paperwork</td>
</tr>
<tr>
<td>Show-control app</td>
<td>Supported capability references and explicit route mappings</td>
<td>Timing, media, cue execution and privileged outputs</td>
</tr>
<tr>
<td>Management/native game</td>
<td>Optimized assets and model references</td>
<td>Placement, economy, collision and gameplay</td>
</tr>
<tr>
<td>Review/database app</td>
<td>Definitions, evidence and source mappings</td>
<td>Review, relationships, field ownership and recovery</td>
</tr>
<tr>
<td>PDF/export module</td>
<td>Pinned definition and optional context snapshot</td>
<td>Dated immutable reference output</td>
</tr>
</table>
## Interface and failure contract
- Catalog/asset load: validate schema, revision, hashes and references; report missing or unsupported assets without remapping IDs.
- Selection message: include origin, context, instance, component and revision; reject unknown/stale targets and prevent feedback loops.
- Simulation command: include context, rig revision and typed setting/connection data; distinguish present, absent, unknown and invalid.
- Cross-app transfer: define field write owners, mapping versions and conflict handling; do not drop unsupported data silently.
- Export: pin build, schema, content, asset and context revisions; report failures and retain prior outputs.
- Database adapter: preserve identifiers, relations, unknowns and history; prove round-trip fidelity plus backup/restore before changing write ownership.
## Development gate
Before changing a shared asset, schema or adapter, identify its owner, producers, consumers, reused IDs, units/axes, behavior boundary and compatibility impact in the owning brief. Start with one bounded fixture. Verify valid, invalid and unknown cases plus save/export/reload identity. Exercise relevant accessibility, fallback, performance and existing release checks. Distinguish source checks, executed tests, deployed behavior, human acceptance and physical hardware evidence.
At handoff, record contract version, source revision, adapter role, changed interfaces, verification and exact remaining gaps. Recording or distributing this contract does not prove that an application loaded or implemented it.
