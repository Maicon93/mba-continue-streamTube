import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bounds the cost of uploads that were started and never finished.
 *
 * MinIO does not support the `AbortIncompleteMultipartUpload` lifecycle
 * action through `PutBucketLifecycle`, so this runs as a repeatable job on
 * the queue the phase already has, and behaves identically on real S3.
 */
@Injectable()
export class AbandonedUploadCleanup {
  private readonly logger = new Logger(AbandonedUploadCleanup.name);

  constructor(
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async run(now: Date = new Date()): Promise<number> {
    const cutoff =
      now.getTime() - this.config.uploadAbortAfterDays * MS_PER_DAY;
    const uploads = await this.storage.listMultipartUploads();

    let aborted = 0;
    for (const upload of uploads) {
      if (upload.initiatedAt.getTime() > cutoff) continue;

      try {
        await this.storage.abortMultipartUpload(upload.key, upload.uploadId);
        aborted++;
      } catch (error) {
        // A background sweep must not die on one bad key; the next run
        // retries it.
        this.logger.error(
          `Failed to abort upload ${upload.uploadId} for ${upload.key}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (aborted > 0) {
      this.logger.log(`Aborted ${aborted} abandoned multipart upload(s)`);
    }
    return aborted;
  }
}
