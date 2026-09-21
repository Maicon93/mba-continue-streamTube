import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  ChannelNotFoundException,
  FileTooLargeException,
  UnsupportedVideoTypeException,
  UploadIncompleteException,
  UploadNotInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { sourceKey } from '../storage/storage.keys';
import { Video, VideoStatus } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResponseDto,
  CreateVideoResponseDto,
  UploadPartUrlDto,
  UploadStatusResponseDto,
  VideoResponseDto,
} from './dto/video-upload.response';
import { generatePublicId } from './public-id.util';
import {
  ALLOWED_CONTENT_TYPES,
  CONTENT_TYPE_EXTENSIONS,
  VIDEO_QUEUE_NAME,
} from './video.constants';
import type { VideoJobData } from './video-job.types';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_RETRIES = 5;

/** The driver fields TypeORM does not surface on QueryFailedError. */
interface PostgresDriverError {
  code?: string;
  detail?: string;
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as PostgresDriverError | undefined;
  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly channels: ChannelsService,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_QUEUE_NAME)
    private readonly queue: Queue<VideoJobData>,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload. No
   * video byte passes through the API: the client PUTs each part straight to
   * the storage using the returned presigned URLs.
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    if (!ALLOWED_CONTENT_TYPES.includes(dto.contentType as never)) {
      throw new UnsupportedVideoTypeException(dto.contentType);
    }
    if (dto.sizeBytes > this.config.uploadMaxSizeBytes) {
      throw new FileTooLargeException(this.config.uploadMaxSizeBytes);
    }

    const channel = await this.channels.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.insertWithUniquePublicId(channel.id, dto);
    const key = sourceKey(video.id, dto.contentType);
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.contentType,
    );

    video.source_key = key;
    video.upload_id = uploadId;
    await this.videos.save(video);

    return {
      publicId: video.public_id,
      uploadId,
      partSizeBytes: this.config.uploadPartSizeBytes,
      parts: await this.signParts(
        key,
        uploadId,
        this.expectedPartNumbers(dto.sizeBytes),
      ),
    };
  }

  /**
   * Resumption after a dropped connection: the storage is asked what it
   * actually holds, and only the missing parts are signed again.
   */
  async getUploadStatus(
    userId: string,
    publicId: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.findOwned(userId, publicId);
    const { key, uploadId } = this.requireOpenUpload(video);

    const stored = await this.storage.listParts(key, uploadId);
    const storedNumbers = new Set(stored.map((part) => part.partNumber));
    const expected = this.expectedPartNumbers(Number(video.size_bytes));
    const missing = expected.filter((number) => !storedNumbers.has(number));

    return {
      uploadId,
      partSizeBytes: this.config.uploadPartSizeBytes,
      uploadedParts: stored.map((part) => ({
        partNumber: part.partNumber,
        sizeBytes: part.sizeBytes,
      })),
      missingParts: await this.signParts(key, uploadId, missing),
    };
  }

  /**
   * Closes the multipart upload and hands the video to the queue. The part
   * list comes from the storage, not from the request body.
   */
  async completeUpload(
    userId: string,
    publicId: string,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwned(userId, publicId);
    const { key, uploadId } = this.requireOpenUpload(video);

    const stored = await this.storage.listParts(key, uploadId);
    const expected = this.expectedPartNumbers(Number(video.size_bytes));
    if (stored.length !== expected.length) {
      throw new UploadIncompleteException(expected.length, stored.length);
    }

    await this.storage.completeMultipartUpload(key, uploadId, stored);

    // Status first, then enqueue: a job must never observe a draft row.
    video.status = VideoStatus.Processing;
    video.upload_id = null;
    await this.videos.save(video);

    await this.queue.add(VIDEO_QUEUE_NAME, { videoId: video.id });

    return { publicId: video.public_id, status: video.status };
  }

  async findForViewer(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwned(userId, publicId);

    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnailUrl: video.thumbnail_key
        ? await this.storage.signDownload(video.thumbnail_key)
        : null,
      failureReason: video.failure_reason,
    };
  }

  /** Playback: the browser streams from the storage, which answers ranges. */
  async getStreamUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.requireReady(userId, publicId);
    return this.storage.signDownload(video.source_key!, {
      contentType: video.content_type,
    });
  }

  /** Same object, same mechanism — only the disposition differs. */
  async getDownloadUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.requireReady(userId, publicId);
    const extension = CONTENT_TYPE_EXTENSIONS[video.content_type] ?? '';
    return this.storage.signDownload(video.source_key!, {
      filename: `${sanitizeFilename(video.title)}${extension}`,
      contentType: video.content_type,
    });
  }

  async deleteDraft(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwned(userId, publicId);

    if (video.source_key && video.upload_id) {
      await this.storage.abortMultipartUpload(
        video.source_key,
        video.upload_id,
      );
    }
    await this.videos.remove(video);
  }

  private async insertWithUniquePublicId(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_RETRIES; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({
            public_id: generatePublicId(),
            channel_id: channelId,
            title: dto.title,
            content_type: dto.contentType,
            size_bytes: String(dto.sizeBytes),
            status: VideoStatus.Draft,
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt === PUBLIC_ID_MAX_RETRIES) {
          throw err;
        }
      }
    }
    throw new Error('Unreachable: public id retry loop exhausted');
  }

  /**
   * A video owned by another channel is reported as missing, never as
   * forbidden — a 403 would confirm the id exists.
   */
  private async findOwned(userId: string, publicId: string): Promise<Video> {
    const channel = await this.channels.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.videos.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async requireReady(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwned(userId, publicId);
    if (video.status !== VideoStatus.Ready || !video.source_key) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private requireOpenUpload(video: Video): { key: string; uploadId: string } {
    if (
      video.status !== VideoStatus.Draft ||
      !video.upload_id ||
      !video.source_key
    ) {
      throw new UploadNotInProgressException();
    }
    return { key: video.source_key, uploadId: video.upload_id };
  }

  private expectedPartNumbers(sizeBytes: number): number[] {
    const count = Math.max(
      1,
      Math.ceil(sizeBytes / this.config.uploadPartSizeBytes),
    );
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  private async signParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrlDto[]> {
    const expiresAt = new Date(
      Date.now() + this.config.uploadUrlTtlSeconds * 1000,
    ).toISOString();

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.signUploadPart(key, uploadId, partNumber),
        expiresAt,
      })),
    );
  }
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^\w\-. ]+/g, '_').slice(0, 100) || 'video';
}
