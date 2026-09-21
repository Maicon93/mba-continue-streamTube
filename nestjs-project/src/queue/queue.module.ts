import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE_NAME } from '../videos/video.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
        defaultJobOptions: {
          attempts: config.videoJobAttempts,
          backoff: { type: 'exponential', delay: config.videoJobBackoffMs },
          removeOnComplete: true,
          // Kept for inspection: a failed job is the audit trail behind a
          // video that ended in `failed`.
          removeOnFail: false,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE_NAME }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
