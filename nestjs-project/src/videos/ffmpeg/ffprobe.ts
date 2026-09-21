import { FfmpegError, runCommand } from './spawn';

/** The subset of `ffprobe -show_format -show_streams` this project reads. */
interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
  size?: string;
  bit_rate?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number;
  codecName: string | null;
  bitRate: string | null;
  avgFrameRate: string | null;
  formatName: string | null;
}

export class NotAVideoError extends Error {
  constructor(reason: string) {
    super(`File is not a decodable video: ${reason}`);
    this.name = 'NotAVideoError';
  }
}

export async function probe(
  filePath: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      timeoutMs,
    ));
  } catch (error) {
    // ffprobe exits non-zero when it cannot decode the container at all.
    // That is a verdict about the file, not a transient failure — surfacing
    // it as NotAVideoError is what stops the job from retrying three times
    // over bytes that will never become a video. A timeout is different:
    // it says nothing about the file, so it propagates as-is and retries.
    if (error instanceof FfmpegError && !error.timedOut) {
      throw new NotAVideoError(`ffprobe could not decode the file`);
    }
    throw error;
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new NotAVideoError('ffprobe returned output that is not JSON');
  }

  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new NotAVideoError('no video stream present');
  }

  const duration = Number(parsed.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new NotAVideoError('no usable duration');
  }

  return {
    durationSeconds: Math.round(duration),
    width: video.width ?? 0,
    height: video.height ?? 0,
    sizeBytes: Number(parsed.format?.size ?? 0),
    codecName: video.codec_name ?? null,
    bitRate: parsed.format?.bit_rate ?? null,
    avgFrameRate: video.avg_frame_rate ?? null,
    formatName: parsed.format?.format_name ?? null,
  };
}

/** Exposed for the thumbnail seek; not rounded, unlike the persisted value. */
export function rawDuration(result: ProbeResult): number {
  return result.durationSeconds;
}
