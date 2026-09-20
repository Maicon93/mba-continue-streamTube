import { sourceKey, thumbnailKey } from './storage.keys';

const VIDEO_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('storage keys', () => {
  it('should build the source key with the extension for the content type', () => {
    expect(sourceKey(VIDEO_ID, 'video/mp4')).toBe(
      `videos/${VIDEO_ID}/source.mp4`,
    );
    expect(sourceKey(VIDEO_ID, 'video/webm')).toBe(
      `videos/${VIDEO_ID}/source.webm`,
    );
    expect(sourceKey(VIDEO_ID, 'video/quicktime')).toBe(
      `videos/${VIDEO_ID}/source.mov`,
    );
  });

  it('should build the thumbnail key', () => {
    expect(thumbnailKey(VIDEO_ID)).toBe(`videos/${VIDEO_ID}/thumbnail.jpg`);
  });

  it('should omit the extension for an unknown content type', () => {
    expect(sourceKey(VIDEO_ID, 'video/unknown')).toBe(
      `videos/${VIDEO_ID}/source`,
    );
  });

  it('should reject a video id that is not a uuid', () => {
    // Guards against a user-controlled value reaching an object key.
    expect(() => sourceKey('../../etc/passwd', 'video/mp4')).toThrow();
    expect(() => thumbnailKey('not-a-uuid')).toThrow();
  });
});
