---
libs:
  "bullmq":
    version: "^6.3.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-20"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-20"
  "@aws-sdk/client-s3":
    version: "^3.1136.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-20"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1136.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-20"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T20:16:42-03:00"
---

# Library References — Phase 03 (Videos)

Documentation excerpts fetched via **context7** for the libraries newly pinned by this phase, scoped to the surfaces the TDs actually use. Versions are the ones resolved against the installed toolchain (Node 25.6, NestJS 11, TypeScript 5.7, CommonJS output).

## Libraries NOT added, and why

Recorded here so the decision is not re-litigated at implementation time:

- **`nanoid`** — evaluated for TD-07 and rejected. `nanoid@6` declares `"type": "module"` with no CommonJS entry point, and `nestjs-project` emits CommonJS and runs its suites through `ts-jest` in CommonJS. Adopting it would mean pinning the older dual-format `nanoid@3` or depending on Node's `require(esm)` interop inside the Jest transform. Replaced by `crypto.randomBytes` over an explicit alphabet (see TD-07 Revisions).
- **`fluent-ffmpeg`** — evaluated for TD-06 and rejected (2.1.3, slow maintenance cadence, callback API, second-party typings via `@types/fluent-ffmpeg`). Replaced by `child_process.spawn` of the `ffprobe`/`ffmpeg` binaries, which the worker image must carry either way.
- **`minio`** (the MinIO SDK) — evaluated for TD-02 and rejected: multipart methods are internal (`src/internal/client.ts`) and presigning an individual part goes through the generic `presignedUrl`, whereas the AWS SDK exposes `UploadPartCommand` presigning as a first-class API. See TD-02.
- **`ioredis`** — not declared directly; it arrives as a transitive dependency of `bullmq` and is configured through BullMQ's `connection` option.

## bullmq

**Version:** `^6.3.8` · **context7:** `/taskforcesh/bullmq`

Used by TD-01 (queue), TD-09 (retry/failure policy), TD-10 (prefix isolation in tests) and TD-17 (deterministic completion in tests).

### Retry with exponential backoff (TD-09)

Attempts and backoff are job options, not application code. The job stays retrying while attempts remain; only exhaustion is terminal.

```typescript
import { Queue } from 'bullmq';

const myQueue = new Queue('foo');

await queue.add(
  'test-retry',
  { foo: 'bar' },
  {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
);
```

### Queue prefix (TD-10)

Both `Queue` and `Worker` accept a `prefix` option, and **it must be identical on both sides** — this is the mechanism the test-isolation strategy relies on. Default prefix is `bull`.

### Waiting for a job deterministically (TD-17)

`Job.waitUntilFinished(queueEvents, ttl?)` resolves with the job's return value or rejects with its failure reason, driven by `completed:<jobId>` / `failed:<jobId>` events on a `QueueEvents` instance. It also probes `isFinished()` once, so a job that already completed before the listener attached is still caught. This is what lets the suites assert on processing without polling the database.

### Delivery semantics

At-least-once. The processing handler must be idempotent — re-running against an already-processed video must overwrite the same derived fields rather than duplicate work (TD-09).

## @nestjs/bullmq

**Version:** `^12.0.0` · **context7:** `/nestjs/bull`

Peer dependencies of 12.x — verified compatible with the installed stack:

```
bullmq:         ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0
@nestjs/core:   ^10.0.0 || ^11.0.0 || ^12.0.0
@nestjs/common: ^10.0.0 || ^11.0.0 || ^12.0.0
```

### Root registration

`forRootAsync` is the form to use here, so the Redis host comes from the project's namespaced config factories rather than a literal (inherited convention from phase 01, and the Docker rule requires the service name `redis`).

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: { host: config.get('REDIS_HOST'), port: config.get('REDIS_PORT') },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    },
  }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

### Processor (TD-05, TD-17)

For BullMQ (not legacy Bull), the processor extends `WorkerHost` and implements `process()`. `@OnWorkerEvent` hooks expose the worker lifecycle.

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoJobData>) { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) { /* ... */ }
}
```

Because the processor is a normal Nest provider, the same class runs in the worker container (TD-05) and inside the test's Nest context (TD-17) — no second implementation.

## @aws-sdk/client-s3

**Version:** `^3.1136.0` · **context7:** `/aws/aws-sdk-js-v3`

Used against **MinIO** (TD-02) — `endpoint` plus `forcePathStyle: true`; no AWS service involved.

### Multipart lifecycle (TD-03, TD-04, TD-12)

- `CreateMultipartUploadCommand` — required input `{ Bucket, Key }`; `ContentType` is accepted here, which is where TD-16 binds the declared type to the stored object. Returns `{ Bucket, Key, UploadId }` — the `UploadId` is what TD-12 persists.
- `UploadPartCommand` — required `{ Bucket, Key, PartNumber, UploadId, Body }`; `PartNumber` is 1–10000 (10GB in 10MB parts = 1024 parts, well inside the ceiling). Returns the `ETag` needed to complete.
- `ListPartsCommand` — the authoritative list of stored parts; TD-04 builds the completion list from it and TD-12 answers resumption from it.
- `CompleteMultipartUploadCommand` / `AbortMultipartUploadCommand` — close or discard the upload.

### Download-shaping on GetObject (TD-08)

`GetObjectRequest` carries `ResponseContentDisposition` (also `ResponseContentType`), which is how the download URL differs from the streaming URL by one field instead of by a separate endpoint.

```typescript
export interface GetObjectRequest {
  Bucket: string | undefined;
  Key: string | undefined;
  ResponseContentDisposition?: string | undefined;
  ResponseContentType?: string | undefined;
  // ...
}
```

### Lifecycle rule (TD-15)

`PutBucketLifecycleConfigurationCommand` with an `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }` rule, applied once at bucket bootstrap.

## @aws-sdk/s3-request-presigner

**Version:** `^3.1136.0` · **context7:** `/aws/aws-sdk-js-v3`

### Signing a command (TD-03, TD-08, TD-11)

```javascript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client(clientParams);
const command = new GetObjectCommand(getObjectParams);
const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` defaults to 900 seconds when omitted — TD-08's 15-minute delivery TTL happens to be that default, and TD-03's 1-hour part URLs must set it explicitly.

The same call signs `UploadPartCommand` for the per-part upload URLs of TD-03.

**TD-11 note:** SigV4 signs the `Host` header (it is part of the canonical request and appears in `SignedHeaders`), so the URL is only valid for the host it was signed against. This is why the presigner is constructed from a client configured with `S3_PUBLIC_ENDPOINT`, while every server-side command goes through the client configured with `S3_ENDPOINT`.
