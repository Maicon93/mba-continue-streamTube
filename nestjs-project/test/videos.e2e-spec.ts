import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { VideoProcessor } from '../src/videos/video.processor';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import type { VideoJobData } from '../src/videos/video-job.types';
import { Job } from 'bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import queueConfig from '../src/config/queue.config';

const FIXTURE_PATH = join(__dirname, 'fixtures/sample.mp4');
const FIXTURE = readFileSync(FIXTURE_PATH);

/** supertest types `res.body` as `any`; these are the shapes we assert on. */
interface PartUrl {
  partNumber: number;
  url: string;
  expiresAt: string;
}
interface CreatedUpload {
  publicId: string;
  uploadId: string;
  partSizeBytes: number;
  parts: PartUrl[];
}
interface UploadStatus {
  uploadId: string;
  uploadedParts: { partNumber: number; sizeBytes: number }[];
  missingParts: PartUrl[];
}
interface VideoView {
  publicId: string;
  title: string;
  status: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
}
interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string;
}
const asCreated = (res: request.Response): CreatedUpload =>
  res.body as CreatedUpload;
const asStatus = (res: request.Response): UploadStatus =>
  res.body as UploadStatus;
const asVideo = (res: request.Response): VideoView => res.body as VideoView;
const asError = (res: request.Response): ErrorEnvelope =>
  res.body as ErrorEnvelope;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessor;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);

    // The processing job is driven from inside the suite rather than waited
    // on across containers: the class under test is the same one the worker
    // container runs, and this removes polling with a timeout from every
    // processing assertion.
    processor = new VideoProcessor(videos, storage, queueConfig());
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Each case registers and logs in a fresh user; the global 10 req/min
    // throttler would otherwise start rejecting midway through the suite.
    throttlerStorage.storage.clear();
  });

  async function login(): Promise<string> {
    const email = `videos-${randomUUID()}@streamtube.test`;
    const password = 'password123';
    // The confirmation token only exists inside the email, so the send is
    // intercepted to read it — the same approach the auth e2e suite uses.
    const authService = app.get(AuthService);
    const mailService = (authService as unknown as { mailService: MailService })
      .mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _nickname: string, t: string) => {
          token = t;
          return Promise.resolve();
        },
      );
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  /** Uploads the fixture through the presigned URLs the API handed out. */
  async function uploadAllParts(
    parts: { partNumber: number; url: string }[],
    body: Buffer = FIXTURE,
  ): Promise<void> {
    for (const part of parts) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(200);
    }
  }

  /** Returns supertest's Test so callers can chain `.expect(...)`. */
  function startUpload(
    accessToken: string,
    overrides: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'My holiday video',
        contentType: 'video/mp4',
        sizeBytes: FIXTURE.length,
        ...overrides,
      });
  }

  /** supertest exposes redirect targets as a loosely typed header bag. */
  const streamLocation = (res: request.Response): string =>
    res.headers.location;

  const runJob = async (videoId: string): Promise<void> =>
    processor.process({
      data: { videoId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<VideoJobData>);

  describe('the full upload → process → watch flow', () => {
    it('should upload, process and deliver the video', async () => {
      const accessToken = await login();

      // 1. Draft is pre-registered and the multipart upload is opened.
      const created = await startUpload(accessToken).expect(201);
      const { publicId, parts, uploadId } = asCreated(created);
      expect(publicId).toHaveLength(12);
      expect(uploadId).toBeTruthy();
      expect(parts).toHaveLength(1);

      const draft = await videos.findOneByOrFail({ public_id: publicId });
      expect(draft.status).toBe(VideoStatus.Draft);

      // 2. The bytes go straight to the storage, never through the API.
      await uploadAllParts(parts);

      // 3. Completion transitions to processing and enqueues the job.
      const completed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(asCreated(completed as unknown as request.Response)).toBeDefined();
      expect((completed.body as { status: string }).status).toBe('processing');

      // 4. The worker extracts metadata and the thumbnail.
      await runJob(draft.id);

      const ready = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const view = asVideo(ready);
      expect(view.status).toBe('ready');
      expect(view.durationSeconds).toBe(5);
      expect(view.width).toBe(640);
      expect(view.height).toBe(360);
      expect(view.thumbnailUrl).toContain('thumbnail.jpg');

      // 5. Streaming: the storage answers the range, not the API.
      const stream = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(302);

      const ranged = await fetch(streamLocation(stream), {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${FIXTURE.length}`,
      );
      expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

      // 6. Download: same object, saved instead of played.
      const download = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(302);

      const downloaded = await fetch(streamLocation(download));
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect((await downloaded.arrayBuffer()).byteLength).toBe(FIXTURE.length);
    }, 120000);

    it('should give every video a distinct public URL', async () => {
      const accessToken = await login();
      const first = await startUpload(accessToken).expect(201);
      const second = await startUpload(accessToken).expect(201);

      expect(asCreated(first).publicId).not.toBe(asCreated(second).publicId);
      expect(asCreated(first).publicId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    }, 60000);
  });

  describe('resumption', () => {
    it('should report stored parts and re-sign only the missing ones', async () => {
      const accessToken = await login();
      // Four parts: small enough to upload, large enough to leave gaps.
      const partSize = Number(process.env.UPLOAD_PART_SIZE_BYTES ?? 10485760);
      const created = await startUpload(accessToken, {
        sizeBytes: partSize * 3 + 10,
      }).expect(201);
      const { publicId, parts } = asCreated(created);
      expect(parts).toHaveLength(4);

      // Upload parts 1 and 3 only; each must be at least 5MB except the last.
      const chunk = Buffer.alloc(partSize, 9);
      for (const partNumber of [1, 3]) {
        const part = parts.find((p) => p.partNumber === partNumber)!;
        const res = await fetch(part.url, {
          method: 'PUT',
          body: new Uint8Array(chunk),
        });
        expect(res.status).toBe(200);
      }

      const status = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const resumed = asStatus(status);
      expect(resumed.uploadedParts.map((p) => p.partNumber)).toEqual([1, 3]);
      expect(resumed.missingParts.map((p) => p.partNumber)).toEqual([2, 4]);
      expect(resumed.missingParts[0].url).toBeTruthy();
    }, 120000);

    it('should refuse completion while parts are missing, keeping the draft resumable', async () => {
      const accessToken = await login();
      const partSize = Number(process.env.UPLOAD_PART_SIZE_BYTES ?? 10485760);
      const created = await startUpload(accessToken, {
        sizeBytes: partSize * 2,
      }).expect(201);
      const { publicId, parts } = asCreated(created);

      await uploadAllParts([parts[0]], Buffer.alloc(partSize, 1));

      const failed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(asError(failed).error).toBe('UPLOAD_INCOMPLETE');

      const still = await videos.findOneByOrFail({ public_id: publicId });
      expect(still.status).toBe(VideoStatus.Draft);
      expect(still.upload_id).toBeTruthy();
    }, 120000);
  });

  describe('rejection of a non-video upload', () => {
    it('should mark it failed and delete the stored object', async () => {
      const accessToken = await login();
      const created = await startUpload(accessToken, { sizeBytes: 64 }).expect(
        201,
      );
      const { publicId, parts } = asCreated(created);

      await uploadAllParts(parts, Buffer.from('this is not a video at all'));
      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const video = await videos.findOneByOrFail({ public_id: publicId });
      await runJob(video.id);

      const rejected = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(asVideo(rejected).status).toBe('failed');
      expect(asVideo(rejected).failureReason).toBeTruthy();

      const stored = await videos.findOneByOrFail({ public_id: publicId });
      await expect(
        storage.getObjectStream(stored.source_key!),
      ).rejects.toThrow();
    }, 120000);
  });

  describe('validation and authorization', () => {
    it('should reject a content type outside the allowlist', async () => {
      const accessToken = await login();
      const res = await startUpload(accessToken, {
        contentType: 'application/zip',
      }).expect(400);
      expect(asError(res).message).toBeTruthy();
    });

    it('should reject a declared size above the 10GB ceiling', async () => {
      const accessToken = await login();
      const res = await startUpload(accessToken, {
        sizeBytes: 11 * 1024 * 1024 * 1024,
      }).expect(400);
      expect(asError(res).message).toBeTruthy();
    });

    it('should reject an unauthenticated upload', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'x', contentType: 'video/mp4', sizeBytes: 100 })
        .expect(401);
    });

    it('should report another channel video as not found, never as forbidden', async () => {
      const owner = await login();
      const stranger = await login();
      const created = await startUpload(owner).expect(201);

      // 404 and not 403: a 403 would confirm the id exists.
      const res = await request(app.getHttpServer())
        .get(`/videos/${asCreated(created).publicId}`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);
      expect(asError(res).error).toBe('VIDEO_NOT_FOUND');
    }, 60000);

    it('should refuse to stream a video that has not finished processing', async () => {
      const accessToken = await login();
      const created = await startUpload(accessToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${asCreated(created).publicId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(asError(res).error).toBe('VIDEO_NOT_READY');
    }, 60000);
  });

  describe('deleting a draft', () => {
    it('should abort the multipart upload so its parts are released', async () => {
      const accessToken = await login();
      const created = await startUpload(accessToken).expect(201);
      const { publicId } = asCreated(created);
      const video = await videos.findOneByOrFail({ public_id: publicId });

      await request(app.getHttpServer())
        .delete(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      await expect(
        storage.listParts(video.source_key!, video.upload_id!),
      ).rejects.toThrow();
      await expect(
        videos.findOneBy({ public_id: publicId }),
      ).resolves.toBeNull();
    }, 60000);
  });
});
