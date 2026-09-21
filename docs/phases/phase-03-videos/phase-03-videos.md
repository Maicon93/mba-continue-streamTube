---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T20:17:49-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T20:17:29-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T20:16:42-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-20T15:19:34-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-20T15:19:34-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver object storage, a background processing queue and a video worker so a user can upload a file of up to 10GB without the API ever handling its bytes, have duration, metadata and a thumbnail extracted automatically, and reach the video through a unique URL for streaming or download.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and New Compose Services

**Description:** Install the phase's production dependencies, create the `storage` and `queue` config namespaces following the `registerAs` pattern inherited from Phase 01, extend the Joi schema, and add MinIO and Redis to Docker Compose. The worker service is added later in SI-03.11, once there is an entrypoint for it to run.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `bullmq@^5.81.5`, `@nestjs/bullmq@^11.0.5` (11 is the last CommonJS build; 12 is ESM-only and breaks `ts-jest`), `@aws-sdk/client-s3@^3.1136.0`, `@aws-sdk/s3-request-presigner@^3.1136.0` (per `library-refs.md`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (string, required — internal, the Compose service name), `S3_PUBLIC_ENDPOINT` (string, required — used only for signing URLs that leave the backend, per `phase-03-videos/TD-11`), `S3_REGION` (string, default `'us-east-1'`), `S3_ACCESS_KEY` / `S3_SECRET_KEY` (string, required), `S3_BUCKET` (string, default `'streamtube-videos'`), `UPLOAD_PART_SIZE_BYTES` (number, default `10485760`), `UPLOAD_MAX_SIZE_BYTES` (number, default `10737418240`), `UPLOAD_URL_TTL_SECONDS` (number, default `3600`), `DELIVERY_URL_TTL_SECONDS` (number, default `900`), `UPLOAD_ABORT_AFTER_DAYS` (number, default `7`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `QUEUE_PREFIX` (string, default `'streamtube'`), `VIDEO_JOB_ATTEMPTS` (number, default `3`), `VIDEO_JOB_BACKOFF_MS` (number, default `2000`), `FFMPEG_TIMEOUT_MS` (number, default `120000`)
- Register both factories in `AppModule`'s `ConfigModule.forRoot({ load: [...] })`
- Update `src/config/env.validation.ts` — add every new variable to the Joi schema, required/defaults as above
- Update `.env.example` with all new variables using Compose-compatible values (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`)
- Add `minio` to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001`, root user/password from env, a named volume for `/data`, and a healthcheck on `/minio/health/live`
- Add `redis` to `nestjs-project/compose.yaml` — image `redis:8-alpine`, port `6379:6379`, healthcheck `redis-cli ping`
- Make `nestjs-api` depend on both with `condition: service_healthy`

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings `minio` and `redis` to `running` and both report healthy via `docker compose ps`
- The application boots with the new variables present; omitting `S3_ACCESS_KEY` makes Joi fail at bootstrap and the app does not start
- The existing suite stays green — no behavior of Phases 01–02 changed

---

### SI-03.2 — Channel Lookup for the Authenticated User

**Description:** Add the missing path from an authenticated user to their owning channel. The JWT carries only `{ sub, email }` and `ChannelsService` exposes only `createChannel`, so nothing in the delivered code can answer "which channel does this user own" — every capability of this phase needs that answer (per `phase-03-videos/TD-18`).

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts`, querying by the existing unique `user_id` column
- Keep the method inside the channels module — the videos module imports `ChannelsModule` (already exported) rather than touching the `channels` table directly, per the project's Single Responsibility principle
- No entity, migration or auth-contract change: `user_id` is already unique on `channels` and the JWT stays as issued by Phase 02

**Dependencies:** None

**Acceptance criteria:**

- Unit test: `findByUserId` returns the channel for a user that owns one, and `null` for a user id with no channel
- Integration test against the real database: a user registered through the Phase 02 flow resolves to the channel created for them, with the nickname derived from the email prefix
- The Phase 02 suite stays green — the change is purely additive

---

### SI-03.3 — Video Entity and Migration

**Description:** Create the `videos` table and its entity: ownership by channel, the four-state lifecycle, the unique public id, the storage keys, the extracted metadata shape, and the multipart upload id that makes resumption possible.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` with: `id` (uuid, PK), `public_id` (varchar(12), unique — per `phase-03-videos/TD-07`), `channel_id` (uuid, FK → `channels.id`), `title` (varchar(255)), `status` (enum `draft | processing | ready | failed` — per `phase-03-videos/TD-09`), `source_key` / `thumbnail_key` (varchar, nullable — per `phase-03-videos/TD-02`), `upload_id` (varchar, nullable — per `phase-03-videos/TD-12`), `content_type` (varchar), `duration_seconds` (int, nullable), `width` / `height` (int, nullable), `size_bytes` (bigint, nullable), `metadata` (jsonb, nullable), `failure_reason` (text, nullable), `created_at` / `updated_at` (per `phase-03-videos/TD-13`)
- Declare `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, matching the relation style of `Channel → User`
- Create `src/videos/videos.repository.ts`-equivalent access through `@InjectRepository(Video)` + `TypeOrmModule.forFeature([Video])` in the videos module, following the pattern used by `AuthModule`
- Generate the migration `src/database/migrations/<timestamp>-CreateVideos.ts` — table, the `videos_status_enum` type, unique index on `public_id`, index on `channel_id`, FK to `channels`
- Write a reversible `down()` that drops the table **and** the enum type, so the migrations integration test can apply and revert cleanly

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the table; `npm run migration:revert` removes it along with its enum type, leaving no orphan type behind
- The migrations integration test passes on a database that already has the table (the suite is repeatable)
- Integration test: inserting two videos with the same `public_id` violates the unique index; deleting a channel with videos behaves per the declared FK

---

### SI-03.4 — Storage Module: Dual Client, Bucket Bootstrap, Key Layout

**Description:** Encapsulate every object-storage interaction behind one module. Two S3 clients are configured — an internal one for server-side calls and a public one used solely to sign URLs that leave the backend — and the bucket is created on boot with the lifecycle rule that bounds abandoned uploads.

**Technical actions:**

- Create `src/storage/storage.module.ts` and `src/storage/storage.service.ts`
- Build two `S3Client` instances from `storageConfig`: the internal one on `S3_ENDPOINT`, the signing one on `S3_PUBLIC_ENDPOINT`, both with `forcePathStyle: true` and the same credentials (per `phase-03-videos/TD-11`)
- Implement a key builder: `videos/{videoId}/source{ext}` and `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-02`) — keyed by the internal uuid, never by `public_id` or by a user-supplied filename
- On module init, ensure the bucket exists (`HeadBucket`, then `CreateBucket` when absent) — idempotent, safe on every boot. CORS is **not** applied per bucket: MinIO answers `NotImplemented` to `PutBucketCors`; it is a server-level setting (`MINIO_API_CORS_ALLOW_ORIGIN` in `compose.yaml`). Abandoned-upload cleanup is **not** a lifecycle rule: MinIO does not support `AbortIncompleteMultipartUpload` via `PutBucketLifecycle`, so it is a repeatable job in SI-03.7 (per `phase-03-videos/TD-19`, superseding `phase-03-videos/TD-15`)
- Expose the operations the phase needs: `createMultipartUpload`, `signUploadPart`, `listParts`, `listMultipartUploads`, `completeMultipartUpload`, `abortMultipartUpload`, `signDownload({ key, disposition })`, `putObject`, `getObjectStream`, `deleteObject`
- `signUploadPart` and `signDownload` sign through the **public** client; every other operation goes through the internal one

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration test against the real MinIO: the bucket is created on first boot and the second boot is a no-op
- Integration test: a ranged `GET` on a presigned URL returns `206` with a `Content-Range` header and exactly the requested byte count
- Integration test: a URL produced by `signUploadPart` carries the public endpoint's host, while `listParts` reaches MinIO through the internal endpoint in the same run
- Unit test: the key builder produces the two documented shapes and rejects a video id that is not a uuid

---

### SI-03.5 — Draft Creation and Multipart Upload Initiation

**Description:** The single entry point of the upload flow. It pre-registers the video as a draft — the capability's literal requirement — validates what the client declared, opens the multipart upload and hands back one presigned URL per part. No video byte reaches the API.

**Technical actions:**

- Create `src/videos/videos.module.ts`, `videos.controller.ts`, `videos.service.ts`, importing `ChannelsModule` and `StorageModule`
- Create `src/videos/public-id.util.ts` — 12 characters drawn from a 64-char URL-safe alphabet via `crypto.randomBytes`, with rejection sampling so the distribution stays uniform (per `phase-03-videos/TD-07` Revisions); on a unique-violation the service retries with a fresh id, bounded, mirroring the nickname-collision pattern already in `ChannelsService`
- Create `src/videos/dto/create-video.dto.ts` — `title` (string, required, 1–255), `contentType` (string, required, one of `video/mp4`, `video/webm`, `video/quicktime`), `sizeBytes` (int, required, `> 0` and `<= UPLOAD_MAX_SIZE_BYTES`) (per `phase-03-videos/TD-16`)
- `POST /videos`: resolve the owning channel via `ChannelsService.findByUserId` (per `phase-03-videos/TD-18`), persist the video as `draft` with its `public_id`, call `createMultipartUpload` signing the declared `ContentType`, persist the returned `upload_id` and `source_key`, then return the presigned part URLs
- Compute the part plan from `UPLOAD_PART_SIZE_BYTES`: `ceil(sizeBytes / partSize)` parts, each URL signed with `UPLOAD_URL_TTL_SECONDS`
- Guard the endpoint with the inherited global `JwtAuthGuard` (no `@Public()`), and document it with `@nestjs/swagger` decorators as the other controllers do

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- E2E: an authenticated `POST /videos` returns 201 with `publicId`, `uploadId` and a `parts` array whose length matches `ceil(sizeBytes / partSize)`; the row exists with `status = draft`
- E2E: a `contentType` outside the allowlist returns 400 `UNSUPPORTED_VIDEO_TYPE`; a `sizeBytes` above the ceiling returns 400 `FILE_TOO_LARGE`; an unauthenticated request returns 401
- Integration: uploading the first part to the returned URL succeeds against the real MinIO and `listParts` reports it
- Unit: the public-id generator produces 12 URL-safe characters and its alphabet has no modulo bias

---

### SI-03.6 — Upload Resumption

**Description:** A dropped connection during a multi-gigabyte upload is the expected case, not an edge case. This step lets a client discover what the storage already holds and get fresh URLs only for what is missing (per `phase-03-videos/TD-12`).

**Technical actions:**

- `GET /videos/:publicId/upload`: load the video, require it to be in `draft` with a non-null `upload_id`, call `listParts` and return the stored part numbers with their sizes plus freshly signed URLs for the parts still missing
- Derive the expected part count from the persisted `size_bytes` declared at initiation — the storage is the source of truth for what exists, the row for what was promised
- Return 409 `UPLOAD_NOT_IN_PROGRESS` when the video is no longer a draft or has no open multipart upload
- Wire deletion of a draft to `abortMultipartUpload`, so an explicitly discarded upload releases its parts immediately instead of waiting for the lifecycle rule

**Dependencies:** SI-03.5

**Acceptance criteria:**

- Integration against real MinIO: upload parts 1 and 3 of a 4-part plan, then `GET .../upload` reports 1 and 3 as stored and returns signed URLs for 2 and 4 only
- E2E: the endpoint returns 409 for a video already in `processing`, and 404 for a video owned by another channel
- Integration: deleting a draft aborts the multipart upload — `listParts` afterwards fails with `NoSuchUpload`

---

### SI-03.7 — Processing Queue and Job Contract

**Description:** Register the BullMQ queue shared by the API (producer) and the worker (consumer), with the retry policy the status lifecycle depends on, and a queue prefix that lets test suites run against the same Redis without colliding.

**Technical actions:**

- Create `src/queue/queue.module.ts` registering `BullModule.forRootAsync` with `connection` from `queueConfig` (host `redis`, per the Docker networking rule) and `prefix: QUEUE_PREFIX`
- Set `defaultJobOptions`: `attempts: VIDEO_JOB_ATTEMPTS`, `backoff: { type: 'exponential', delay: VIDEO_JOB_BACKOFF_MS }`, `removeOnComplete: true`, `removeOnFail: false` (a failed job is kept for inspection) — per `phase-03-videos/TD-01` and `phase-03-videos/TD-09`
- Register the queue `video-processing` via `BullModule.registerQueue`
- Define the job payload contract in `src/videos/video-job.types.ts` as `{ videoId: string }` — the worker re-reads the row rather than trusting a denormalized payload, which is what keeps the handler idempotent under at-least-once delivery
- The prefix is read from config so integration suites can set a per-suite value (per `phase-03-videos/TD-10`); the same prefix must be configured on both producer and consumer
- Register a repeatable job `abandoned-upload-cleanup` running every 24h whose handler lists multipart uploads and aborts those initiated more than `UPLOAD_ABORT_AFTER_DAYS` ago (per `phase-03-videos/TD-19`) — MinIO does not support the equivalent bucket lifecycle rule

**Dependencies:** SI-03.1, SI-03.4

**Acceptance criteria:**

- Integration against the real Redis: a job added to `video-processing` is visible under the configured prefix and absent under a different prefix
- Integration: a handler that throws is retried up to the configured attempt count with growing delay, and the job lands in the failed set only after the last attempt
- Unit: the job payload type compiles against the producer and consumer call sites
- Integration against real MinIO: an upload initiated and left open is aborted by the cleanup handler when older than the threshold, and a fresh one is left untouched

---

### SI-03.8 — Upload Completion and Enqueue

**Description:** Close the multipart upload and hand the video to the queue. The API sources the part list from the storage rather than from the request body, so the completion call does not depend on untrusted client input (per `phase-03-videos/TD-04`).

**Technical actions:**

- `POST /videos/:publicId/upload/complete`: require `draft` status and a non-null `upload_id`; call `listParts`, verify the stored part count matches the expected count derived from `size_bytes`, then call `completeMultipartUpload` with the `ETag`s returned by the storage
- Return 409 `UPLOAD_INCOMPLETE` when parts are missing, naming how many are still expected so the client can resume via SI-03.6
- On success: transition the video to `processing`, clear `upload_id`, and enqueue `{ videoId }` on `video-processing` — in that order, so a job never observes a row still marked `draft`
- Record in the service that the enqueue is the only trigger of processing; a client that never calls this endpoint leaves a recoverable draft (the known limitation recorded in `phase-03-videos/TD-04`)

**Dependencies:** SI-03.5, SI-03.7

**Acceptance criteria:**

- E2E: uploading every part and calling complete returns 200, the row reads `processing`, and a job exists on the queue
- E2E: calling complete with parts missing returns 409 `UPLOAD_INCOMPLETE` and leaves the video in `draft` with its `upload_id` intact, so resumption still works
- Integration: the object is readable at `source_key` in MinIO after completion, with the size that was declared

---

### SI-03.9 — FFmpeg Wrapper (ffprobe and frame extraction)

**Description:** A small, typed wrapper over the two binaries the worker needs, spawned directly with an explicit timeout (per `phase-03-videos/TD-06`).

**Technical actions:**

- Create `src/videos/ffmpeg/ffprobe.ts` — spawn `ffprobe -v quiet -print_format json -show_format -show_streams <file>`, parse the JSON into a project-owned interface, and return `{ durationSeconds, width, height, sizeBytes, codecName, bitRate, avgFrameRate, formatName }` read from the first video stream and the container `format` block (per `phase-03-videos/TD-13`)
- Create `src/videos/ffmpeg/thumbnail.ts` — spawn `ffmpeg -ss <10% of duration> -i <file> -frames:v 1 -vf scale=1280:-2 -q:v 2 <out.jpg>`, with `-ss` before `-i` for fast seek on large files (per the `phase-03-videos/TD-06` Revisions)
- Both wrapped in a promise that rejects on a non-zero exit code, carrying the captured `stderr`, and both killed on `FFMPEG_TIMEOUT_MS` — a hung probe must fail rather than silently consume one of the three attempts
- Treat "no video stream present" as a rejection, not as an empty result — this is the signal `phase-03-videos/TD-16` relies on to reject a non-video upload

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration with a real fixture video: `ffprobe` returns a duration within a tolerance of the known value, plus the expected resolution and codec
- Integration: the thumbnail is produced as a readable JPEG 1280px wide with an even height
- Integration: a non-video file (a text file renamed to `.mp4`) rejects with a non-zero exit and a message, and a spawn that exceeds the timeout is killed and rejects

---

### SI-03.10 — Video Processor

**Description:** The job handler: download the source, probe it, generate the thumbnail, persist everything and flip the status. It is the same class the worker container runs and the one the test suites instantiate (per `phase-03-videos/TD-05` and `phase-03-videos/TD-17`).

**Technical actions:**

- Create `src/videos/video.processor.ts` — `@Processor('video-processing')` extending `WorkerHost`, implementing `process(job: Job<{ videoId: string }>)`
- Stream the object from storage to a temporary file, run `ffprobe`, run the thumbnail extraction, upload the thumbnail to `videos/{videoId}/thumbnail.jpg`, then persist `duration_seconds`, `width`, `height`, `size_bytes`, `metadata`, `thumbnail_key` and `status = ready` in a single update (per `phase-03-videos/TD-13`)
- Make the handler idempotent: re-running for an already-processed video overwrites the same derived fields rather than duplicating work, as at-least-once delivery requires
- Clean the temporary files in a `finally`, on both the success and the failure path
- On `ffprobe` rejection or a missing video stream: set `status = failed` with `failure_reason` and **delete the stored object** (per `phase-03-videos/TD-16`), so a rejected upload does not keep consuming storage
- Use `@OnWorkerEvent('failed')` to write `failed` only when `job.attemptsMade` has reached the configured maximum — while attempts remain the video stays `processing` (per `phase-03-videos/TD-09`)

**Dependencies:** SI-03.3, SI-03.4, SI-03.7, SI-03.9

**Acceptance criteria:**

- Integration with real Redis, MinIO and FFmpeg: enqueueing a job for a video whose source is a fixture file drives it to `ready` with duration, resolution and `metadata` populated and the thumbnail present in the bucket
- Integration: a video whose stored object is not a video ends at `failed` with a non-empty `failure_reason`, and the object is gone from the bucket
- Integration: running the same job twice leaves the row in the same state with no duplicate thumbnail object
- Integration: a handler failure with attempts remaining leaves the video in `processing`, not `failed`

---

### SI-03.11 — Worker Container

**Description:** Run the processor as its own container, as the architecture diagram models it — same image and same code as the API, a different entrypoint and FFmpeg installed (per `phase-03-videos/TD-05`).

**Technical actions:**

- Create `src/main.worker.ts` — bootstrap a Nest **application context** (`NestFactory.createApplicationContext`) over a worker module graph that includes config, TypeORM, the queue and the videos processor, and no HTTP listener
- Create `src/worker.module.ts` composing only those modules — the API's controllers and guards are not loaded
- Add `npm run start:worker` (and its watch variant) to `package.json`
- Extend `Dockerfile.dev` to install `ffmpeg` (which provides `ffprobe`) via apt, alongside the existing `procps` and `curl`
- Add the `video-worker` service to `nestjs-project/compose.yaml`: same build context and image as `nestjs-api`, command running the worker entrypoint, the same bind mount, `depends_on` `db`, `redis` and `minio` with `condition: service_healthy`
- Handle `SIGTERM` so the worker closes the BullMQ connection before exiting, letting an in-flight job finish or be requeued rather than stalling

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `docker compose up -d` brings `video-worker` to `running`; `docker compose logs video-worker` shows it connected to the queue with no HTTP port bound
- `docker compose exec video-worker ffprobe -version` and `ffmpeg -version` both succeed
- A video completed through the API reaches `ready` with the API container's worker disabled — the processing was done by the worker container
- `docker compose stop video-worker` exits cleanly, without an unhandled connection error in the logs

---

### SI-03.12 — Streaming and Download Delivery

**Description:** Expose the video for playback and for download. Both are presigned URLs served by the storage, so range requests and `206 Partial Content` come from MinIO and the API never carries a video byte (per `phase-03-videos/TD-08`).

**Technical actions:**

- `GET /videos/:publicId` — return the video's public representation: `publicId`, `title`, `status`, `durationSeconds`, `width`, `height`, and the thumbnail URL when `ready`
- `GET /videos/:publicId/stream` — require `status = ready`, sign a `GetObject` for `source_key` with `DELIVERY_URL_TTL_SECONDS`, and respond `302` with the URL in `Location`
- `GET /videos/:publicId/download` — the same signature with `ResponseContentDisposition: attachment; filename="<sanitized title>.<ext>"`
- Both endpoints resolve the owning channel and reject a video the caller does not own as `404 VIDEO_NOT_FOUND` rather than `403`, so ownership is not probeable by enumeration (per `phase-03-videos/TD-14`)
- Return `409 VIDEO_NOT_READY` when the video exists and is owned by the caller but has not finished processing
- CORS for browser playback comes from the MinIO server setting configured in `compose.yaml` — the per-bucket CORS API is not implemented by MinIO

**Dependencies:** SI-03.10

**Acceptance criteria:**

- E2E: `GET /videos/:publicId/stream` on a `ready` video returns 302 with a `Location` pointing at the storage
- Integration: fetching that URL with `Range: bytes=0-1023` returns `206` with a `Content-Range` header and exactly 1024 bytes — playback does not require the whole file
- Integration: the download URL responds with `Content-Disposition: attachment`
- E2E: a video belonging to another channel returns 404, and a video still `processing` returns 409 `VIDEO_NOT_READY`

---

### SI-03.13 — End-to-End Flow Test

**Description:** One test that walks the whole capability set the phase promises, against real infrastructure, with the processor instantiated in the test's Nest context (per `phase-03-videos/TD-10` and `phase-03-videos/TD-17`).

**Technical actions:**

- Add a small fixture video to `test/fixtures/` — a few seconds, generated with FFmpeg and committed, so the suite has a known duration and resolution to assert on
- Write `test/videos.e2e-spec.ts`: register and confirm a user through the Phase 02 flow → `POST /videos` → upload every part to the presigned URLs → `POST .../upload/complete` → await job completion via `Job.waitUntilFinished(queueEvents, ttl)` instead of polling → assert `ready`, the duration, the thumbnail object, and the unique public URL → request the streaming and download URLs and assert `206` on a ranged fetch
- Set `S3_PUBLIC_ENDPOINT` to the internal host for the suite, since it runs inside the `nestjs-api` container and must reach the URLs it signs (per `phase-03-videos/TD-11`)
- Isolate the suite with a per-run bucket prefix and queue prefix, cleaning both in `afterAll` (per `phase-03-videos/TD-10`)
- Add a second e2e case for the rejection path: upload a non-video payload and assert the video ends at `failed` with a reason and no stored object

**Dependencies:** SI-03.11, SI-03.12

**Acceptance criteria:**

- The full flow passes end to end against the Compose stack, with nothing mocked — MinIO, Redis and FFmpeg are real
- The suite is repeatable: two consecutive runs both pass, leaving no objects or jobs behind
- `npm test -- --runInBand` and `npm run test:e2e` are both green

---

### SI-03.14 — Documentation Update

**Description:** Bring the AI documentation in line with the code the phase delivered. Documentation citing files or behavior that do not exist is an explicit failure condition of the phase.

**Technical actions:**

- Update the root `CLAUDE.md`: replace `**Message Queue** (TBD)` with the decided technology, and describe the videos module, its endpoints, the queue and the worker
- Update `nestjs-project/CLAUDE.md`: add `minio`, `redis` and `video-worker` to the Services list, add their readiness probes to the environment-startup section, and document `npm run start:worker`
- Update `docs/diagrams/software-arch.mermaid`: the queue container is no longer `TBD`
- Update `docs/phases/phase-03-videos/progress.md` with the final per-SI status and test counts
- Re-export the OpenAPI artifact (`npm run openapi:export`) so `openapi.json` includes the new endpoints

**Dependencies:** SI-03.13

**Acceptance criteria:**

- Every file, script and service named in the updated documentation exists in the repository
- `docs/diagrams/software-arch.mermaid` contains no `TBD`
- `openapi.json` lists the six video endpoints

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(12) | unique, not null — the URL identifier (`phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null |
| status | enum | `draft` \| `processing` \| `ready` \| `failed`, not null, default `draft` (`phase-03-videos/TD-09`) |
| content_type | varchar(100) | not null — declared at initiation, signed into the object (`phase-03-videos/TD-16`) |
| source_key | varchar(512) | nullable — `videos/{id}/source{ext}` (`phase-03-videos/TD-02`) |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg`, written by the worker |
| upload_id | varchar(255) | nullable — the multipart `UploadId`, cleared on completion (`phase-03-videos/TD-12`) |
| duration_seconds | int | nullable — populated on `ready` (`phase-03-videos/TD-13`) |
| width | int | nullable |
| height | int | nullable |
| size_bytes | bigint | nullable — declared at initiation, reconciled on `ready` |
| metadata | jsonb | nullable — exactly `{ codec_name, bit_rate, avg_frame_rate, format_name }` (`phase-03-videos/TD-13`) |
| failure_reason | text | nullable — written only when `status = failed` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel` via `channel_id`
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (the worker and the panel both filter by it)

---

### API Contracts

#### POST /videos (SI-03.5)

Creates the draft and opens the multipart upload in one call — the pre-registration the capability requires.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access token}

**Request body:**
- title: string, required — 1 to 255 characters
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`
- sizeBytes: integer, required — greater than 0 and at most 10737418240 (10GB)

**Response 201:**
- publicId: string (12 chars)
- uploadId: string
- partSizeBytes: integer
- parts: array of `{ partNumber: integer, url: string, expiresAt: string (ISO-8601) }`

**Error responses:**
- 400 UNSUPPORTED_VIDEO_TYPE: when `contentType` is outside the allowlist
- 400 FILE_TOO_LARGE: when `sizeBytes` exceeds the configured maximum
- 400 validation error: when the request body fails schema validation
- 401: when no valid access token is present
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel

---

#### GET /videos/:publicId/upload (SI-03.6)

Reports what the storage already holds and re-signs only the missing parts.

**Request headers:**
- Authorization: Bearer {access token}

**Response 200:**
- uploadId: string
- partSizeBytes: integer
- uploadedParts: array of `{ partNumber: integer, sizeBytes: integer }`
- missingParts: array of `{ partNumber: integer, url: string, expiresAt: string (ISO-8601) }`

**Error responses:**
- 401: when no valid access token is present
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another channel
- 409 UPLOAD_NOT_IN_PROGRESS: when the video is not a draft with an open multipart upload

---

#### POST /videos/:publicId/upload/complete (SI-03.8)

**Request headers:**
- Authorization: Bearer {access token}

**Request body:** empty — the part list is read from the storage via `ListParts`, not from the client (`phase-03-videos/TD-04`)

**Response 200:**
- publicId: string
- status: string — always `processing` on success

**Error responses:**
- 401: when no valid access token is present
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another channel
- 409 UPLOAD_NOT_IN_PROGRESS: when the video is not a draft with an open multipart upload
- 409 UPLOAD_INCOMPLETE: when fewer parts are stored than the declared size requires

---

#### GET /videos/:publicId (SI-03.12)

**Request headers:**
- Authorization: Bearer {access token}

**Response 200:**
- publicId: string
- title: string
- status: string — `draft` \| `processing` \| `ready` \| `failed`
- durationSeconds: integer or null
- width: integer or null
- height: integer or null
- thumbnailUrl: string or null — presigned, present only when `ready`
- failureReason: string or null — present only when `failed`

**Error responses:**
- 401: when no valid access token is present
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another channel

---

#### GET /videos/:publicId/stream (SI-03.12)

**Request headers:**
- Authorization: Bearer {access token}

**Response 302:** `Location` carries a presigned `GetObject` URL for `source_key`, valid for 900 seconds. Range requests and `206 Partial Content` are answered by the storage (`phase-03-videos/TD-08`).

**Error responses:**
- 401: when no valid access token is present
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another channel
- 409 VIDEO_NOT_READY: when the video exists but has not finished processing

---

#### GET /videos/:publicId/download (SI-03.12)

**Request headers:**
- Authorization: Bearer {access token}

**Response 302:** `Location` carries the same presigned URL with `ResponseContentDisposition: attachment; filename="{sanitized title}.{ext}"`.

**Error responses:**
- 401: when no valid access token is present
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another channel
- 409 VIDEO_NOT_READY: when the video exists but has not finished processing

---

#### Validation Rules — video upload

- `title`: required, string, 1–255 characters
- `contentType`: required, must be one of `video/mp4`, `video/webm`, `video/quicktime` (`phase-03-videos/TD-16`)
- `sizeBytes`: required, integer, `> 0`, `<= UPLOAD_MAX_SIZE_BYTES` (default 10737418240)
- `publicId` path parameter: 12 characters from the URL-safe alphabet; anything else is a 404, never a 400 — an invalid id is indistinguishable from a missing one by design

---

### Authorization Matrix

Every endpoint of this phase is authenticated and owner-scoped (`phase-03-videos/TD-14`). The global `JwtAuthGuard` inherited from `phase-02-auth/TD-02` applies; no endpoint carries `@Public()`.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ 401 | ✓ (creates on own channel) | ✓ |
| GET /videos/:publicId | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:publicId/upload | ✗ 401 | ✗ 404 | ✓ |
| POST /videos/:publicId/upload/complete | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:publicId/stream | ✗ 401 | ✗ 404 | ✓ |
| GET /videos/:publicId/download | ✗ 401 | ✗ 404 | ✓ |

A non-owner receives `404`, never `403`: returning `403` would confirm that the id exists, making ownership probeable by enumeration.

**Note on the presigned URL:** authorization is evaluated when the URL is signed, not on each byte. Once issued, the URL is bearer-authorized until it expires — the trade-off recorded in `phase-03-videos/TD-08`, bounded by the 900-second TTL.

---

### Error Catalog

Errors are thrown as `DomainException` subclasses and rendered by the inherited `DomainExceptionFilter` (`phase-02-auth/TD-07`) — this phase extends the existing catalog, it does not introduce a second error shape.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, ou pertencente a outro canal |
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal associado |
| UNSUPPORTED_VIDEO_TYPE | 400 | `contentType` fora da allowlist |
| FILE_TOO_LARGE | 400 | `sizeBytes` acima do limite configurado |
| UPLOAD_NOT_IN_PROGRESS | 409 | Vídeo não está em `draft` com upload multipart aberto |
| UPLOAD_INCOMPLETE | 409 | Conclusão pedida com partes faltando no storage |
| VIDEO_NOT_READY | 409 | Streaming/download de vídeo que ainda não terminou o processamento |

---

### Events/Messages

#### video-processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` on upload completion (per `phase-03-videos/TD-04`)
**Consumer:** `VideoProcessor` running in the `video-worker` container (per `phase-03-videos/TD-05`)
**Trigger:** `CompleteMultipartUpload` succeeded and the video transitioned to `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`) — the handler is idempotent and re-reads the row rather than trusting a denormalized payload, so a redelivery overwrites the same derived fields instead of duplicating work
**Retry policy:** 3 attempts with exponential backoff from 2000ms. While attempts remain the video stays `processing`; only on exhaustion does it become `failed` with `failure_reason` (per `phase-03-videos/TD-09`)
**Queue prefix:** `QUEUE_PREFIX` (default `streamtube`) — producer and consumer must agree, and test suites override it per run for isolation (per `phase-03-videos/TD-10`)

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
├── SI-03.4
│   └── SI-03.7
└── SI-03.9

SI-03.2 (no deps)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5
    ├── SI-03.6
    └── SI-03.8   (also needs SI-03.7)

SI-03.3 + SI-03.4 + SI-03.7 + SI-03.9
└── SI-03.10
    ├── SI-03.11
    └── SI-03.12

SI-03.11 + SI-03.12
└── SI-03.13
    └── SI-03.14
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.7, SI-03.9 (parallel after SI-03.1) → SI-03.5 → SI-03.6, SI-03.8 (parallel) → SI-03.10 → SI-03.11, SI-03.12 (parallel) → SI-03.13 → SI-03.14

Critical path: SI-03.1 → SI-03.4 → SI-03.10 → SI-03.12 → SI-03.13 → SI-03.14.

## Deliverables

- [ ] MinIO, Redis and the video worker running as Compose services alongside the backend
- [ ] `videos` table created by migration, owned by a channel, with a reversible `down()` that drops its enum type
- [ ] Upload of files up to 10GB with no video byte passing through the API (presigned multipart direct to storage)
- [ ] Video pre-registered as `draft` when the upload starts
- [ ] Upload resumable after a dropped connection, with the storage as the source of truth for stored parts
- [ ] Abandoned multipart uploads bounded by a repeatable cleanup job (MinIO does not support the lifecycle rule)
- [ ] Automatic processing after upload: duration, resolution and container metadata extracted with `ffprobe`
- [ ] Thumbnail generated automatically from a frame at 10% of the duration, 1280px wide, stored in the bucket
- [ ] Unique 12-character public URL per video, unique-indexed, stable across title edits
- [ ] Streaming via presigned URL answering `Range` requests with `206 Partial Content` from the storage
- [ ] Download via the same mechanism with `Content-Disposition: attachment`
- [ ] Status lifecycle `draft → processing → ready | failed` reflected in the database, with 3 attempts before `failed`
- [ ] Non-video uploads rejected by `ffprobe` with the stored object deleted
- [ ] Every video endpoint authenticated and owner-scoped, with non-owners receiving 404
- [ ] Error catalog extending the inherited `DomainExceptionFilter` contract
- [ ] Tests exercising real MinIO, Redis and FFmpeg — nothing mocked at the integration/e2e level
- [ ] Root `CLAUDE.md`, `nestjs-project/CLAUDE.md` and the architecture diagram updated (no remaining `TBD` for the queue)
- [ ] `openapi.json` re-exported with the six video endpoints
- [ ] `progress.md` updated with per-SI status and test counts
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`, exit 0)
- [ ] Lint passes on the files this phase adds (`docker compose exec nestjs-api npm run lint`)
