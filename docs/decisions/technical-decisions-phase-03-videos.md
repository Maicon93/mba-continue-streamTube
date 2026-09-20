---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-20
scope_description: "Backend foundation for video upload and processing: object storage client and key layout, queue technology, 10GB upload protocol, upload-completion handshake, video worker topology, FFmpeg invocation, unique public URL, streaming/download delivery, video status lifecycle, and the testing strategy against real storage and queue infrastructure."
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
- The client, having uploaded every part, calls `POST /videos/:id/upload/complete` with the collected part numbers and ETags. The API calls `CompleteMultipartUpload`, flips the status to `processing` and enqueues the job.
- **Pros:** Deterministic and synchronous — the API knows the exact moment the object became complete and returns a meaningful error if it did not. Fully testable with supertest against real MinIO, no event plumbing. Identical behavior on MinIO and S3. The ETag list is required by the S3 API anyway, so the client already holds the data.
- **Cons:** A client that uploads all parts and then disappears leaves the video stuck in `draft` with orphan parts — needs an expiry/cleanup policy.

### Option B: Storage bucket notification → webhook
- MinIO/S3 emits an `s3:ObjectCreated:CompleteMultipartUpload` event to a webhook endpoint on the API, which then enqueues the job.
- **Pros:** Robust to a client that vanishes after the last part — completion is observed at the storage layer. Fewer API calls in the happy path.
- **Cons:** MinIO event configuration is environment setup that must be reproduced in CI and in production S3 (where it means SNS/SQS/EventBridge, a different mechanism). The webhook must be reachable and authenticated. Still requires the client to call `CompleteMultipartUpload` itself with the ETags, so it does not actually remove the client's responsibility — it only moves where the job is enqueued from. Substantially harder to exercise in e2e tests.

**Recommendation:** **Option A (client-driven completion endpoint)** — the ETag list makes the client a mandatory participant in completion regardless of option, so Option B adds an environment-specific event pipeline without removing the client's role. Option A also keeps the whole flow inside supertest's reach, which matters for the phase's "test against real infrastructure" requirement. The stuck-draft case is handled by the status lifecycle in TD-09, not by the transport.

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

**Decision:** B (Separate short public id — nanoid — with a unique index)

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

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Backend | Object Storage Client and Key Layout | `@aws-sdk/client-s3` + presigner, single bucket keyed by video UUID | A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) |
| TD-03 | Cross-layer | Upload Protocol for 10GB Files | Presigned multipart direct to storage | A (Presigned multipart upload direct to storage) |
| TD-04 | Backend | Upload Completion Handshake | Client-driven completion endpoint | A (Client-driven completion endpoint) |
| TD-05 | Backend | Video Worker Topology | Separate container, shared codebase, dedicated entrypoint | A (Separate container, same codebase, dedicated entrypoint) |
| TD-06 | Backend | FFmpeg Invocation | Direct `child_process.spawn` of `ffprobe`/`ffmpeg` | B (Direct `child_process.spawn` of `ffprobe`/`ffmpeg`) |
| TD-07 | Backend | Unique Public Video URL | Separate nanoid `public_id` with unique index | B (Separate short public id — nanoid — with a unique index) |
| TD-08 | Cross-layer | Streaming and Download Delivery | Presigned `GET`, client streams directly from storage | B (Presigned `GET` URL, client streams directly from storage) |
| TD-09 | Backend | Video Status Lifecycle and Processing Failure | Four states (`draft`/`processing`/`ready`/`failed`) + 3 attempts then `failed` | A (Four states — `draft` → `processing` → `ready` | `failed`) |
| TD-10 | Backend | Test Strategy for Storage and Queue | Compose services with prefix isolation | A (Reuse the Compose services, isolated by prefix) |
