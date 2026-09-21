import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { AbandonedUploadCleanup } from './queue/abandoned-upload-cleanup';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Application context, not an HTTP server: the worker binds no port. It is
 * the same codebase as the API with a different entrypoint, so the entity
 * and repository definitions are shared rather than duplicated.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const cleanup = app.get(AbandonedUploadCleanup);
  const timer = setInterval(() => {
    void cleanup.run().catch((error: unknown) => {
      logger.error(
        'Abandoned upload cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }, CLEANUP_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    logger.log(`${signal} received, closing the worker`);
    clearInterval(timer);
    // Lets BullMQ finish or requeue the job in flight before the process dies.
    void app.close().then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.log('Video worker started — consuming the processing queue');
}

void bootstrap();
