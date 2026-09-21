import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_QUEUE_NAME } from './video.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_QUEUE_NAME }),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService, TypeOrmModule],
})
export class VideosModule {}
