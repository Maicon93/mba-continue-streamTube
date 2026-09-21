import { randomBytes } from 'crypto';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH } from './video.constants';

/**
 * A short, URL-safe, non-enumerable identifier for the public video URL.
 *
 * The alphabet has exactly 64 characters, so each random byte maps to one
 * character through a 6-bit mask with no modulo bias — no rejection sampling
 * is needed. `nanoid` would do the same job, but it is ESM-only from v4 and
 * this project compiles to CommonJS.
 */
export function generatePublicId(length: number = PUBLIC_ID_LENGTH): string {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) {
    id += PUBLIC_ID_ALPHABET[bytes[i] & 0x3f];
  }
  return id;
}
