import { runCommand } from './spawn';

export const THUMBNAIL_WIDTH = 1280;
/** 10% in: avoids the black or logo frame that often opens a video. */
export const THUMBNAIL_SEEK_RATIO = 0.1;

export async function extractThumbnail(
  sourcePath: string,
  outputPath: string,
  durationSeconds: number,
  timeoutMs: number,
): Promise<void> {
  const seek = Math.max(0, durationSeconds * THUMBNAIL_SEEK_RATIO);

  await runCommand(
    'ffmpeg',
    [
      // -ss before -i seeks by index instead of decoding from the start,
      // which matters on a multi-gigabyte file.
      '-ss',
      seek.toFixed(3),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      // -2 keeps the height even, which JPEG encoders require.
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-q:v',
      '2',
      '-y',
      outputPath,
    ],
    timeoutMs,
  );
}
