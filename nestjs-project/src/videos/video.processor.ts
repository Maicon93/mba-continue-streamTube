import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import { StorageService } from '../storage/storage.service';
import { thumbnailKey } from '../storage/storage.keys';
import { Video, VideoStatus } from './entities/video.entity';
import { NotAVideoError, probe } from './ffmpeg/ffprobe';
import { extractThumbnail } from './ffmpeg/thumbnail';
import { VIDEO_QUEUE_NAME } from './video.constants';
import type { VideoJobData } from './video-job.types';

@Processor(VIDEO_QUEUE_NAME)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  /**
   * Idempotent by construction: the payload carries only the id, the row is
   * re-read, and every derived field is overwritten. A redelivery (BullMQ is
   * at-least-once) therefore converges to the same state.
   */
  async process(job: Job<VideoJobData>): Promise<void> {
    const video = await this.videos.findOne({
      where: { id: job.data.videoId },
    });

    if (!video) {
      // Nothing to retry: the row is gone, so failing the job would just
      // burn attempts on a video that no longer exists.
      this.logger.warn(`Video ${job.data.videoId} no longer exists; skipping`);
      return;
    }
    if (!video.source_key) {
      throw new Error(`Video ${video.id} has no source object to process`);
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${video.id}-`));
    const sourcePath = join(workDir, 'source');
    const thumbPath = join(workDir, 'thumbnail.jpg');

    try {
      await pipeline(
        await this.storage.getObjectStream(video.source_key),
        createWriteStream(sourcePath),
      );

      const probed = await probe(sourcePath, this.config.ffmpegTimeoutMs);

      await extractThumbnail(
        sourcePath,
        thumbPath,
        probed.durationSeconds,
        this.config.ffmpegTimeoutMs,
      );
      const thumbKey = thumbnailKey(video.id);
      await this.storage.putObject(
        thumbKey,
        await readFile(thumbPath),
        'image/jpeg',
      );

      await this.videos.update(video.id, {
        status: VideoStatus.Ready,
        duration_seconds: probed.durationSeconds,
        width: probed.width,
        height: probed.height,
        size_bytes: String(probed.sizeBytes),
        thumbnail_key: thumbKey,
        metadata: {
          codec_name: probed.codecName,
          bit_rate: probed.bitRate,
          avg_frame_rate: probed.avgFrameRate,
          format_name: probed.formatName,
        },
        failure_reason: null,
      });
    } catch (error) {
      if (error instanceof NotAVideoError) {
        // Not retryable: the bytes will not become a video. Mark it now and
        // release the storage instead of burning the remaining attempts.
        await this.markFailed(video, error.message);
        return;
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoJobData>, error: Error): Promise<void> {
    const attemptsLeft = job.attemptsMade < (job.opts.attempts ?? 1);
    if (attemptsLeft) {
      // Still retrying — the video stays `processing`.
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade} failed: ${error.message}`,
      );
      return;
    }

    const video = await this.videos.findOne({
      where: { id: job.data.videoId },
    });
    if (video) {
      await this.markFailed(video, error.message);
    }
  }

  private async markFailed(video: Video, reason: string): Promise<void> {
    this.logger.error(`Video ${video.id} failed: ${reason}`);

    await this.videos.update(video.id, {
      status: VideoStatus.Failed,
      failure_reason: reason,
    });

    // A rejected upload must not keep consuming storage.
    if (video.source_key) {
      try {
        await this.storage.deleteObject(video.source_key);
      } catch (error) {
        this.logger.error(
          `Could not delete the rejected object ${video.source_key}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
