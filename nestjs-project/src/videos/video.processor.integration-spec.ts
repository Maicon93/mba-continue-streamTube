import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { sourceKey, thumbnailKey } from '../storage/storage.keys';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessor } from './video.processor';
import type { VideoJobData } from './video-job.types';

const FIXTURE = join(__dirname, '../../test/fixtures/sample.mp4');
const BUCKET = `test-processor-${randomUUID()}`.toLowerCase();

/** The processor only reads `data`; the rest of Job is irrelevant here. */
const fakeJob = (videoId: string): Job<VideoJobData> =>
  ({ data: { videoId }, attemptsMade: 0, opts: { attempts: 3 } }) as Job<VideoJobData>;

describe('VideoProcessor (integration — real MinIO, real FFmpeg)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessor;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);

    storage = new StorageService({
      ...storageConfig(),
      publicEndpoint: storageConfig().endpoint,
      bucket: BUCKET,
    } as ReturnType<typeof storageConfig>);
    await storage.ensureBucket();

    processor = new VideoProcessor(videos, storage, queueConfig());

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `processor-${randomUUID()}@streamtube.test`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'processor',
        nickname: `processor-${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  }, 60000);

  afterAll(async () => {
    await videos.delete({ channel_id: channelId });
    await dataSource.destroy();
  });

  const seedVideo = async (contentType = 'video/mp4'): Promise<Video> =>
    videos.save(
      videos.create({
        public_id: randomUUID().slice(0, 12),
        channel_id: channelId,
        title: 'Processor fixture',
        content_type: contentType,
        status: VideoStatus.Processing,
      }),
    );

  it('should probe the video, store a thumbnail and mark it ready', async () => {
    const video = await seedVideo();
    const key = sourceKey(video.id, 'video/mp4');
    await storage.putObject(key, await readFile(FIXTURE), 'video/mp4');
    await videos.update(video.id, { source_key: key });

    await processor.process(fakeJob(video.id));

    const processed = await videos.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.Ready);
    expect(processed.duration_seconds).toBe(5);
    expect(processed.width).toBe(640);
    expect(processed.height).toBe(360);
    expect(Number(processed.size_bytes)).toBeGreaterThan(0);
    expect(processed.metadata).toMatchObject({
      codec_name: 'h264',
      avg_frame_rate: '25/1',
    });
    expect(processed.metadata!.format_name).toContain('mp4');
    expect(processed.thumbnail_key).toBe(thumbnailKey(video.id));
    expect(processed.failure_reason).toBeNull();

    const thumb = await storage.getObjectStream(processed.thumbnail_key!);
    expect(thumb).toBeDefined();
    thumb.destroy();
  }, 60000);

  it('should be idempotent — reprocessing converges to the same state', async () => {
    const video = await seedVideo();
    const key = sourceKey(video.id, 'video/mp4');
    await storage.putObject(key, await readFile(FIXTURE), 'video/mp4');
    await videos.update(video.id, { source_key: key });

    await processor.process(fakeJob(video.id));
    const first = await videos.findOneByOrFail({ id: video.id });

    await processor.process(fakeJob(video.id));
    const second = await videos.findOneByOrFail({ id: video.id });

    expect(second.status).toBe(first.status);
    expect(second.duration_seconds).toBe(first.duration_seconds);
    expect(second.thumbnail_key).toBe(first.thumbnail_key);
    expect(second.metadata).toEqual(first.metadata);
  }, 60000);

  it('should fail a non-video object and delete it from the storage', async () => {
    const video = await seedVideo();
    const key = sourceKey(video.id, 'video/mp4');
    await storage.putObject(key, Buffer.from('definitely not a video'), 'video/mp4');
    await videos.update(video.id, { source_key: key });

    await processor.process(fakeJob(video.id));

    const failed = await videos.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.Failed);
    expect(failed.failure_reason).toBeTruthy();

    // The rejected upload must not keep consuming storage.
    await expect(storage.getObjectStream(key)).rejects.toThrow();
  }, 60000);

  it('should skip a job whose video no longer exists', async () => {
    await expect(processor.process(fakeJob(randomUUID()))).resolves.toBeUndefined();
  });

  it('should keep the video processing while retry attempts remain', async () => {
    const video = await seedVideo();

    await processor.onFailed(
      { data: { videoId: video.id }, attemptsMade: 1, opts: { attempts: 3 } } as Job<VideoJobData>,
      new Error('transient'),
    );

    const still = await videos.findOneByOrFail({ id: video.id });
    expect(still.status).toBe(VideoStatus.Processing);
    expect(still.failure_reason).toBeNull();
  });

  it('should mark the video failed once attempts are exhausted', async () => {
    const video = await seedVideo();

    await processor.onFailed(
      { data: { videoId: video.id }, attemptsMade: 3, opts: { attempts: 3 } } as Job<VideoJobData>,
      new Error('storage unreachable'),
    );

    const failed = await videos.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.Failed);
    expect(failed.failure_reason).toContain('storage unreachable');
  });
});
