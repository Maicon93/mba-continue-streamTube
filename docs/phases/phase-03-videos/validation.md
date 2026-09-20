---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T20:17:49-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T20:16:42-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T20:17:29-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "'extração de duração e metadados' não enumera quais metadados"
    resolved_by: phase-03-videos/TD-13
  - id: AMB-2
    status: resolved
    summary: "'frame do vídeo' para o thumbnail não define timestamp, dimensão nem formato"
    resolved_by: phase-03-videos/TD-06
  - id: MD-1
    status: resolved
    summary: "Persistência dos metadados extraídos (colunas dedicadas vs jsonb) sem TD"
    resolved_by: phase-03-videos/TD-13
  - id: MD-2
    status: resolved
    summary: "Política de autorização dos endpoints de vídeo sem TD"
    resolved_by: phase-03-videos/TD-14
  - id: MD-3
    status: resolved
    summary: "Ciclo de vida dos objetos no storage (uploads abandonados, crescimento) sem TD"
    resolved_by: phase-03-videos/TD-15
  - id: MD-4
    status: resolved
    summary: "Critério de aceitação do arquivo (tipo, extensão, tamanho declarado) sem TD"
    resolved_by: phase-03-videos/TD-16
  - id: DG-1
    status: resolved
    summary: "Não existe caminho de usuário autenticado -> canal dono entregue pela Fase 02"
    resolved_by: phase-03-videos/TD-18
  - id: DG-2
    status: resolved
    summary: "Como as suítes exercitam o worker, que roda em container separado"
    resolved_by: phase-03-videos/TD-17
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

_Re-checked after this cycle's six new TDs. Two pairs were examined specifically because the resolutions touch each other:_

- _TD-14 (every endpoint authenticated, owner-scoped) against TD-08 (delivery via presigned URL): not a contradiction. TD-14 governs who may **obtain** a URL; TD-08's URL, once issued, is bearer-authorized until it expires. That is the trade-off TD-08 already records, bounded by its 15-minute TTL — not a second, conflicting authorization model._
- _TD-16 (delete the stored object when `ffprobe` rejects it) against TD-09 (`failed` keeps `failure_reason`): compatible. The row and its reason survive; only the unusable object is removed._

### Ambiguities

_None._

- AMB-1 and AMB-2 resolved — see `## Resolved Issues`.

### Missing Decisions

_None._

_All nine capability bullets in `## Capability Coverage` map to ≥1 TD. The "decision without TD" sub-type was re-scanned across the eighteen decided TDs; the four gaps found in the prior revision are closed and no new strategic choice surfaced. The HTTP error-format sub-check does not fire: the error contract is inherited from phase-02-auth/TD-07 (`DomainExceptionFilter`), which this phase extends rather than replaces._

### Dependency Gaps

_None._

- DG-1 and DG-2 resolved — see `## Resolved Issues`.

_Re-checked within-phase ordering after the new TDs: draft creation (TD-18 → TD-04) precedes upload (TD-03), which precedes processing (TD-05/TD-06/TD-13), which precedes delivery (TD-08). The ordering is implied by the data each step produces, with no cycle._

### Inherited Constraint Conflicts

_None._

_Previously checked: TD-11's public endpoint value against the inherited Docker-networking convention (not a conflict — the convention governs container-to-container traffic, and TD-11 confines the public value to URLs consumed outside the Docker network); TD-10 against the inherited shared-database / `--runInBand` testing convention (compatible)._

_Newly checked this cycle:_

- _TD-18 adds a method to `ChannelsService`, a module delivered by phase 02. Not a conflict with the inherited Single Responsibility convention — it is the convention's own prescription, since the channels module owns the `Channel` entity. The alternative of reading `channels` from the videos module is what the convention forbids._
- _TD-07's revision (`crypto.randomBytes` in place of `nanoid`) against the inherited strict-TypeScript / CommonJS build: this is the conflict being avoided, not created — `nanoid@6` is ESM-only and the backend emits CommonJS._
- _TD-17 against the inherited "every test command runs inside the `nestjs-api` container": compatible — the processor is instantiated inside the suite, which runs in that container._

### Unresolved Open Questions

_None._

_All eighteen TDs in `## Decisions Index` carry `Status: decided`._

### UI Coverage Gaps

_Not applicable — this phase has no UI scope. `context.md` emits no `## UI Inventory` section, so Check 7 is skipped by rule._

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-13)_ — "extração de duração e metadados" did not enumerate which metadata. TD-13 closes the set: `duration_seconds`, `width`, `height`, `size_bytes` as typed columns; `{ codec_name, bit_rate, avg_frame_rate, format_name }` in a `metadata` `jsonb` column.
- **AMB-2** _(resolved_by phase-03-videos/TD-06)_ — the thumbnail frame was unspecified. A Revisions entry on TD-06 fixes the contract: seek to 10% of the probed duration, one frame, scaled to 1280px wide preserving aspect ratio, JPEG quality 2.
- **MD-1** _(resolved_by phase-03-videos/TD-13)_ — metadata persistence shape had no TD. Decided: hybrid, typed columns for the fields other phases read, `jsonb` for diagnostics.
- **MD-2** _(resolved_by phase-03-videos/TD-14)_ — authorization policy had no TD. Decided: every video endpoint authenticated and owner-scoped in this phase; anonymous access arrives in Fase 05 alongside the visibility rules that give it meaning. Non-owners get `not found`, not `forbidden`.
- **MD-3** _(resolved_by phase-03-videos/TD-15)_ — abandoned uploads had no lifecycle. Decided: a bucket lifecycle rule aborting incomplete multipart uploads after 7 days, applied at bucket bootstrap.
- **MD-4** _(resolved_by phase-03-videos/TD-16)_ — accepted-file policy had no TD. Decided: declare-and-verify — content-type allowlist and size ceiling at initiation, `ffprobe` as the authoritative check in the worker, with the object deleted on rejection.
- **DG-1** _(resolved_by phase-03-videos/TD-18)_ — no path existed from the authenticated user to their channel. Decided: add `findByUserId` to the inherited `ChannelsService`, rather than putting `channelId` in the JWT (which would change a closed phase's auth contract) or querying the `channels` table from the videos module (which the project's Single Responsibility principle forbids).
- **DG-2** _(resolved_by phase-03-videos/TD-17)_ — how the suites exercise a worker that runs in another container was undefined. Decided: instantiate the processor in the test's Nest context, with queue, storage and FFmpeg real. The residual gap (the worker image itself is not asserted on) is recorded in the TD.
