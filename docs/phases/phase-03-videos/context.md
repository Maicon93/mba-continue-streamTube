---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T15:15:19-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T20:16:42-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-20T15:19:34-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-20T15:19:34-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T20:17:29-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-20T15:19:34-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição das informações do vídeo, categorias, visibilidade público/unlisted, fluxo de publicação e painel de gerenciamento do canal (Fase 04); página de visualização, player e acesso anônimo (Fase 05); interações sociais (Fase 06). Nenhuma superfície de UI pertence a esta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (upload, player, painel) entra nas Fases 04–05. Esta fase entrega apenas a API, o worker e a infraestrutura.

**Sequencing notes:** Depends on Fase 01 (configuração base) and Fase 02 (autenticação, usuários e canais). O vídeo pertence a um canal, e o canal já existe desde a Fase 02 (relação 1:1 com o usuário, criada no cadastro).

**Additional constraints** (literal, `docs/project-plan.md` § Pontos de Atenção):

- **Upload de arquivos grandes:** o upload de até 10GB precisa ser feito de forma que não trave o sistema e permita retomar em caso de falha de conexão.
- **Processamento de vídeos:** a extração de informações do vídeo é pesada e deve acontecer em segundo plano, sem bloquear o usuário.
- **URLs únicas:** cada vídeo precisa de uma URL curta e única que nunca conflite com outro vídeo.
- **Armazenamento:** vídeos grandes consomem muito espaço. É importante planejar o crescimento e os custos de armazenamento desde o início.
- **Streaming:** o vídeo deve começar a ser reproduzido sem que o usuário precise baixar o arquivo inteiro.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta** (prior): entrega `users/`, `channels/`, `auth/`, `mail/`, o guard JWT global, o filtro de exceções de domínio e o `ValidationPipe` global. O vídeo se liga ao canal criado ali.
- **Fase 04 — Gerenciamento de Vídeos e Canal** (next): edição de título/descrição/categoria/thumbnail customizada, visibilidade e fluxo rascunho → publicação. O modelo de dados desta fase precisa comportar essas colunas sem migration destrutiva.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue Technology | decided | A (BullMQ + Redis) | bullmq@^5.81.5, @nestjs/bullmq@^11.0.5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client and Key Layout | decided | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) | @aws-sdk/client-s3@^3.1136.0, @aws-sdk/s3-request-presigner@^3.1136.0 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Protocol for 10GB Files | decided | A (Presigned multipart upload direct to storage) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Upload Completion Handshake | decided | A (Client-driven completion endpoint) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Worker Topology | decided | A (Separate container, same codebase, dedicated entrypoint) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Invocation | decided | B (Direct `child_process.spawn` of `ffprobe`/`ffmpeg`) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL | decided | B (Separate short public id, `crypto.randomBytes`) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Delivery | decided | B (Presigned `GET` URL, client streams directly from storage) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Processing Failure | decided | A (Four states — `draft` → `processing` → `ready` \| `failed`) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Test Strategy for Storage and Queue | decided | A (Reuse the Compose services, isolated by prefix) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Endpoint Used to Sign URLs (Internal vs Public) | decided | A (Two configured endpoints) | — |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Cross-layer | Resumable Upload After a Connection Failure | decided | A (Persist only the `uploadId`) | — |
| phase-03-videos/TD-13 | technical-decisions-phase-03-videos.md | Backend | Persisted Video Metadata Shape | decided | C (Hybrid — typed columns + `jsonb`) | — |
| phase-03-videos/TD-14 | technical-decisions-phase-03-videos.md | Backend | Authorization Policy for the Video Endpoints | decided | A (Authenticated and owner-scoped) | — |
| phase-03-videos/TD-15 | technical-decisions-phase-03-videos.md | Backend | Abandoned Uploads and Object Lifecycle | superseded-by phase-03-videos/TD-19 | ~~A~~ | — |
| phase-03-videos/TD-19 | technical-decisions-phase-03-videos.md | Backend | Abandoned Upload Cleanup (supersedes TD-15) | decided | A (Repeatable job on the existing queue) | bullmq@^5.81.5 |
| phase-03-videos/TD-16 | technical-decisions-phase-03-videos.md | Backend | Accepted File Policy | decided | A (Declare-and-verify) | — |
| phase-03-videos/TD-17 | technical-decisions-phase-03-videos.md | Backend | How the Test Suites Exercise the Worker | decided | A (Processor in the test context) | — |
| phase-03-videos/TD-18 | technical-decisions-phase-03-videos.md | Backend | Resolving the Owning Channel of the Authenticated User | decided | A (`ChannelsService.findByUserId`) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

_Libraries pinned by `plan-resolve`; per-library documentation excerpts are cached in `library-refs.md`._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-19 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05, phase-03-videos/TD-10, phase-03-videos/TD-17 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-16 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-09, phase-03-videos/TD-14, phase-03-videos/TD-18 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-13, phase-03-videos/TD-17 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-17 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-11, phase-03-videos/TD-14 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-11, phase-03-videos/TD-14 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — it is the only option whose retry/backoff/failed-job semantics come for free, and TD-09 depends on exactly those. The official `@nestjs/bullmq` integration keeps the worker inside the project's DI and testing conventions instead of introducing a second programming model, and one Redis container is a smaller operational addition than a broker for a single job type.

**Note:** Redis is added to `nestjs-project/compose.yaml` as a first-class service (`redis`), reached by API and worker at host `redis`.

**Libraries:** `bullmq@^5.81.5`, `@nestjs/bullmq@^11.0.5`

### phase-03-videos/TD-02

**Recommendation:** `@aws-sdk/client-s3` — the project's stated intent is MinIO locally and S3 in production, so the client that treats both identically makes that swap a `.env` edit. It also covers presigned multipart (TD-03) and presigned GET with content disposition (TD-08) natively.

**Key layout (contract):** single private bucket; `videos/{videoId}/source{ext}` written by the client via presigned multipart, `videos/{videoId}/thumbnail.jpg` written by the worker. Keyed by the video's internal UUID — not by the public id of TD-07, not by filename.

**Note:** the object storage is **MinIO** running as a Compose service. `@aws-sdk/client-s3` is the client for the S3 *protocol*, which MinIO implements; no AWS service or account is involved.

**Libraries:** `@aws-sdk/client-s3@^3.1136.0`, `@aws-sdk/s3-request-presigner@^3.1136.0`

### phase-03-videos/TD-03

**Recommendation:** Presigned multipart upload direct to storage — a single presigned `PUT` is disqualified by the 5GB single-object ceiling before any other consideration, and tus reintroduces the API bottleneck the requirement exists to remove.

**Contract:** part size 10MB (configurable), presigned part URLs expire in 1h, maximum accepted file size 10GB validated at initiation from the client-declared size.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Client-driven completion endpoint — the storage-notification alternative adds an environment-specific event pipeline (MinIO notifications locally, SNS/SQS/EventBridge on real S3) that must be reproduced in CI and is substantially harder to exercise in e2e tests.

**Contract:** `POST /videos/:id/upload/complete` — the API sources the authoritative part list from `ListParts`, not from the request body, then calls `CompleteMultipartUpload`, flips status to `processing` and enqueues the job.

**Known limitation:** the processing trigger depends on a client call. A client that uploads every part and disappears leaves the video in `draft`; TD-12 makes that state recoverable.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Separate container, same codebase, dedicated entrypoint — the only option that both honors the architecture diagram's separate worker container and keeps a single definition of the video entity.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Direct `child_process.spawn` of `ffprobe`/`ffmpeg` — the required surface is two commands, below the threshold where a wrapper earns an unmaintained dependency with second-party typings. Parsing `ffprobe`'s JSON into a project-owned interface fits the strict-TypeScript policy, and explicit exit-code handling is what makes TD-09's failure path reliable.

**Note:** both spawns run under an explicit timeout and are killed on expiry.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Separate short public id (12 chars) with a unique index — the only option satisfying both this phase's uniqueness requirement and Fase 04's unlisted visibility, while leaving the internal UUID free to serve as the storage-key and foreign-key identity of TD-02.

**Revision (2026-09-20):** generated with `crypto.randomBytes` over an explicit 64-char URL-safe alphabet instead of the `nanoid` package — `nanoid@6` is ESM-only and the backend compiles to CommonJS. Same output shape, no new dependency.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Presigned `GET` URL, client streams directly from storage — the only option consistent with both the phase's performance premise and the architecture diagram, and it gets correct `206`/`Content-Range` behavior from the storage layer rather than from hand-written stream plumbing.

**Contract:** presigned GET with a 15-minute TTL; download is the same mechanism with `ResponseContentDisposition: attachment`.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Four states — `draft` → `processing` → `ready` | `failed`. Covers every capability bullet and every condition the phase can actually observe.

**Failure policy:** 3 attempts with exponential backoff. Retries are transparent (the video stays `processing` while attempts remain); only on exhaustion does the worker set `failed` and persist `failure_reason`. The handler is idempotent, required by BullMQ's at-least-once delivery.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Reuse the Compose services, isolated by prefix — the project's established pattern is testing against real Compose infrastructure, and the test command runs inside a container without a Docker socket, which makes Testcontainers a structural change rather than a test-strategy choice.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Two configured endpoints — `S3_ENDPOINT` (internal, `http://minio:9000`) for every server-side call; `S3_PUBLIC_ENDPOINT` used only when signing URLs that leave the backend. SigV4 signs the `Host` header, so one endpoint value cannot serve both the containers and a browser outside the Docker network. Tests set `S3_PUBLIC_ENDPOINT` to the internal value so signed URLs are reachable from inside the container where the suite runs.

**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Persist only the `uploadId`; `ListParts` is the source of truth — resumption must reflect what the storage actually holds, and a mirrored parts table is authoritative only until the moment it stops being correct.

**Contract:** `GET /videos/:id/upload` returns the parts already stored plus signed URLs for the remaining ones; an abandoned upload is aborted with `AbortMultipartUpload` when the draft is deleted.

**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** Hybrid — the split follows consumption rather than taste: duration and resolution are read by Fase 04's panel and Fase 05's player, so they are columns; codec and bitrate are never displayed, so they are payload.

**Contract:** columns `duration_seconds` (int), `width`, `height` (int), `size_bytes` (bigint); `metadata` (`jsonb`) holds exactly `{ codec_name, bit_rate, avg_frame_rate, format_name }`. All nullable until processing succeeds, written in a single update together with the `ready` status of TD-09.

**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** Everything authenticated and owner-scoped in this phase — the objects this phase creates have no visibility attribute (Fase 04) and no anonymous-access capability (Fase 05), so there is no coherent definition of "public" available to it.

**Contract:** every video endpoint requires authentication; the acting user's channel (resolved per TD-18) must own the video, otherwise the request is rejected as **not found** rather than forbidden, so ownership is not probeable by enumeration.

**Libraries:** —

### phase-03-videos/TD-19

_(supersedes `phase-03-videos/TD-15`, whose premise — that the storage implements abandoned-multipart cleanup natively — does not hold for MinIO: its S3-compatibility documentation states the `AbortIncompleteMultipartUpload` lifecycle action is not supported via `PutBucketLifecycle`, confirmed against `RELEASE.2025-09-07T16-13-09Z`.)_

**Recommendation:** Repeatable job on the existing queue — the queue is already part of this phase, so the marginal cost is a handler rather than a component, and it is the only option that behaves the same on MinIO and on real S3.

**Contract:** a repeatable job `abandoned-upload-cleanup` runs every 24h, lists multipart uploads under the bucket and aborts those older than `UPLOAD_ABORT_AFTER_DAYS` (default 7). TD-12's explicit-deletion path is unchanged.

**Libraries:** `bullmq@^5.81.5`

### phase-03-videos/TD-16

**Recommendation:** Declare-and-verify — each check is placed where it can actually be enforced: the cheap claims at initiation, the authoritative decode in the worker. A signed `Content-Type` constrains the header, not the bytes.

**Contract:** allowlist `video/mp4`, `video/webm`, `video/quicktime` at initiation; declared size `> 0` and `<= 10GB`; declared content type signed into `CreateMultipartUpload`. In the worker, a failed `ffprobe` or the absence of a video stream sets `failed` with `failure_reason` and deletes the stored object.

**Libraries:** —

### phase-03-videos/TD-17

**Recommendation:** Instantiate the processor in the test's Nest context — keeps everything TD-10 requires real (queue, storage, FFmpeg) while removing the one thing that makes asynchronous tests unreliable, which is waiting on another process without a completion signal.

**Known gap:** the worker **image** (Dockerfile, entrypoint, FFmpeg install) is not covered by an assertion; it is verified by the container starting and consuming in the Compose stack.

**Libraries:** —

### phase-03-videos/TD-18

**Recommendation:** Add `findByUserId` to the inherited `ChannelsService` — the lookup belongs to the module that owns the entity, and that module already exports `ChannelsService` and `TypeOrmModule`. Putting `channelId` in the JWT would change a closed phase's auth contract and invalidate issued tokens; querying the `channels` table from the videos module violates the project's stated Single Responsibility principle.

**Note:** this closes DG-1 — the delivered code has no path from the authenticated user (`{ sub, email }`) to their channel.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** A (`@nestjs/config`) — configuration module for the NestJS app.

**Libraries:** `@nestjs/config`

### phase-01-configuracao-base/TD-02

**Recommendation:** A (Joi) — environment variables are validated by a Joi schema. Every new env var of this phase (storage, queue, upload limits) must be added there.

**Libraries:** `joi`

### phase-01-configuracao-base/TD-03

**Recommendation:** B (Namespaced with `registerAs`) — one config factory file per domain in `src/config/`, injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`.

**Libraries:** `@nestjs/config`

### phase-01-configuracao-base/TD-04

**Recommendation:** A (Shared `registerAs` factory) — the same factory is importable as a plain function for non-DI contexts, e.g. the TypeORM CLI data source.

**Libraries:** `typeorm`

### phase-02-auth/TD-02

**Recommendation:** B (Custom guards with `@nestjs/jwt` only) — `JwtAuthGuard` is registered as a global `APP_GUARD`. Every endpoint is authenticated unless explicitly marked with the `@Public()` decorator.

**Libraries:** `@nestjs/jwt`

### phase-02-auth/TD-06

**Recommendation:** A (`class-validator` + `class-transformer`) — request DTOs are validated by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`). New DTOs in this phase follow the same shape.

**Libraries:** `class-validator`, `class-transformer`

### phase-02-auth/TD-07

**Recommendation:** A (Custom Domain Exception Filter) — domain errors are thrown as `DomainException` subclasses and rendered by `DomainExceptionFilter` into the project's error envelope. The phase's Error Catalog must extend this, not introduce a parallel error shape.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** A (`@nestjs/throttler`) — `ThrottlerGuard` is registered as a global `APP_GUARD` (60s / 10 requests). Upload-initiation and presign endpoints inherit it by default.

**Libraries:** `@nestjs/throttler`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`, loaded in `AppModule` via `ConfigModule.forRoot({ isGlobal: true, load: [...] })`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, with `validationOptions: { allowUnknown: true, abortEarly: false }`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true` and `synchronize: false` — schema changes only via versioned migrations in `src/database/migrations/`. _(from phase 01)_
- Each domain feature is its own module directory under `src/` with `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/`, registered in `AppModule`. _(from phase 02)_
- Business logic lives exclusively in services; controllers are thin and delegate. Entities are accessed through TypeORM repositories injected with `@InjectRepository(Entity)` and `TypeOrmModule.forFeature([...])` in the owning module. _(from phase 02)_
- Domain errors are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`, rendered by the global `DomainExceptionFilter`; validation errors by `ValidationExceptionFilter`. _(from phase 02)_
- `JwtAuthGuard` is a global `APP_GUARD` — endpoints are authenticated by default; anonymous access requires the `@Public()` decorator. The authenticated user is read via the `@CurrentUser()` decorator. _(from phase 02)_
- Endpoints are documented for OpenAPI via `@nestjs/swagger` decorators; `openapi.json` is exported by `npm run openapi:export`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit, all collaborators mocked), `*.integration-spec.ts` (real DB/services, next to the source), `*.e2e-spec.ts` (full HTTP via supertest, in `test/`). Integration and e2e share one database and run with `--runInBand`. _(from phase 02)_
- Every `npm`, `npx`, `node`, `tsc` and test command runs inside the container (`docker compose exec nestjs-api ...`), never on the host. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não estava inicializado naquela fase; as telas foram entregues depois em `phase-02-auth-frontend`. |

## Non-UI / Deferred Capabilities

_None._

_Every capability of this phase is backend-side. The phase has no UI bullet, so no screen inventory applies._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the first external infrastructure dependencies beyond the database (object storage and queue) and the first process that is not the API (the video worker), so the pyramid extends as follows:

- **Unit (`*.spec.ts`):** key builders, `ffprobe` output parsing, part-size/limit validation, status transitions, public-id generation — collaborators mocked.
- **Integration (`*.integration-spec.ts`):** against the real MinIO and Redis of the Compose stack per TD-10 — presign/upload/complete round-trip, `ListParts` resumption, job enqueue and worker processing writing duration, metadata and thumbnail back. Bucket and queue names carry a per-suite prefix; cleanup in `afterAll`.
- **E2E (`*.e2e-spec.ts`):** the full HTTP flow via supertest — create draft → obtain presigned part URLs → upload a small fixture video → complete → wait for `ready` → assert duration, thumbnail key and the unique public URL → request streaming and download URLs. Per TD-11, the suite runs inside the `nestjs-api` container with `S3_PUBLIC_ENDPOINT` pointing at the internal host so signed URLs are reachable from where the test runs.
- **Do not mock** storage, queue or FFmpeg at the integration/e2e level — the phase's acceptance criteria require them to be real services in Compose, exercised by the tests.

Specific layer coverage by SI is recorded in `progress.md`.
