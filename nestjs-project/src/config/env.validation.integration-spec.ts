import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

/** Joi types the validated value as `any`; this is the shape it produces. */
interface ValidatedEnv {
  SWAGGER_ENABLED: string;
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT: string;
  UPLOAD_PART_SIZE_BYTES: number;
  UPLOAD_MAX_SIZE_BYTES: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  QUEUE_PREFIX: string;
  VIDEO_JOB_ATTEMPTS: number;
}

const validate = (
  env: Record<string, string>,
): { value: ValidatedEnv; error?: Error } =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { value: ValidatedEnv; error?: Error };

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (Phase 03)', () => {
  it('should reject a missing S3_ACCESS_KEY', () => {
    const withoutAccessKey = { ...requiredEnv };
    delete (withoutAccessKey as Partial<typeof requiredEnv>).S3_ACCESS_KEY;
    const { error } = envValidationSchema.validate(withoutAccessKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY', () => {
    const withoutSecretKey = { ...requiredEnv };
    delete (withoutSecretKey as Partial<typeof requiredEnv>).S3_SECRET_KEY;
    const { error } = envValidationSchema.validate(withoutSecretKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should default the storage endpoints to the Compose service and the host', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
  });

  it('should default the upload limits to 10MB parts and a 10GB ceiling', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(10485760);
    expect(value.UPLOAD_MAX_SIZE_BYTES).toBe(10737418240);
  });

  it('should default the queue to the redis service with the streamtube prefix', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('streamtube');
    expect(value.VIDEO_JOB_ATTEMPTS).toBe(3);
  });

  it('should reject a non-numeric UPLOAD_MAX_SIZE_BYTES', () => {
    const { error } = validate({ UPLOAD_MAX_SIZE_BYTES: 'not-a-number' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_MAX_SIZE_BYTES');
  });
});
