import { spawn } from 'child_process';

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    /** A timeout is an environment problem, so it is worth retrying; a
     * non-zero exit on a readable file usually is not. */
    public readonly timedOut: boolean = false,
  ) {
    super(
      `${command} exited with ${exitCode ?? 'no code'}: ${stderr.trim().slice(0, 500)}`,
    );
    this.name = 'FfmpegError';
  }
}

/**
 * Runs a binary to completion under a hard timeout.
 *
 * The timeout is not optional: a hung probe would otherwise sit there until
 * the job lock expires, consuming one of the processing attempts without ever
 * producing a failure.
 */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new FfmpegError(
            command,
            code,
            `timed out after ${timeoutMs}ms`,
            true,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(new FfmpegError(command, code, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
