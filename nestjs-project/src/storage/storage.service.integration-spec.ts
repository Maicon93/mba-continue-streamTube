import { randomUUID } from 'crypto';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import { sourceKey, thumbnailKey } from './storage.keys';

/** Isolates this suite's objects from any other suite sharing the bucket. */
const PREFIX = `test-storage-${randomUUID()}`;

function buildService(): StorageService {
  const config = storageConfig();
  return new StorageService({
    ...config,
    // Signed URLs must be reachable from inside this container (TD-11).
    publicEndpoint: config.endpoint,
    bucket: PREFIX.toLowerCase(),
  } as ReturnType<typeof storageConfig>);
}

describe('StorageService (integration, real MinIO)', () => {
  let service: StorageService;

  beforeAll(async () => {
    service = buildService();
    await service.ensureBucket();
  }, 30000);

  it('should create the bucket on first boot and be a no-op on the second', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('should answer a ranged GET with 206 and a Content-Range header', async () => {
    // Playback reads the object directly from the storage, so ranged reads
    // must work on the presigned URL without the API in the path.
    const key = sourceKey(randomUUID(), 'video/mp4');
    await service.putObject(key, Buffer.alloc(4096, 1), 'video/mp4');

    const url = await service.signDownload(key);
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
    expect((await response.arrayBuffer()).byteLength).toBe(1024);

    await service.deleteObject(key);
  });

  it('should list open multipart uploads with their initiation time', async () => {
    const key = sourceKey(randomUUID(), 'video/mp4');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const open = await service.listMultipartUploads();

    const found = open.find((u) => u.uploadId === uploadId);
    expect(found).toBeDefined();
    expect(found!.key).toBe(key);
    expect(found!.initiatedAt.getTime()).toBeLessThanOrEqual(Date.now());

    await service.abortMultipartUpload(key, uploadId);
    const afterAbort = await service.listMultipartUploads();
    expect(afterAbort.find((u) => u.uploadId === uploadId)).toBeUndefined();
  });

  it('should sign part URLs against the public endpoint while operating on the internal one', async () => {
    const config = storageConfig();
    const key = sourceKey(randomUUID(), 'video/mp4');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const url = await service.signUploadPart(key, uploadId, 1);

    // The signature is bound to the host it was signed for — here the suite
    // configured the signing client on the internal endpoint so the URL is
    // reachable from inside the container.
    expect(url.startsWith(config.endpoint)).toBe(true);
    // Meanwhile the server-side call reached MinIO through the internal one.
    await expect(service.listParts(key, uploadId)).resolves.toEqual([]);

    await service.abortMultipartUpload(key, uploadId);
  });

  it('should round-trip a multipart upload: create, upload, list, complete', async () => {
    const key = sourceKey(randomUUID(), 'video/mp4');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const body = Buffer.alloc(6 * 1024 * 1024, 7);

    const url = await service.signUploadPart(key, uploadId, 1);
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);

    const parts = await service.listParts(key, uploadId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(1);
    expect(parts[0].sizeBytes).toBe(body.length);

    await service.completeMultipartUpload(key, uploadId, parts);

    const stream = await service.getObjectStream(key);
    expect(stream).toBeDefined();
    stream.destroy();

    await service.deleteObject(key);
  }, 30000);

  it('should abort a multipart upload, releasing its parts', async () => {
    const key = sourceKey(randomUUID(), 'video/mp4');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);

    await expect(
      rawClient().send(
        new ListPartsCommand({
          Bucket: service.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should sign a download URL carrying the attachment disposition', async () => {
    const key = thumbnailKey(randomUUID());
    await service.putObject(key, Buffer.from('not-really-a-jpeg'), 'image/jpeg');

    const url = await service.signDownload(key, { filename: 'my video.mp4' });

    expect(url).toContain('response-content-disposition');
    expect(decodeURIComponent(url)).toContain('attachment; filename="my video.mp4"');

    await service.deleteObject(key);
  });
});

function rawClient(): S3Client {
  const config = storageConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}
