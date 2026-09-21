import { CONTENT_TYPE_EXTENSIONS } from '../videos/video.constants';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertVideoId(videoId: string): void {
  if (!UUID_PATTERN.test(videoId)) {
    throw new Error(`Invalid video id for a storage key: ${videoId}`);
  }
}

/**
 * Object keys are derived from the internal uuid — never from `public_id`
 * (which is a URL concern) and never from a user-supplied filename.
 */
export function sourceKey(videoId: string, contentType: string): string {
  assertVideoId(videoId);
  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? '';
  return `videos/${videoId}/source${extension}`;
}

export function thumbnailKey(videoId: string): string {
  assertVideoId(videoId);
  return `videos/${videoId}/thumbnail.jpg`;
}
