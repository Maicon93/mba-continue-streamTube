---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-20
scope_description: "Backend foundation for video upload and processing: object storage client and key layout, queue technology, 10GB upload protocol, upload-completion handshake, upload resumption, presigned-URL endpoint configuration, video worker topology, FFmpeg invocation, unique public URL, streaming/download delivery, video status lifecycle, and the testing strategy against real storage and queue infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers every capability of this phase: the videos module, the object-storage integration, the processing queue, the FFmpeg worker, and the streaming/download endpoints. Also owns the new Compose services (storage, queue, worker).
- `next-frontend/` — no open decision in this document. Phase 03 has no UI capability bullet; the video interface is introduced in Fases 04–05. The two `Cross-layer` TDs below (TD-03 upload protocol, TD-08 delivery) define contracts the frontend will consume later, but nothing is implemented in `next-frontend/` in this phase.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) declares the Message Queue container as `TBD` — this is the only genuinely open stack choice of the phase. The API publishes one job type (`process-video`) and a separate worker container consumes it. The choice determines a new Compose service, the client library on both API and worker, and the retry/failure semantics that TD-09's status lifecycle depends on.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with an official NestJS integration. The API injects a `Queue` and calls `add()`; the worker extends `WorkerHost` and implements `process()`. Retries, exponential backoff, concurrency and failed-job retention are queue options, not application code.
- **Pros:** Official NestJS package (`@nestjs/bullmq` 12.x) with DI-native `@Processor`/`WorkerHost`. Retry + exponential backoff + dead-letter retention built in — exactly what TD-09's `failed` state needs. One extra Compose service (Redis). Job payloads are typed TypeScript objects, no manual serialization contract.
- **Cons:** Adds Redis to a stack that currently has none. At-least-once delivery — the processing handler must be idempotent. Not a general-purpose broker (no routing/fanout) if future phases need pub/sub.

### Option B: RabbitMQ + `@nestjs/microservices`
- A real AMQP broker. The API acts as a client emitting an event; the worker runs as a NestJS microservice with an `@EventPattern` handler and manual ack.
- **Pros:** Proper broker semantics — durable queues, explicit ack/nack, routing and fanout available for later phases. Transport is part of the NestJS core packages.
- **Cons:** Heavier operationally (broker + management plane) for a single job type. No built-in retry/backoff policy — redelivery, retry counting and a dead-letter exchange must be wired by hand, which is precisely the machinery TD-09 needs. Larger container and slower cold start in the dev Compose stack.

### Option C: pg-boss (queue on the existing PostgreSQL)
- Job queue implemented as tables in the PostgreSQL instance already in the stack. Workers poll with `SKIP LOCKED`.
- **Pros:** No new infrastructure at all. Job enqueue can share a transaction with the video row insert, giving exactly-once enqueue semantics for free.
- **Cons:** Puts background-job churn on the same database that serves API reads. Polling-based, so latency is a tuning knob rather than a push. No NestJS-native integration — module wiring, worker lifecycle and typing are hand-rolled. Contradicts the architecture diagram, which models the queue as a container distinct from the database.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option whose retry/backoff/failed-job semantics come for free, and TD-09 depends on exactly those. The official `@nestjs/bullmq` integration keeps the worker inside the project's DI and testing conventions instead of introducing a second programming model, and one Redis container is a smaller operational addition than a broker for a single job type. Option C's transactional enqueue is attractive, but loading the API's database with job polling contradicts the "não impactar a performance" constraint that motivates the whole phase.

**Decision:** A (BullMQ + Redis)

**Note:** Redis is added to `nestjs-project/compose.yaml` as a first-class service (`redis`), reached by the API and the worker at host `redis` per the project's Docker networking rule. The phase's acceptance criteria require queue, storage and worker to be real services in Compose.

**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Object Storage Client and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is not open — the architecture fixes S3-compatible storage, run locally as MinIO. What is open is which client library the API and worker use, and how objects are organized. The client choice determines whether moving from MinIO to real S3 in production is a config change or a rewrite; the key layout is a cross-component contract (API writes the source object, worker reads it and writes the thumbnail, delivery endpoints sign URLs for both).

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- The official AWS SDK v3, pointed at MinIO via `endpoint` + `forcePathStyle: true`. Same code path for MinIO locally and S3 in production — only env vars change.
- **Pros:** Vendor-neutral: the whole point of MinIO is S3 API compatibility, and this is that API. `s3-request-presigner` covers every presigned URL the phase needs (multipart part uploads in TD-03, GET delivery in TD-08) including `ResponseContentDisposition` for the download case. Modular packages — only `client-s3` is pulled in, not a monolithic SDK.
- **Cons:** Larger dependency surface than a minimal client. Requires `forcePathStyle` and an explicit endpoint for MinIO, a well-known but easy-to-miss configuration detail.

### Option B: `minio` JavaScript SDK
- MinIO's own client, with helpers like `presignedPutObject` and `presignedGetObject`.
- **Pros:** Smaller and more ergonomic API for the common operations. Presigned helpers are one-liners.
- **Cons:** Couples application code to the MinIO client for a project that explicitly plans to swap in S3. Multipart presigning is less directly exposed than in the AWS SDK. Would make the production migration a code change rather than a configuration change.

**Recommendation:** **Option A (`@aws-sdk/client-s3`)** — the project's stated intent is MinIO locally and S3 in production, so the client that treats both identically is the one that makes that swap a `.env` edit. It also covers presigned multipart (TD-03) and presigned GET with content disposition (TD-08) natively, which are the two hardest requirements of the phase.

**Key layout** (the cross-component contract this TD fixes): a single private bucket, name from env (`streamtube-videos` in dev), with per-video prefixes:

```
videos/{videoId}/source{ext}       ← uploaded by the client via presigned multipart
videos/{videoId}/thumbnail.jpg     ← written by the worker
```

Keying by the video's internal UUID (not by the public URL id of TD-07, and not by filename) keeps object keys stable across title edits in Fase 04 and avoids any user-controlled string in a storage path.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)

**Note:** the object storage of this project is **MinIO**, running as a Compose service — no AWS service is involved and no AWS account is required. `@aws-sdk/client-s3` is the client library for the S3 *protocol*, which MinIO implements; it is configured against `http://minio:9000` with `forcePathStyle: true`. Moving to real S3 in production is an `.env` change (endpoint + credentials), not a code change — which is exactly the arrangement the phase brief describes.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Protocol for 10GB Files

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** This is the defining constraint of the phase. The bytes must not pass through the NestJS API — an Express process holding a 10GB request body blocks a worker, consumes disk or memory, and makes the "sem impacto na performance" requirement unachievable. The protocol chosen here is a handshake spanning client and server, which is why it is `Cross-layer`: the frontend implements the part-upload loop in a later phase against the contract fixed here.

**Options:**

### Option A: Presigned multipart upload direct to storage
- The API calls `CreateMultipartUpload`, returns an `uploadId` plus a presigned `UploadPart` URL per part. The client `PUT`s each part straight to MinIO/S3 and collects the `ETag`s; the API then calls `CompleteMultipartUpload` (see TD-04).
- **Pros:** Not a single video byte touches the API — it only ever handles small JSON. Parts upload in parallel and a failed part is retried individually, which is the difference between a usable and an unusable 10GB upload. Works identically on MinIO and S3. Part size is a tuning knob (10MB parts → 1000 parts for 10GB, well under the 10000-part ceiling).
- **Cons:** Most complex client implementation of the three — the client must slice the file, track part numbers and ETags, and drive the completion call. Abandoned uploads leave orphan parts, requiring a lifecycle rule or a cleanup job.

### Option B: Presigned single `PUT` (`PutObject`)
- The API returns one presigned URL; the client uploads the whole file in a single request directly to storage.
- **Pros:** Trivial on both sides — one URL, one `PUT`. Bytes still bypass the API.
- **Cons:** S3 caps a single `PutObject` at 5GB, so it cannot satisfy a 10GB requirement at all. No resumability: a connection drop at 90% restarts from zero, which on a multi-gigabyte file is a near-certain failure mode.

### Option C: tus resumable upload protocol (`@tus/server`)
- A standardized resumable-upload protocol served by a tus endpoint, with the file assembled server-side and then moved to storage.
- **Pros:** Open standard with mature clients (Uppy). Resumable by design, with fine-grained offset control.
- **Cons:** The bytes flow through a Node process — exactly what the phase requires avoiding — unless an S3 store plugin is added, at which point it is Option A with an extra protocol layer. Introduces a second HTTP surface to deploy, secure and test alongside the Nest API.

**Recommendation:** **Option A (presigned multipart)** — Option B is disqualified by the 5GB single-object-`PUT` ceiling before any other consideration, and Option C reintroduces the bottleneck the requirement exists to remove. Multipart is also what the AWS SDK chosen in TD-02 supports natively, so the added client complexity is the only real cost and it is paid once.

**Contract fixed by this decision:** part size 10MB (configurable), presigned part URLs expire in 1h, maximum accepted file size 10GB validated at initiation time from the client-declared size.

**Decision:** A (Presigned multipart upload direct to storage)

---

## TD-04: Upload Completion Handshake

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** With TD-03's direct-to-storage upload, the API does not observe the transfer and therefore does not know when the object is complete. Something must trigger `CompleteMultipartUpload` and the enqueue of the processing job. This is what connects the pre-registered draft to the processing pipeline.

**Options:**

### Option A: Client-driven completion endpoint
- The client, having uploaded every part, calls `POST /videos/:id/upload/complete`. The API calls `ListParts` against the storage to obtain the authoritative part numbers and ETags, calls `CompleteMultipartUpload` with them, flips the status to `processing` and enqueues the job.
- **Pros:** Deterministic and synchronous — the API knows the exact moment the object became complete and returns a meaningful error if it did not. Fully testable with supertest against real MinIO, no event plumbing. Identical behavior on MinIO and S3. Sourcing the part list from `ListParts` rather than from the request body keeps untrusted client input out of the completion call and is the same primitive TD-12 uses for resumption.
- **Cons:** A client that uploads all parts and then disappears leaves the video stuck in `draft` with orphan parts — needs an expiry/cleanup policy.

### Option B: Storage bucket notification → webhook
- MinIO/S3 emits an `s3:ObjectCreated:CompleteMultipartUpload` event to a webhook endpoint on the API, which then enqueues the job.
- **Pros:** Robust to a client that vanishes after the last part — completion is observed at the storage layer. Fewer API calls in the happy path.
- **Cons:** MinIO event configuration is environment setup that must be reproduced in CI and in production S3 (where it means SNS/SQS/EventBridge, a different mechanism). The webhook must be reachable and authenticated. Still requires the client to call `CompleteMultipartUpload` itself with the ETags, so it does not actually remove the client's responsibility — it only moves where the job is enqueued from. Substantially harder to exercise in e2e tests.

**Recommendation:** **Option A (client-driven completion endpoint)** — Option B adds an environment-specific event pipeline (MinIO notifications locally, SNS/SQS/EventBridge on real S3) that must be reproduced in CI, and it is substantially harder to exercise in e2e tests. Option A keeps the whole flow inside supertest's reach, which matters for the phase's "test against real infrastructure" requirement.

**Known limitation:** the processing job is triggered by a client call, so a client that uploads every part and then disappears leaves the video in `draft` with no trigger. This is bounded by TD-12, which makes the upload resumable and exposes the real server-side state, so such a video can be completed on a later attempt rather than being lost.

**Decision:** A (Client-driven completion endpoint)

---

## TD-05: Video Worker Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The architecture diagram models the Video Worker as a container distinct from the API. FFmpeg is CPU-bound and long-running; how the worker is packaged determines whether it can reuse the project's entities, config and repositories, and how much duplication the repository carries.

**Options:**

### Option A: Separate container, same codebase, dedicated entrypoint
- A second Compose service built from the same `nestjs-project` image, started with a different command that boots a Nest application context containing only the worker module (`main.worker.ts`), with FFmpeg installed in the image.
- **Pros:** Reuses entities, TypeORM data source, config validation and repositories verbatim — no duplicated data model between the process that writes `processing` and the one that writes `ready`. One build, one dependency manifest, one lint and test configuration. Isolates FFmpeg's CPU usage from the API's event loop, satisfying the diagram. Worker logic stays unit-testable with the project's existing Nest testing conventions.
- **Cons:** The image carries the API's dependencies plus FFmpeg, making it larger than a purpose-built worker image. Requires the entrypoint to build a minimal module graph so the worker does not also start an HTTP listener.

### Option B: Standalone Node project (`video-worker/`)
- A separate package with its own `package.json`, its own storage client and its own DB access.
- **Pros:** Minimal image, no unused dependencies, fully independent deployment and scaling story.
- **Cons:** Duplicates entity definitions, config schema and DB connection logic across two packages — the video table's shape would live in two places, and drift between them is a silent data bug. Adds a second lint/test/tsc pipeline that the phase's Definition of Done must also cover. Disproportionate for one job handler.

### Option C: In-process worker inside the API container
- The BullMQ worker runs inside the same Nest application as the API.
- **Pros:** Zero new services; simplest possible wiring.
- **Cons:** FFmpeg transcoding competes with HTTP request handling on the same CPU and event loop, which is the performance problem the phase exists to avoid. Contradicts the architecture diagram's explicit worker container. Cannot be scaled independently of the API.

**Recommendation:** **Option A (separate container, shared codebase)** — it is the only option that both honors the diagram's separate worker container and keeps a single definition of the video entity. Option B's independence is not worth two copies of the data model at this size, and Option C reintroduces the CPU contention the phase is meant to eliminate.

**Decision:** A (Separate container, same codebase, dedicated entrypoint)

---

## TD-06: FFmpeg Invocation

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The worker needs exactly two operations: read duration and stream metadata (`ffprobe`), and extract one frame as a JPEG (`ffmpeg`). How these binaries are driven affects typing, error handling and the project's dependency surface.

**Options:**

### Option A: `fluent-ffmpeg`
- A fluent wrapper over the FFmpeg CLI, with `ffmpeg.ffprobe()` returning parsed metadata and `.screenshots({ timestamps, filename, folder, size })` for frame extraction.
- **Pros:** Ergonomic — thumbnail extraction is a single declarative call, and ffprobe output arrives already parsed into a `streams`/`format` object. Widely used, plenty of examples.
- **Cons:** Version 2.1.3 with a slow maintenance cadence; typings live in a separate `@types/fluent-ffmpeg` package that lags the runtime. Callback-based API that must be promisified at every call site, sitting awkwardly in a codebase that is `async/await` throughout. The library's own docs flag that `screenshots()` does not work on input streams and interacts badly with filters.

### Option B: Direct `child_process.spawn` of `ffprobe` and `ffmpeg`
- The worker spawns `ffprobe -v quiet -print_format json -show_format -show_streams <file>` and parses the JSON, then `ffmpeg -ss <t> -i <file> -frames:v 1 -vf scale=... <out.jpg>`.
- **Pros:** No dependency at all — the binaries are already required in the image for either option. Output is JSON parsed into a project-owned, strictly-typed interface rather than a third-party `any`-heavy typing. Native promise wrapper, consistent with the codebase. Full control over arguments, including `-ss` before `-i` for fast seeking on large files. Exit code and stderr are handled explicitly, which the `failed` status in TD-09 depends on.
- **Cons:** Argument strings are written by hand, so a malformed command is caught only at runtime. Two small utilities to write and unit-test that the library would otherwise provide.

**Recommendation:** **Option B (direct `spawn`)** — the required surface is two commands, which is far below the threshold where a wrapper earns an unmaintained dependency with second-party typings. Parsing `ffprobe`'s JSON into a project-owned interface fits the codebase's strict-TypeScript policy better than `@types/fluent-ffmpeg`, and explicit exit-code handling is what makes the processing-failure path in TD-09 reliable rather than best-effort.

**Decision:** B (Direct `child_process.spawn` of `ffprobe`/`ffmpeg`)

**Note:** both spawns run under an explicit timeout and are killed on expiry. Without it a malformed or adversarial input can hang the process indefinitely, silently consuming one of the three attempts of TD-09 without ever failing.

**Revisions:**
- 2026-09-20 — Thumbnail extraction parameters fixed as a contract: seek to **10% of the probed duration** (`-ss` placed before `-i` for fast seek), single frame (`-frames:v 1`), scaled to **1280px wide preserving aspect ratio** (`-vf scale=1280:-2`), written as **JPEG** quality 2. Rationale: the capability says "a partir de um frame do vídeo" without naming the frame, which left two implementations free to produce different thumbnails and left no assertable value for a test (`validation.md` AMB-2). 10% avoids the black or logo frame common at second zero without needing scene detection; `-2` keeps the height even, which JPEG encoders require; the `.jpg` extension was already committed by TD-02's key layout.

---

## TD-07: Unique Public Video URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a stable, collision-free public identifier used in its URL. Fase 04 introduces title editing and unlisted visibility, so the identifier must survive title changes and must not be guessable by enumeration.

**Options:**

### Option A: Expose the internal UUID v4 primary key
- The video's database primary key is the URL segment: `/videos/9f8a...-...`.
- **Pros:** No extra column, no extra index, no collision handling — uniqueness is the primary key's job. Nothing to keep in sync.
- **Cons:** 36-character URLs. Couples the public contract to the internal primary key, so the two can never diverge later without a breaking change.

### Option B: Separate short public id (nanoid) with a unique index
- A dedicated `public_id` column holding a 12-character URL-safe nanoid, unique-indexed, generated at video creation. Internal joins keep using the UUID primary key.
- **Pros:** Short, YouTube-shaped URLs. Decouples the public identifier from the internal key, so storage keys (TD-02) and foreign keys stay on the UUID while the public surface can evolve. 12 characters of nanoid alphabet is far beyond any collision risk at this scale, and the unique index makes a collision a retriable error rather than a silent overwrite. Not enumerable, which is what makes unlisted visibility meaningful in Fase 04.
- **Cons:** One extra column and index. A generate-and-retry path on the (vanishingly unlikely) unique-violation.

### Option C: Slug derived from the title with a numeric suffix
- `meu-video-2` style slugs generated from the title.
- **Pros:** Human-readable and good for SEO.
- **Cons:** Title editing in Fase 04 either breaks existing URLs or requires a redirect table. Collision resolution needs a counter query per insert. Titles are user input, so slug generation inherits a normalization and abuse surface. Directly conflicts with unlisted visibility, since a slug derived from a title is guessable.

**Recommendation:** **Option B (nanoid `public_id`)** — it is the only option that satisfies both this phase's uniqueness requirement and Fase 04's unlisted-visibility requirement, and it keeps the internal UUID free to serve as the storage-key and foreign-key identity established in TD-02. Option C is disqualified by title editing arriving in the very next phase.

**Decision:** B (Separate short public id, with a unique index)

**Revisions:**
- 2026-09-20 — Generator changed from the `nanoid` package to `crypto.randomBytes` over an explicit URL-safe alphabet; the decision (a dedicated short `public_id` column with a unique index) is unchanged. Rationale: `nanoid@6` is ESM-only (`"type": "module"`, no CommonJS entry point) while `nestjs-project` compiles to CommonJS and runs its suites under `ts-jest` in CommonJS — importing it would mean either pinning the older dual-format `nanoid@3` or relying on Node's `require(esm)` interop inside the Jest transform. The generated value is 12 characters drawn uniformly from a 64-character URL-safe alphabet, which is the same output shape; `crypto` is already used by `auth.service.ts`, so this adds no dependency and removes a module-format risk for ~10 lines of code. Same reasoning as TD-06.

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** Playback must start without downloading the whole file, which means HTTP range requests answered with `206 Partial Content`; download must deliver the same object as a file. Where the bytes are served from is the decision, and it constrains the frontend's player wiring — hence `Cross-layer`. The architecture diagram already draws `Frontend → Object Storage` as a direct "Streams" relation, distinct from `Frontend → API`.

**Options:**

### Option A: API proxies the bytes with range support
- `GET /videos/:publicId/stream` reads the `Range` header, fetches the corresponding byte range from storage and pipes it back with `206` and `Content-Range`.
- **Pros:** Every request passes the JWT guard, so authorization is enforced per request and can change instantly. Single origin — no CORS configuration and no presigned-URL expiry to manage in the player.
- **Cons:** Every byte streamed by every viewer flows through the Node process. This is the same bottleneck TD-03 removes from the upload path, reintroduced on the (far higher volume) playback path. Contradicts the architecture diagram's direct frontend-to-storage relation.

### Option B: Presigned `GET` URL, client streams directly from storage
- The API returns (or 302-redirects to) a short-lived presigned URL; the browser's `<video>` element issues range requests straight to MinIO/S3, which answers `206` natively. Download uses the same mechanism with `ResponseContentDisposition: attachment`.
- **Pros:** The API never handles video bytes — it issues a signed URL and returns. Range handling and `206` come from the storage layer, which implements them correctly by definition, instead of being reimplemented. Matches the architecture diagram exactly. Content disposition is a presign parameter, so streaming and download differ by one field rather than by an endpoint. Scales to a CDN in production with no application change.
- **Cons:** Authorization is evaluated when the URL is signed, not on each byte; a leaked URL is valid until it expires (mitigated by a short TTL). The player must handle URL renewal on expiry for very long sessions. Requires CORS configuration on the bucket for browser playback.

### Option C: API redirect to a CDN origin
- Delivery fronted by a CDN in production.
- **Pros:** The correct production answer for bandwidth and latency.
- **Cons:** No local equivalent in the Compose stack, so it cannot be implemented or tested in this phase. It is a deployment concern layered on top of Option B, not an alternative to it.

**Recommendation:** **Option B (presigned GET, direct from storage)** — it is the only option consistent with both the phase's performance premise and the architecture diagram, and it gets correct `206`/`Content-Range` behavior from the storage layer rather than from hand-written stream plumbing. The expiry trade-off is bounded by a short TTL (15 minutes) and is the standard cost of the pattern; Option A's per-request authorization is not worth routing all playback bandwidth through the API.

**Decision:** B (Presigned `GET` URL, client streams directly from storage)

---

## TD-09: Video Status Lifecycle and Processing Failure

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The video row is created before its bytes exist and is mutated by two different processes (the API on upload completion, the worker on processing outcome). The set of states, and what happens when FFmpeg fails, is a contract shared by the entity, the queue handler, the delivery endpoints and the Fase 04 management panel.

**Options:**

### Option A: Four states — `draft` → `processing` → `ready` | `failed`
- `draft` on upload initiation (the pre-registration the capability requires), `processing` when the completion handshake enqueues the job, `ready` when the worker persists duration, metadata and thumbnail key, `failed` when processing exhausts its retries. A `failure_reason` column records the last error.
- **Pros:** Maps one-to-one onto the capability bullets and onto the four things that can actually be true of a video. `draft` naturally covers both "created, not yet uploaded" and "parts in flight", so an abandoned upload is simply a draft that never progressed — no separate stuck state to reconcile. Delivery endpoints have a single trivial gate (`ready`).
- **Cons:** Cannot distinguish "user created the record and walked away" from "upload is actively in progress" for monitoring or cleanup purposes.

### Option B: Five states — adds an explicit `uploading`
- `draft` on creation, `uploading` once the first part URL is issued, then as above.
- **Pros:** Distinguishes abandoned-before-upload from abandoned-mid-upload, giving a cleanup job a sharper signal.
- **Cons:** The transition into `uploading` is not observable by the API under TD-03 — it would be set when part URLs are issued, which says nothing about whether the client actually started. A state that cannot be trusted is worse than no state. Adds an enum value and its migration for a distinction nothing in Fases 03–04 consumes.

**Recommendation:** **Option A (four states)** — it covers every capability bullet and every condition the phase can actually observe. Option B's extra state would be set on an event that does not prove what the state claims, so it adds enum surface without adding truth.

**Failure policy fixed by this decision:** the job runs with 3 attempts and exponential backoff (BullMQ, per TD-01). Retries are transparent — the video stays `processing` while attempts remain. Only on final exhaustion does the worker set `failed` and persist `failure_reason`. The handler is idempotent (re-running on an already-processed video overwrites the same derived fields), which is required by BullMQ's at-least-once delivery. A user-facing reprocess action is not part of this phase.

**Decision:** A (Four states — `draft` → `processing` → `ready` | `failed`)

---

## TD-10: Test Strategy for Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de armazenamento de arquivos (vídeos e thumbnails)`, `Serviço de processamento em segundo plano (filas)`, `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** The phase introduces two external services that the existing test suite has no equivalent for. The project already tests against a real PostgreSQL from the Compose stack rather than mocking the database, and the phase requires not simulating what can be run for real. How storage and queue are made available to integration and e2e suites needs to be settled before any SI is written, because it shapes every new spec file.

**Options:**

### Option A: Reuse the Compose services, isolated by prefix
- Integration and e2e specs talk to the same MinIO and Redis containers the dev stack runs, isolated per suite by a bucket-name/key prefix and a queue-name prefix, cleaned in `afterAll`.
- **Pros:** Identical to how the project already treats PostgreSQL — one convention for all external dependencies, and the existing `--runInBand` policy already serializes suites that share infrastructure. No Docker-in-Docker, which matters because the test command runs *inside* the `nestjs-api` container. Fast: containers are already warm.
- **Cons:** Suites are not hermetic — a crashed run can leave objects or jobs behind. Requires discipline in cleanup hooks.

### Option B: Testcontainers
- Each suite starts throwaway MinIO and Redis containers programmatically.
- **Pros:** Fully hermetic, no cross-suite contamination, no cleanup discipline required.
- **Cons:** Requires a Docker socket inside the `nestjs-api` container, which the project's Compose setup does not provide and whose addition is a security and portability change well beyond this phase. Container startup per suite makes the suite substantially slower. Introduces a second infrastructure-provisioning mechanism alongside Compose, contradicting the existing PostgreSQL convention.

**Recommendation:** **Option A (Compose services with prefix isolation)** — the project's established pattern is to test against the real Compose infrastructure, and the test command runs inside a container without a Docker socket, which makes Option B a structural change rather than a test-strategy choice. Prefix isolation plus the existing `--runInBand` policy covers the contamination risk that motivates Testcontainers.

**Decision:** A (Reuse the Compose services, isolated by prefix)

---

---

## TD-11: Endpoint Used to Sign URLs (Internal vs Public)

**Scope:** Backend

**Capability:** Transversal — covers: `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance`, `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** AWS SigV4 signs the `Host` header — it is part of the canonical request and is listed in `SignedHeaders`. A URL signed for `minio:9000` is therefore rejected with `SignatureDoesNotMatch` when the request arrives with any other `Host`. This collides head-on with two facts of this project: the API and worker reach the storage at the Compose service name `minio` (the project's Docker networking rule forbids `localhost` for inter-container traffic), while the presigned URLs of TD-03 and TD-08 are consumed by a browser outside the Docker network, which cannot resolve `minio`. One endpoint value cannot serve both, and getting this wrong means either a red test suite or a feature that does not work in a real browser.

**Options:**

### Option A: Two configured endpoints — internal for operations, public for signing
- `S3_ENDPOINT` (`http://minio:9000`) is used by the API and the worker for every server-side call (`CreateMultipartUpload`, `ListParts`, `CompleteMultipartUpload`, `GetObject`, `PutObject`). `S3_PUBLIC_ENDPOINT` is used only when signing URLs that leave the backend. Tests, which run inside the `nestjs-api` container, set `S3_PUBLIC_ENDPOINT` to the internal value so the signed URL is reachable from where the test runs.
- **Pros:** Both sides get a `Host` they can actually reach, and the signature is valid in both because each is signed for the host that will receive it. The Docker networking rule is respected where it applies — container-to-container traffic never uses `localhost`. The public value is a single env var, so dev (`localhost:9000`), test (`minio:9000`) and production (a real S3 or CDN domain) differ only in configuration. No host-file edits and no dependency on a specific Docker runtime's DNS.
- **Cons:** Two endpoint variables to configure and document, and a reader must understand why they differ. The e2e suite exercises the presign mechanism against the internal host, so the exact public host string is not covered by tests — only its shape.

### Option B: Single endpoint, resolvable from both sides via a shared hostname
- One endpoint (`http://minio:9000`) used everywhere, with the developer mapping `minio` to `127.0.0.1` in the host machine's `/etc/hosts` so the browser resolves the same name.
- **Pros:** One variable, one value, and the signed URL is byte-identical everywhere.
- **Cons:** Requires a manual edit to a machine-level file outside the repository, which no `docker compose up` can perform and no evaluator will have. Undocumentable as a reproducible setup step for a project whose premise is that everything runs in containers. Breaks for anyone running the stack on a remote host.

### Option C: Proxy the storage through the API on a single origin
- The API exposes the storage under its own domain and forwards requests, so only one host ever exists.
- **Pros:** One origin, no CORS, no dual configuration.
- **Cons:** Every uploaded and streamed byte passes through the Node process — precisely what TD-03 and TD-08 exist to prevent. Self-defeating.

**Recommendation:** **Option A (two endpoints)** — it is the only option that is fully reproducible from the repository alone, and it isolates the difference into configuration, where it belongs: the internal host is a fact of the Docker network, the public host is a fact of the deployment. Option B moves a required setup step outside the repo; Option C undoes the phase's core architectural decision.

**Decision:** A (Two configured endpoints — `S3_ENDPOINT` internal, `S3_PUBLIC_ENDPOINT` for signing)

---

## TD-12: Resumable Upload After a Connection Failure

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` § Pontos de Atenção states the requirement explicitly: *"o upload de até 10GB precisa ser feito de forma que não trave o sistema e permita retomar em caso de falha de conexão"*. On a multi-gigabyte transfer a dropped connection is not an edge case, it is the expected case. TD-03's multipart protocol makes resumption possible — each part is independent — but only if the `uploadId` and the set of already-uploaded parts survive the failure. Where that state lives is the decision.

**Options:**

### Option A: Persist only the `uploadId`; the storage is the source of truth for parts
- The `upload_id` returned by `CreateMultipartUpload` is stored on the video row. To resume, the client calls `GET /videos/:id/upload` and the API answers by calling `ListParts` against the storage, returning which part numbers are already stored plus freshly signed URLs for the missing ones.
- **Pros:** One nullable column, no new table. The storage already tracks uploaded parts and their ETags as part of the multipart protocol — duplicating that into the database creates two sources of truth that can disagree after a partial failure, which is exactly when correctness matters. `ListParts` is the same primitive TD-04 uses to complete the upload, so there is one code path for "what is actually uploaded". Survives an API restart, a browser crash, and a different device resuming the same video.
- **Cons:** One extra storage round-trip when resuming. Requires the video row to hold upload state that is meaningless once the video is `ready`.

### Option B: Mirror every uploaded part into the database
- A `video_upload_parts` table records each part number and ETag as the client reports it.
- **Pros:** Resumption state is answerable from the database alone, with no storage call.
- **Cons:** The client reports parts, so the table records what the client claims rather than what the storage holds — the two diverge on exactly the failure that motivates the feature. A whole table, migration and cleanup path for data the storage already keeps authoritatively.

### Option C: No resumption — restart the upload from zero
- **Pros:** Nothing to build.
- **Cons:** Directly contradicts the requirement quoted above. On a 10GB file it makes a single dropped connection cost the entire transfer, which is a near-certain failure mode rather than a rare one.

**Recommendation:** **Option A (persist the `uploadId`, `ListParts` for the rest)** — resumption must reflect what the storage actually holds, and Option B's mirrored table is authoritative only until the moment it stops being correct. Option C fails the requirement outright.

**Contract fixed by this decision:** `GET /videos/:id/upload` returns the parts already stored and signed URLs for the remaining ones; an abandoned upload is aborted with `AbortMultipartUpload` when the draft is deleted, so orphan parts do not accumulate.

**Decision:** A (Persist only the `uploadId`; `ListParts` is the source of truth)


---

## TD-13: Persisted Video Metadata Shape

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** TD-06 decides how metadata is read (`ffprobe` JSON) but not what is kept. `ffprobe` returns dozens of fields across `format` and each stream; the capability names only duration explicitly. The shape chosen here is the Data Model of the phase and constrains Fase 04's management panel (which lists duration) and Fase 05's player.

**Options:**

### Option A: A dedicated typed column per field
- Every retained field becomes its own column: `duration_seconds`, `width`, `height`, `codec_name`, `bit_rate`, and so on.
- **Pros:** Everything is queryable and indexable in SQL, and the schema documents itself. Type safety end to end.
- **Cons:** Every new field of interest is a migration. Columns that exist only for diagnostics carry the same schema weight as the ones the product actually uses.

### Option B: A single `jsonb` column
- The whole retained `ffprobe` payload goes into `metadata jsonb`.
- **Pros:** No migration when the retained set changes; the raw probe output stays available for debugging.
- **Cons:** Duration — a field Fase 04 lists and Fase 05 displays — becomes a JSON path rather than a column, so ordering and filtering by it is awkward and unindexed by default. Nothing constrains the shape, so a probe change silently alters what is stored.

### Option C: Hybrid — columns for what the product reads, `jsonb` for the rest
- `duration_seconds`, `width`, `height` and `size_bytes` as typed columns; the remaining probe fields in a `metadata jsonb` column.
- **Pros:** The fields other phases consume are first-class, queryable and typed, while diagnostic fields stay flexible and cost no migration. Matches how the data is actually used: the product reads four values, the rest exists for support.
- **Cons:** Two places to look. The split has to be justified, or it drifts.

**Recommendation:** **Option C (hybrid)** — the split follows consumption rather than taste: duration and resolution are read by Fase 04's panel and Fase 05's player, so they are columns; codec and bitrate are never displayed, so they are payload. Option B would demote duration to a JSON path for no gain, and Option A would put codec-level trivia in the schema.

**Contract fixed by this decision:** columns `duration_seconds` (int, seconds, rounded), `width` (int), `height` (int), `size_bytes` (bigint); `metadata` (`jsonb`) holds exactly `{ codec_name, bit_rate, avg_frame_rate, format_name }` read from the first video stream and the container `format` block. All are nullable until processing succeeds, and are written in a single update together with the `ready` status of TD-09.

**Decision:** C (Hybrid — typed columns for consumed fields, `jsonb` for diagnostics)

---

## TD-14: Authorization Policy for the Video Endpoints

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** The inherited `JwtAuthGuard` is a global `APP_GUARD` (phase-02-auth/TD-02), so every new endpoint is authenticated unless it carries `@Public()`. Nothing in this phase's decisions states who may read a video. `docs/project-plan.md` lists anonymous watching as a product characteristic, but the capability bullet `Acesso anônimo à visualização de vídeos` belongs to **Fase 05**, and visibility (`público` / `unlisted`) plus the draft → publication flow belong to **Fase 04**. This phase therefore has no concept by which a video could be considered publicly readable — every video it produces is an unpublished artifact of someone's channel.

**Options:**

### Option A: Everything authenticated and owner-scoped in this phase
- All video endpoints require a valid JWT. Mutations (create draft, request part URLs, complete, resume) and reads (stream URL, download URL, status) are restricted to the video's owning channel. Anonymous access arrives in Fase 05 together with the visibility rules that make it meaningful.
- **Pros:** Inherits the global guard's default instead of carving an exception out of it, so no `@Public()` is introduced before there is a rule deciding what is public. Every video in this phase is a draft or a freshly processed file with no visibility attribute — exposing it would be exposing unpublished content. The authorization matrix is one rule, verifiable in a test.
- **Cons:** The streaming endpoint cannot be demonstrated anonymously in this phase; a later phase must relax the rule.

### Option B: Public streaming and download already in this phase
- `@Public()` on the delivery endpoints, anticipating Fase 05.
- **Pros:** Streaming is demonstrable with nothing but a URL, closer to the eventual product behavior.
- **Cons:** Anticipates a phase whose whole point is deciding who sees what. With no `visibility` column yet (Fase 04), "public" would mean *every* video including other people's drafts — a leak, not a feature. Reversing it later is a breaking change to a published contract.

**Recommendation:** **Option A (authenticated and owner-scoped)** — the objects this phase creates have no visibility attribute, so there is no coherent definition of "public" available to it. Option B would make unpublished drafts of every channel world-readable to satisfy a capability that belongs to two phases later.

**Contract fixed by this decision:** every video endpoint of this phase requires authentication; the acting user's channel (resolved per TD-18) must own the video, otherwise the request is rejected as not found rather than forbidden, so ownership is not probeable by enumeration.

**Decision:** A (Everything authenticated and owner-scoped in this phase)

---

## TD-15: Abandoned Uploads and Object Lifecycle
<!-- status: superseded-by: phase-03-videos/TD-19 -->

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** `docs/project-plan.md` § Pontos de Atenção states: *"vídeos grandes consomem muito espaço. É importante planejar o crescimento e os custos de armazenamento desde o início."* Under TD-03 an upload that is initiated and abandoned leaves up to 1024 uploaded parts of a 10GB file in the bucket. Those parts are invisible to `ListObjects` — they belong to an incomplete multipart upload — but they are stored and, on real S3, billed. TD-12 aborts the upload when the draft is explicitly deleted, which covers only the path where the user acts.

**Options:**

### Option A: Bucket lifecycle rule — `AbortIncompleteMultipartUpload`
- A lifecycle rule configured on the bucket at bootstrap aborts incomplete multipart uploads older than N days. MinIO and S3 both implement it server-side.
- **Pros:** No application code, no scheduler, no new failure mode — the storage layer does it. Configured once where the bucket is created, so dev and production behave the same. Exactly the mechanism S3 provides for this problem.
- **Cons:** Coarse: a single N for all uploads, evaluated by the storage on its own cadence rather than on demand.

### Option B: A scheduled cleanup job on the queue
- A repeatable BullMQ job lists multipart uploads and aborts stale ones.
- **Pros:** Full control over the policy, and the same job could also reconcile stuck `draft` rows.
- **Cons:** Application code, a scheduler, and a new job type to test and monitor — to reimplement a feature the storage already has. Adds a second reason for the worker to exist.

### Option C: Nothing in this phase
- **Pros:** No work.
- **Cons:** Leaves the Ponto de Atenção unaddressed with an unbounded leak: every abandoned 10GB upload is stored indefinitely and invisibly.

**Recommendation:** **Option A (bucket lifecycle rule)** — the storage implements this natively, and using it costs one call at bucket bootstrap instead of a job with its own tests and failure modes. Option B would be justified only if the policy needed to vary per upload, which nothing in the phase suggests.

**Contract fixed by this decision:** at bucket bootstrap the API applies a lifecycle configuration with `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }`. The 7-day window is longer than any plausible legitimate upload and short enough to bound the leak.

**Decision:** ~~A (Bucket lifecycle rule — `AbortIncompleteMultipartUpload` after 7 days)~~ — **superseded by `phase-03-videos/TD-19`**. Option A rests on the premise that the storage implements this natively; MinIO does not. Verified against `RELEASE.2025-09-07T16-13-09Z`: a rule carrying only `AbortIncompleteMultipartUpload` is rejected with `InvalidArgument`, and when the rule is accepted alongside an `Expiration` action the abort action is silently dropped from what `GetBucketLifecycleConfiguration` reads back. MinIO's own S3-compatibility documentation states it outright: *"the `AbortIncompleteMultipartUpload` lifecycle action is not supported when using `PutBucketLifecycle`"*. With the premise gone, Option B is what the same reasoning selects.

---

## TD-16: Accepted File Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** TD-03 keeps the bytes out of the API, which is the point — and the consequence is that the API cannot inspect what was uploaded while it is being uploaded. Today the only validation is the client-declared size. Without a stated policy, an arbitrary 10GB object can be stored, and the first thing that notices is `ffprobe` failing in the worker, by which point the object exists and has been paid for.

**Options:**

### Option A: Declare-and-verify — cheap checks at initiation, authoritative check in the worker
- At initiation the API validates the declared size against the 10GB ceiling and the declared content type against an allowlist, and signs `CreateMultipartUpload` with that content type so the stored object carries it. The authoritative check is `ffprobe` in the worker: if the object is not a decodable video, the video goes to `failed` and the object is deleted.
- **Pros:** Rejects the obvious cases before a single byte moves, at no cost. The real check is the one that cannot be spoofed — a client-declared content type is a claim, but `ffprobe` reads the actual container. Deleting on rejection closes the storage-cost hole that motivates the policy. No inspection path through the API, so TD-03 is untouched.
- **Cons:** A determined client can still upload 10GB of garbage once before the worker rejects it; the cost is bounded by deletion, not prevented.

### Option B: Enforce the content type as a signed condition only
- Rely on the presigned request's signed `Content-Type` and skip the worker-side verification.
- **Pros:** Slightly less work in the worker.
- **Cons:** A signed content type constrains the header, not the bytes — any file can be sent with `video/mp4`. It would be validation in name only, and a non-video object would then reach `ready` with null metadata.

### Option C: No policy
- **Pros:** Nothing to build.
- **Cons:** Leaves both the failure mode and the storage cost undefined, and leaves the worker's behavior on a non-video input unspecified — which is precisely what TD-09's `failed` state needs to be triggered by something well-defined.

**Recommendation:** **Option A (declare-and-verify)** — it puts each check where it can actually be enforced: the cheap claims at initiation, the authoritative decode in the worker. Option B mistakes a signed header for a guarantee about content.

**Contract fixed by this decision:** allowlist `video/mp4`, `video/webm`, `video/quicktime` at initiation; declared size `> 0` and `<= 10GB`; the declared content type is signed into `CreateMultipartUpload`. In the worker, a failed `ffprobe` or the absence of a video stream sets `failed` with `failure_reason` and deletes the stored object.

**Decision:** A (Declare-and-verify — allowlist at initiation, `ffprobe` as the authoritative check)

---

## TD-17: How the Test Suites Exercise the Worker

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** TD-05 runs the worker as a separate container, while the project's convention runs every test command inside the `nestjs-api` container, and TD-10 requires the suites to exercise a real queue. Those three facts do not join on their own: nothing says how a suite running in one container observes work performed by another. The answer shapes every processing-related spec, so it must be settled before `plan-build`.

**Options:**

### Option A: Instantiate the processor in the test's Nest context; queue and storage stay real
- The suite builds a testing module that includes the worker module, so the same `WorkerHost` class the container runs consumes from the same real Redis queue, against the same real MinIO. The test awaits the job's completion event instead of polling the database.
- **Pros:** Deterministic — the test owns the worker's lifecycle and knows exactly when the job finished, with no polling and no arbitrary timeout. Still exercises the real queue, the real storage and the real FFmpeg binaries, so nothing that TD-10 cares about is mocked. Failures surface as ordinary Nest test failures with stack traces, not as a timeout whose cause is in another container's logs. The class under test is byte-identical to the one the container runs — TD-05's topology is a deployment concern, and what the suite verifies is the processor.
- **Cons:** The worker **container** itself — its image, its entrypoint, its FFmpeg installation — is not exercised by the suite. A broken worker Dockerfile would not turn a test red.

### Option B: Assert against the running worker container
- The suite enqueues and then polls the database until the video reaches `ready` or a timeout expires.
- **Pros:** Exercises the deployed topology end to end, Dockerfile and entrypoint included.
- **Cons:** Introduces polling with a timeout into every processing spec — the classic source of flaky suites, and the timeout must be generous enough for FFmpeg on a cold container. Couples test outcomes to container startup ordering. When it fails, the diagnosis lives in another container's logs rather than in the test output. Requires the worker container to be running for `npm test` to pass, which the project's test convention does not currently assume.

**Recommendation:** **Option A (processor in the test context)** — it keeps everything TD-10 requires real (queue, storage, FFmpeg) while removing the one thing that makes asynchronous tests unreliable, which is waiting on another process without a completion signal. The gap it leaves is narrow and honest: the worker image is verified by the container starting and consuming in the Compose stack, not by an assertion.

**Decision:** A (Instantiate the processor in the test's Nest context; queue, storage and FFmpeg stay real)

---

## TD-18: Resolving the Owning Channel of the Authenticated User

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A video belongs to a channel, and the first operation of the phase — creating the draft — needs the owning `channel_id`. What the delivered code provides is narrower than the phase assumes: the JWT payload is `{ sub, email }` (`src/auth/auth.types.ts`) and `ChannelsService` exposes exactly one method, `createChannel(userId, email)` (`src/channels/channels.service.ts`). There is no path from the authenticated user to their channel. This is a real gap in the inherited surface (`validation.md` DG-1), not an implementation detail, because the three ways to close it place the responsibility in three different modules.

**Options:**

### Option A: Add a lookup to the inherited `ChannelsService`
- `ChannelsService.findByUserId(userId)` is added to the channels module, which already owns the `Channel` entity and exports itself. The videos module imports `ChannelsModule` and calls it.
- **Pros:** The channel domain owns channel lookups, which is what the project's Single Responsibility principle asks for — the `CLAUDE.md` is explicit that a module must not own entities that are not its own. `ChannelsModule` already exports `ChannelsService` and `TypeOrmModule`, so consuming it requires no change to the inherited module's public shape beyond the new method. Naturally reused by Fase 04's channel panel.
- **Cons:** Touches a module delivered by a prior phase, however additively.

### Option B: Put `channelId` in the JWT payload
- The token issued at login carries the channel id, so no lookup is needed.
- **Pros:** Zero queries on the hot path.
- **Cons:** Changes the auth contract of a closed phase and invalidates every token issued before the change. Duplicates state into a bearer token that outlives it — a channel renamed, transferred or deleted leaves stale tokens. Reopens phase 02's TD-02 for a problem that is not an auth problem.

### Option C: Inject the `Channel` repository into the videos module
- The videos module queries the `channels` table directly.
- **Pros:** No change to any inherited file.
- **Cons:** The videos module would read another domain's table directly, which is the exact pattern the project's Working Principles single out: *"when a module starts owning logic or entities that are not its own … extract it immediately into the proper module"*. Two modules would then hold knowledge of the channel schema.

**Recommendation:** **Option A (`ChannelsService.findByUserId`)** — the lookup belongs to the module that owns the entity, and that module is already exported and consumed elsewhere. Option B pays for a query with an auth-contract change and stale-token risk; Option C buys "no inherited files touched" at the cost of the separation the project states as a principle.

**Decision:** A (Add `findByUserId` to the inherited `ChannelsService`)


---

## TD-19: Abandoned Upload Cleanup (supersedes TD-15)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** `phase-03-videos/TD-15` chose a bucket lifecycle rule to bound the cost of abandoned multipart uploads, on the grounds that the storage implements the behavior natively and using it would cost one call at bucket bootstrap. That premise does not hold for MinIO: its S3-compatibility documentation states that *"the `AbortIncompleteMultipartUpload` lifecycle action is not supported when using `PutBucketLifecycle`"*, and testing against `RELEASE.2025-09-07T16-13-09Z` confirms it — the rule is rejected outright when it carries only the abort action, and the action is silently discarded when paired with an `Expiration`. The requirement it addressed is unchanged and still comes from `docs/project-plan.md` § Pontos de Atenção: *"É importante planejar o crescimento e os custos de armazenamento desde o início."*

**Options:**

### Option A: Repeatable job on the existing queue
- A BullMQ repeatable job runs daily, calls `ListMultipartUploads`, and aborts every upload initiated more than N days ago.
- **Pros:** Uses infrastructure the phase already has — the queue exists for video processing and repeatable jobs are a first-class BullMQ feature, so this adds a handler, not a component. The policy is explicit, testable against real MinIO, and portable: it behaves identically on real S3, where the native rule would otherwise make the two environments diverge. Reuses the `abortMultipartUpload` call already needed by TD-12's draft-deletion path.
- **Cons:** Application code where a storage feature was expected: a handler, its schedule and its tests. One more job to reason about when the worker is unhealthy.

### Option B: Rely on MinIO's internal cleanup
- MinIO removes stale incomplete uploads on its own cadence; do nothing explicit.
- **Pros:** No code at all.
- **Cons:** Undocumented as a contract and not configurable through the S3 API, so the retention window is whatever the server decides and can change between releases. Nothing carries over to production S3, where no equivalent implicit behavior exists. Leaves the Ponto de Atenção answered by an assumption rather than by a decision.

### Option C: Manual operator cleanup (`mc rm --incomplete`)
- Document the command and leave it to an operator.
- **Pros:** Zero code, and it is the tool MinIO's own documentation points to.
- **Cons:** A cost control that depends on someone remembering to run it is not a control. Not reproducible in tests, and absent from production.

**Recommendation:** **Option A (repeatable job)** — the queue is already part of this phase, so the marginal cost is a handler rather than a component, and it is the only option that behaves the same on MinIO and on S3. Option B substitutes an undocumented server behavior for a decision, and Option C moves the requirement onto a human.

**Contract fixed by this decision:** a repeatable job `abandoned-upload-cleanup` runs every 24h on the `video-processing` queue's Redis, lists multipart uploads under the bucket and aborts those whose `Initiated` timestamp is older than `UPLOAD_ABORT_AFTER_DAYS` (default 7). The explicit-deletion path of TD-12 is unchanged and remains the fast path.

**Decision:** A (Repeatable job on the existing queue)

**Libraries:** bullmq


## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Backend | Object Storage Client and Key Layout | `@aws-sdk/client-s3` + presigner, single bucket keyed by video UUID | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) |
| TD-03 | Cross-layer | Upload Protocol for 10GB Files | Presigned multipart direct to storage | A (Presigned multipart upload direct to storage) |
| TD-04 | Backend | Upload Completion Handshake | Client-driven completion endpoint | A (Client-driven completion endpoint) |
| TD-05 | Backend | Video Worker Topology | Separate container, shared codebase, dedicated entrypoint | A (Separate container, same codebase, dedicated entrypoint) |
| TD-06 | Backend | FFmpeg Invocation | Direct `child_process.spawn` of `ffprobe`/`ffmpeg` | B (Direct `child_process.spawn` of `ffprobe`/`ffmpeg`) |
| TD-07 | Backend | Unique Public Video URL | Separate short `public_id` with unique index | B (Separate short public id, with a unique index) — generated with `crypto.randomBytes` |
| TD-08 | Cross-layer | Streaming and Download Delivery | Presigned `GET`, client streams directly from storage | B (Presigned `GET` URL, client streams directly from storage) |
| TD-09 | Backend | Video Status Lifecycle and Processing Failure | Four states (`draft`/`processing`/`ready`/`failed`) + 3 attempts then `failed` | A (Four states — `draft` → `processing` → `ready` \| `failed`) |
| TD-10 | Backend | Test Strategy for Storage and Queue | Compose services with prefix isolation | A (Reuse the Compose services, isolated by prefix) |
| TD-11 | Backend | Endpoint Used to Sign URLs (Internal vs Public) | Two endpoints — internal for operations, public for signing | A (Two configured endpoints) |
| TD-12 | Cross-layer | Resumable Upload After a Connection Failure | Persist the `uploadId`; `ListParts` is the source of truth | A (Persist only the `uploadId`) |
| TD-13 | Backend | Persisted Video Metadata Shape | Hybrid — typed columns for consumed fields, `jsonb` for diagnostics | C (Hybrid) |
| TD-14 | Backend | Authorization Policy for the Video Endpoints | Everything authenticated and owner-scoped in this phase | A (Authenticated and owner-scoped) |
| TD-15 | Backend | Abandoned Uploads and Object Lifecycle | Bucket lifecycle rule — abort incomplete multipart after 7 days | ~~A~~ — superseded by TD-19 |
| TD-16 | Backend | Accepted File Policy | Declare-and-verify — allowlist at initiation, `ffprobe` authoritative | A (Declare-and-verify) |
| TD-17 | Backend | How the Test Suites Exercise the Worker | Processor instantiated in the test context; queue/storage/FFmpeg real | A (Processor in the test context) |
| TD-18 | Backend | Resolving the Owning Channel of the Authenticated User | Add `findByUserId` to the inherited `ChannelsService` | A (`ChannelsService.findByUserId`) |
| TD-19 | Backend | Abandoned Upload Cleanup (supersedes TD-15) | Repeatable job on the existing queue | A (Repeatable job) |
