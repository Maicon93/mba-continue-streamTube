/**
 * Only the id travels: the worker re-reads the row, which is what keeps the
 * handler idempotent under BullMQ's at-least-once delivery.
 */
export interface VideoJobData {
  videoId: string;
}
