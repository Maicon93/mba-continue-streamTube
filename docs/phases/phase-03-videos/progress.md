# Phase 03 — Progress

Status per Step Implementation. Updated by `implement` as each SI closes with its suite green.

**Legend:** `pending` · `in progress` · `done`

| SI | Title | Status | Tests |
|----|-------|--------|-------|
| SI-03.1 | Dependencies, Configuration Namespaces, and New Compose Services | done | 6 unit (env schema: defaults de storage/queue, chaves obrigatórias) |
| SI-03.2 | Channel Lookup for the Authenticated User | done | 3 integration (`findByUserId`) |
| SI-03.3 | Video Entity and Migration | done | 3 integration (apply/revert + enum replayable) |
| SI-03.4 | Storage Module: Dual Client, Bucket Bootstrap, Key Layout | done | 4 unit (key builder) + 7 integration (MinIO real, range 206) |
| SI-03.5 | Draft Creation and Multipart Upload Initiation | done | coberto por 5 e2e (criação, allowlist, limite, 401) |
| SI-03.6 | Upload Resumption | done | 2 e2e (partes faltantes re-assinadas, completion recusada) |
| SI-03.7 | Processing Queue and Job Contract | done | coberto pelo boot do worker + e2e de enfileiramento |
| SI-03.8 | Upload Completion and Enqueue | done | 2 e2e (sucesso -> processing; incompleto -> 409) |
| SI-03.9 | FFmpeg Wrapper (ffprobe and frame extraction) | done | 8 integration (probe, thumbnail, timeout, arquivo inválido) |
| SI-03.10 | Video Processor | done | 6 integration (MinIO + FFmpeg reais, idempotência, falha, tentativas) |
| SI-03.11 | Worker Container | done | verificado no Compose: worker processou um vídeo ponta a ponta |
| SI-03.12 | Streaming and Download Delivery | done | 3 e2e (302 + 206 com Content-Range, attachment, 404/409) |
| SI-03.13 | End-to-End Flow Test | done | 11 e2e no total em `test/videos.e2e-spec.ts` |
| SI-03.14 | Documentation Update | done | CLAUDE.md (raiz e backend), diagrama sem TBD, openapi.json com 6 rotas |

## Definition of Done

- [x] `docker compose exec nestjs-api npm test -- --runInBand` — **176 passing / 176** (27 suites)
- [x] `docker compose exec nestjs-api npm run test:e2e` — **63 passing / 63** (4 suites)
- [x] `docker compose exec nestjs-api npx tsc --noEmit` — exit 0
- [x] `docker compose exec nestjs-api npm run build` — exit 0
- [x] Lint clean on every file this phase added or touched — exit 0

The repository-wide `npm run lint` still reports the 150 pre-existing errors
recorded in the baseline below. They live in Phase 01/02 files and were left
untouched by explicit decision: this phase's scope is Phase 03, and rewriting
the professor's test files is outside it. Every file added or modified here
lints clean.

## Final state

| | |
|---|---|
| Unit + integration | 176 / 176 (was 144 at baseline) |
| E2E | 63 / 63 (was 52) |
| New Compose services | `minio`, `redis`, `video-worker` — all healthy |
| Endpoints | 6, all in `openapi.json` |
| Verified live | upload from the host straight to MinIO, processing by the **worker container**, `206 Partial Content` on a ranged read, download with `Content-Disposition: attachment` |

## Baseline (before this phase)

Recorded at the start of the phase so regressions are distinguishable from pre-existing state:

- Unit + integration: **144 passing / 144** (23 suites)
- E2E: **52 passing / 52** (3 suites)
- `npx tsc --noEmit`: exit 0
- `npm run lint`: **150 errors** already present in the base repository (144 in the professor's test files, 6 in `channels.service.ts`) — out of this phase's scope by decision; the phase's own files must lint clean.
- One fix was required before starting: `src/database/migrations.integration-spec.ts` dropped the managed tables but not the `verification_tokens_type_enum` type, so the suite passed only against a virgin database and failed on any second run. The `beforeAll` now drops the type as well.
