import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { ALLOWED_CONTENT_TYPES } from '../video.constants';

/** 10GB — the ceiling the phase promises; also enforced against config. */
const MAX_DECLARED_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export class CreateVideoDto {
  @ApiProperty({ example: 'My first upload', minLength: 1, maxLength: 255 })
  @IsString()
  @Length(1, 255)
  title: string;

  @ApiProperty({ enum: ALLOWED_CONTENT_TYPES, example: 'video/mp4' })
  @IsIn(ALLOWED_CONTENT_TYPES as unknown as string[])
  contentType: string;

  @ApiProperty({
    description: 'Size of the file the client is about to upload, in bytes',
    example: 104857600,
    minimum: 1,
    maximum: MAX_DECLARED_SIZE_BYTES,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_DECLARED_SIZE_BYTES)
  sizeBytes: number;
}
