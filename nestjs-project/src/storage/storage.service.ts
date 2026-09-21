import { Readable } from 'stream';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface StoredPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface OpenMultipartUpload {
  key: string;
  uploadId: string;
  initiatedAt: Date;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  /** Server-side calls: reaches MinIO by its Compose service name. */
  private readonly internalClient: S3Client;

  /**
   * Signing only. SigV4 signs the Host header, so a URL meant for a browser
   * outside the Docker network must be signed against the public endpoint.
   */
  private readonly signingClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.internalClient = this.buildClient(config.endpoint);
    this.signingClient = this.buildClient(config.publicEndpoint);
  }

  private buildClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Idempotent: safe to run on every boot. */
  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;

    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.internalClient.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created bucket ${Bucket}`);
    }

    // No AbortIncompleteMultipartUpload lifecycle rule here: MinIO does not
    // support that action via PutBucketLifecycle (it rejects a rule carrying
    // only the abort action, and silently drops it when paired with an
    // Expiration). Abandoned uploads are cleaned by a repeatable job instead
    // — see the queue module.
    // No PutBucketCors either: MinIO answers NotImplemented for the per-bucket
    // CORS API. It is a server-level setting there (MINIO_API_CORS_ALLOW_ORIGIN,
    // set in compose.yaml), which is what lets a browser issue the ranged GETs
    // that playback depends on.
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`Storage did not return an UploadId for key ${key}`);
    }
    return response.UploadId;
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.uploadUrlTtlSeconds },
    );
  }

  /** The storage is the source of truth for which parts actually exist. */
  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: number | undefined;

    do {
      const response = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker?.toString(),
        }),
      );

      for (const part of response.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          sizeBytes: part.Size ?? 0,
        });
      }

      marker = response.IsTruncated
        ? Number(response.NextPartNumberMarker)
        : undefined;
    } while (marker !== undefined);

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  /** Every multipart upload still open in the bucket, oldest first. */
  async listMultipartUploads(): Promise<OpenMultipartUpload[]> {
    const uploads: OpenMultipartUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    do {
      const response = await this.internalClient.send(
        new ListMultipartUploadsCommand({
          Bucket: this.config.bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of response.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        uploads.push({
          key: upload.Key,
          uploadId: upload.UploadId,
          initiatedAt: upload.Initiated ?? new Date(0),
        });
      }

      keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
      uploadIdMarker = response.IsTruncated
        ? response.NextUploadIdMarker
        : undefined;
    } while (keyMarker !== undefined);

    return uploads.sort(
      (a, b) => a.initiatedAt.getTime() - b.initiatedAt.getTime(),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StoredPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async signDownload(
    key: string,
    options: { filename?: string; contentType?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options.filename && {
          ResponseContentDisposition: `attachment; filename="${options.filename}"`,
        }),
        ...(options.contentType && {
          ResponseContentType: options.contentType,
        }),
      }),
      { expiresIn: this.config.deliveryUrlTtlSeconds },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`Storage returned an empty body for key ${key}`);
    }
    return response.Body as Readable;
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
