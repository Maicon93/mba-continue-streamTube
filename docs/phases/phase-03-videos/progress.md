# Phase 03 — Progress

Status per Step Implementation. Updated by `implement` as each SI closes with its suite green.

**Legend:** `pending` · `in progress` · `done`

| SI | Title | Status | Tests |
|----|-------|--------|-------|
| SI-03.1 | Dependencies, Configuration Namespaces, and New Compose Services | done | 6 unit (env schema: storage/queue defaults + required keys) |
| SI-03.2 | Channel Lookup for the Authenticated User | done | 3 integration (`ChannelsService.findByUserId`) |
| SI-03.3 | Video Entity and Migration | done | 3 integration (migration apply/revert + enum replayability) |
| SI-03.4 | Storage Module: Dual Client, Bucket Bootstrap, Key Layout | done | 4 unit (key builder) + 7 integration (MinIO real) |
| SI-03.5 | Draft Creation and Multipart Upload Initiation | in progress | service + controller escritos; e2e em SI-03.13 |
| SI-03.6 | Upload Resumption | in progress | service + controller escritos; e2e em SI-03.13 |
| SI-03.7 | Processing Queue and Job Contract | in progress | queue module + cleanup job escritos |
| SI-03.8 | Upload Completion and Enqueue | in progress | service + controller escritos; e2e em SI-03.13 |
| SI-03.9 | FFmpeg Wrapper (ffprobe and frame extraction) | done | 9 integration (ffprobe, thumbnail, timeout, arquivo inválido) |
| SI-03.10 | Video Processor | done | 6 integration (MinIO + FFmpeg reais, idempotência, falha) |
| SI-03.11 | Worker Container | in progress | entrypoint, módulo e serviço no compose escritos |
| SI-03.12 | Streaming and Download Delivery | in progress | service + controller escritos; e2e em SI-03.13 |
| SI-03.13 | End-to-End Flow Test | pending | — |
| SI-03.14 | Documentation Update | pending | — |

## Definition of Done

- [ ] `docker compose exec nestjs-api npm test -- --runInBand`
- [ ] `docker compose exec nestjs-api npm run test:e2e`
- [ ] `docker compose exec nestjs-api npx tsc --noEmit` (exit 0)
- [ ] `docker compose exec nestjs-api npm run lint`

## Baseline (before this phase)

Recorded at the start of the phase so regressions are distinguishable from pre-existing state:

- Unit + integration: **144 passing / 144** (23 suites)
- E2E: **52 passing / 52** (3 suites)
- `npx tsc --noEmit`: exit 0
- `npm run lint`: **150 errors** already present in the base repository (144 in the professor's test files, 6 in `channels.service.ts`) — out of this phase's scope by decision; the phase's own files must lint clean.
- One fix was required before starting: `src/database/migrations.integration-spec.ts` dropped the managed tables but not the `verification_tokens_type_enum` type, so the suite passed only against a virgin database and failed on any second run. The `beforeAll` now drops the type as well.
