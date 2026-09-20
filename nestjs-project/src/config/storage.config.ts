import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /** Reached by the API and the worker from inside the Docker network. */
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  /**
   * Used only to sign URLs that leave the backend. SigV4 signs the Host
   * header, so a URL signed for `minio:9000` is rejected when a browser
   * outside the Docker network calls it on another host.
   */
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY || '',
  secretKey: process.env.S3_SECRET_KEY || '',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '10485760',
    10,
  ),
  uploadMaxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(process.env.UPLOAD_URL_TTL_SECONDS || '3600', 10),
  deliveryUrlTtlSeconds: parseInt(
    process.env.DELIVERY_URL_TTL_SECONDS || '900',
    10,
  ),
  uploadAbortAfterDays: parseInt(process.env.UPLOAD_ABORT_AFTER_DAYS || '7', 10),
}));
