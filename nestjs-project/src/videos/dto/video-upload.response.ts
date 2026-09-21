import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned URL to PUT this part directly to the storage' })
  url: string;

  @ApiProperty({ example: '2026-09-20T21:00:00.000Z' })
  expiresAt: string;
}

export class CreateVideoResponseDto {
  @ApiProperty({ example: 'aB3dE6fH9jK2' })
  publicId: string;

  @ApiProperty()
  uploadId: string;

  @ApiProperty({ example: 10485760 })
  partSizeBytes: number;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];
}

export class StoredPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: 10485760 })
  sizeBytes: number;
}

export class UploadStatusResponseDto {
  @ApiProperty()
  uploadId: string;

  @ApiProperty({ example: 10485760 })
  partSizeBytes: number;

  @ApiProperty({ type: [StoredPartDto] })
  uploadedParts: StoredPartDto[];

  @ApiProperty({ type: [UploadPartUrlDto] })
  missingParts: UploadPartUrlDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'aB3dE6fH9jK2' })
  publicId: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'aB3dE6fH9jK2' })
  publicId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ example: 'ready' })
  status: string;

  @ApiProperty({ nullable: true, example: 12 })
  durationSeconds: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true })
  thumbnailUrl: string | null;

  @ApiProperty({ nullable: true })
  failureReason: string | null;
}
