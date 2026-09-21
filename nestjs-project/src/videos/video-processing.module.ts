import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessor } from './video.processor';

/**
 * Consumer side only — deliberately NOT imported by `AppModule`.
 *
 * The API publishes jobs; the worker container consumes them. Keeping the
 * processor out of the API's module graph is what stops FFmpeg from
 * competing with request handling on the same event loop.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [VideoProcessor],
  exports: [VideoProcessor],
})
export class VideoProcessingModule {}
