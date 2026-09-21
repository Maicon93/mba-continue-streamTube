import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NotAVideoError, probe } from './ffprobe';
import { extractThumbnail } from './thumbnail';
import { FfmpegError, runCommand } from './spawn';

const FIXTURE = join(__dirname, '../../../test/fixtures/sample.mp4');
const TIMEOUT_MS = 30000;

describe('ffmpeg wrappers (integration, real binaries)', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('should read duration, resolution and container metadata', async () => {
      const result = await probe(FIXTURE, TIMEOUT_MS);

      expect(result.durationSeconds).toBe(5);
      expect(result.width).toBe(640);
      expect(result.height).toBe(360);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.codecName).toBe('h264');
      expect(result.formatName).toContain('mp4');
      expect(result.avgFrameRate).toBe('25/1');
    });

    it('should reject a file that is not a video', async () => {
      const notAVideo = join(workDir, 'fake.mp4');
      await writeFile(notAVideo, 'this is plain text, not a video');

      // An undecodable container is a verdict about the file, not a
      // transient failure — it must not be retried by the job.
      await expect(probe(notAVideo, TIMEOUT_MS)).rejects.toThrow(
        NotAVideoError,
      );
    });

    it('should reject a media file with no video stream', async () => {
      const audioOnly = join(workDir, 'audio.mp4');
      await runCommand(
        'ffmpeg',
        [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:a',
          'aac',
          '-y',
          audioOnly,
        ],
        TIMEOUT_MS,
      );

      await expect(probe(audioOnly, TIMEOUT_MS)).rejects.toThrow(
        NotAVideoError,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('should write a JPEG scaled to the configured width', async () => {
      const output = join(workDir, 'thumb.jpg');

      await extractThumbnail(FIXTURE, output, 5, TIMEOUT_MS);

      const written = await stat(output);
      expect(written.size).toBeGreaterThan(0);

      const probed = await probe(output, TIMEOUT_MS);
      expect(probed.width).toBe(1280);
      // -2 keeps the height even.
      expect(probed.height % 2).toBe(0);
      expect(probed.codecName).toBe('mjpeg');
    });

    it('should fail on a source that is not a video', async () => {
      const notAVideo = join(workDir, 'fake2.mp4');
      await writeFile(notAVideo, 'still not a video');

      await expect(
        extractThumbnail(notAVideo, join(workDir, 'out.jpg'), 1, TIMEOUT_MS),
      ).rejects.toThrow(FfmpegError);
    });
  });

  describe('runCommand', () => {
    it('should flag a timeout as retryable rather than as a bad file', async () => {
      await expect(probe(FIXTURE, 1)).rejects.toMatchObject({
        name: 'FfmpegError',
        timedOut: true,
      });
    });

    it('should kill a command that exceeds the timeout', async () => {
      // A hung probe must fail rather than silently burn a job attempt.
      await expect(runCommand('sleep', ['10'], 200)).rejects.toThrow(
        /timed out after 200ms/,
      );
    });

    it('should reject with the exit code and stderr on failure', async () => {
      await expect(
        runCommand('ffprobe', ['/nonexistent/file.mp4'], TIMEOUT_MS),
      ).rejects.toThrow(FfmpegError);
    });
  });
});
