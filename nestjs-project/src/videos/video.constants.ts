export const VIDEO_QUEUE_NAME = 'video-processing' as const;

export const PUBLIC_ID_LENGTH = 12;

/** URL-safe alphabet, 64 chars, so a byte maps to a character with no bias. */
export const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' as const;

export const ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};
