/**
 * Test suites run inside the `nestjs-api` container, which cannot resolve the
 * public endpoint a presigned URL would normally be signed for (SigV4 signs
 * the Host header, so rewriting the host afterwards invalidates the
 * signature). Point the signing endpoint at the internal one so the URLs the
 * suite receives are reachable from where the suite runs.
 *
 * This is the configuration seam TD-11 exists for: the code path is
 * identical, only the host differs — which is the whole point of having the
 * public endpoint be a separate variable.
 */
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
