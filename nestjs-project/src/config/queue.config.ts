import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  /**
   * Namespaces every key in Redis. Producer and consumer must agree, and
   * test suites override it per run so they can share one Redis instance.
   */
  prefix: process.env.QUEUE_PREFIX || 'streamtube',
  videoJobAttempts: parseInt(process.env.VIDEO_JOB_ATTEMPTS || '3', 10),
  videoJobBackoffMs: parseInt(process.env.VIDEO_JOB_BACKOFF_MS || '2000', 10),
  ffmpegTimeoutMs: parseInt(process.env.FFMPEG_TIMEOUT_MS || '120000', 10),
}));
