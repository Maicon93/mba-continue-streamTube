import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { AbandonedUploadCleanup } from './queue/abandoned-upload-cleanup';
import { VideoProcessingModule } from './videos/video-processing.module';

/**
 * The worker's module graph: no controllers, no guards, no HTTP layer —
 * just what is needed to consume the queue and process videos.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    QueueModule,
    StorageModule,
    VideoProcessingModule,
  ],
  providers: [AbandonedUploadCleanup],
})
export class WorkerModule {}
