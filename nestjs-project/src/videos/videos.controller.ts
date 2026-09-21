import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResponseDto,
  CreateVideoResponseDto,
  UploadStatusResponseDto,
  VideoResponseDto,
} from './dto/video-upload.response';

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a video draft and start its upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload, returning one presigned URL per part. The file is uploaded directly to the object storage — it never passes through the API.',
  })
  @ApiResponse({ status: 201, type: CreateVideoResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorEnvelope })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':publicId/upload')
  @ApiOperation({
    summary: 'Inspect an upload in progress',
    description:
      'Returns the parts the storage already holds and fresh presigned URLs for the ones still missing, so an interrupted upload can be resumed.',
  })
  @ApiResponse({ status: 200, type: UploadStatusResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async uploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadStatusResponseDto> {
    return this.videosService.getUploadStatus(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish the upload and queue the video for processing',
    description:
      'Completes the multipart upload using the part list read from the storage, then enqueues the processing job.',
  })
  @ApiResponse({ status: 200, type: CompleteUploadResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId);
  }

  @Get(':publicId')
  @ApiOperation({ summary: 'Read a video and its processing state' })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.findForViewer(user.sub, publicId);
  }

  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Get the playback URL',
    description:
      'Redirects to a short-lived presigned URL. The player issues range requests straight at the storage, which answers 206 Partial Content — the API never carries video bytes.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.getStreamUrl(user.sub, publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Get the download URL',
    description:
      'Same presigned mechanism as streaming, with a content disposition that makes the browser save the file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.getDownloadUrl(user.sub, publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Delete(':publicId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a video',
    description:
      'Aborts an upload still in progress so its parts are released immediately instead of waiting for the cleanup job.',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.deleteDraft(user.sub, publicId);
  }
}
