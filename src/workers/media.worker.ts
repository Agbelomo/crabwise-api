/**
 * Image processing worker.
 *
 * Consumes `image-processing` jobs: downloads the original from S3, uses
 * `sharp` to generate a thumbnail and a WebP variant, uploads each as its
 * own S3 object, and records them as `Media` rows pointing back at the
 * original via `variantOfId`.
 *
 * Any failure inside `processImage` — a bad original, a `sharp` conversion
 * error, an S3 upload failure, or a Prisma persistence failure — is caught,
 * logged with context, and re-thrown so BullMQ marks the job as failed and
 * the queue receives the failure (retry/backoff and dead-letter handling
 * then apply instead of the job silently vanishing).
 *
 * Retries are safe (#96). Variant object keys are deterministic (derived from
 * the original id and variant label) and `Media.key` is unique, so a retried
 * job overwrites the same S3 objects and upserts the same rows instead of
 * accumulating duplicate variants. This also lets a retry converge after a
 * partial failure (thumbnail persisted, WebP write failed).
 */

import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';

import { env } from '@/config';
import { prisma } from '@/services';
import { buildObjectKey, downloadObjectBuffer, uploadObjectBuffer } from '@/services/s3.service';
import { logger } from '@/utils';

import { IMAGE_PROCESSING_QUEUE_NAME, type ImageProcessingJobData } from '../queues/media.queue';

const THUMBNAIL_WIDTH_PX = 300;
const WEBP_QUALITY = 80;

async function upsertVariant(
  original: { id: string; userId: string; key: string },
  label: 'thumbnail' | 'webp',
  buffer: Buffer,
  mimeType: string,
  extension: string,
  width: number | null,
  height: number | null,
): Promise<void> {
  const key = buildObjectKey(
    original.userId,
    `images/variants/${label}`,
    `${original.id}.${extension}`,
  );
  await uploadObjectBuffer(key, buffer, mimeType);

  // The key is deterministic per (original, label) and unique in `Media`, so
  // a repeated job must update the existing variant row rather than insert a
  // second one. Using `create` here would hit the unique constraint on retry
  // — leaving a half-persisted variant set and failing every subsequent
  // attempt forever.
  await prisma.media.upsert({
    where: { key },
    create: {
      userId: original.userId,
      type: 'IMAGE',
      bucket: env.s3Bucket ?? '',
      key,
      mimeType,
      size: BigInt(buffer.byteLength),
      width: width ?? null,
      height: height ?? null,
      variantOfId: original.id,
      variantLabel: label,
    },
    update: {
      userId: original.userId,
      type: 'IMAGE',
      bucket: env.s3Bucket ?? '',
      mimeType,
      size: BigInt(buffer.byteLength),
      width: width ?? null,
      height: height ?? null,
      variantOfId: original.id,
      variantLabel: label,
    },
  });
}

export async function processImage(job: Job<ImageProcessingJobData>): Promise<void> {
  const { mediaId } = job.data;

  try {
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    if (media === null || media.type !== 'IMAGE') {
      logger.warn('Skipping image processing: media not found or not an image', { mediaId });
      return;
    }

    const original = await downloadObjectBuffer(media.key);

    const thumbnail = await sharp(original)
      .resize({ width: THUMBNAIL_WIDTH_PX, withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    await upsertVariant(
      media,
      'thumbnail',
      thumbnail.data,
      media.mimeType,
      'jpg',
      thumbnail.info.width,
      thumbnail.info.height,
    );

    const webp = await sharp(original)
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    await upsertVariant(
      media,
      'webp',
      webp.data,
      'image/webp',
      'webp',
      webp.info.width,
      webp.info.height,
    );

    logger.info('Image processing complete', { mediaId });
  } catch (error) {
    // Log with job context, then re-throw so BullMQ marks the job as failed
    // and the queue receives the failure. Without this re-throw the job
    // would be treated as silently completed and no retry would happen.
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Image processing failed; surfacing to queue as a job failure', {
      mediaId,
      jobId: job.id,
      message,
    });
    throw error;
  }
}

/** Started from `src/index.ts` alongside the HTTP server. No-op without `REDIS_URL`. */
export function startMediaWorker(): Worker<ImageProcessingJobData> | undefined {
  if (env.redisUrl === undefined) {
    logger.warn('Image processing worker not started (no REDIS_URL)');
    return undefined;
  }

  // BullMQ builds its own client from these options (see media.queue.ts).
  const connection = { url: env.redisUrl, maxRetriesPerRequest: null };
  const worker = new Worker<ImageProcessingJobData>(IMAGE_PROCESSING_QUEUE_NAME, processImage, {
    connection,
  });

  worker.on('failed', (job, err) => {
    logger.error('Image processing job failed', {
      mediaId: job?.data.mediaId,
      jobId: job?.id,
      message: err.message,
    });
  });

  return worker;
}
