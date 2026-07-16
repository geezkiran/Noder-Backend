// src/workers/index.ts
// Standalone Bull worker process: `npm run worker`.
// Processes: embedding generation, layout rebalancing, notification dispatch.
import 'dotenv/config';
import Bull from 'bull';
import postgres from 'postgres';
import { config } from '../config.js';
import { QUEUE_NAMES } from '../services/queue.js';
import type { EmbeddingJob, NotificationJob, RebalanceJob } from '../types/index.js';
import { processEmbeddingJob } from './embedding.worker.js';
import { processRebalanceJob } from './rebalance.worker.js';
import { processNotificationJob } from './notification.worker.js';

const sql = postgres(config.databaseUrl, { max: 5, onnotice: () => {} });

const embeddingQueue = new Bull<EmbeddingJob>(QUEUE_NAMES.embedding, config.redisUrl);
const rebalanceQueue = new Bull<RebalanceJob>(QUEUE_NAMES.rebalance, config.redisUrl);
const notificationQueue = new Bull<NotificationJob>(QUEUE_NAMES.notification, config.redisUrl);

void embeddingQueue.process(2, async (job) => processEmbeddingJob(sql, job.data));
void rebalanceQueue.process(1, async (job) => processRebalanceJob(sql, job.data));
void notificationQueue.process(4, async (job) => processNotificationJob(sql, job.data));

for (const queue of [embeddingQueue, rebalanceQueue, notificationQueue]) {
  queue.on('completed', (job) => {
    console.log(`[${queue.name}] job ${job.id} completed`);
  });
  queue.on('failed', (job, err) => {
    console.error(`[${queue.name}] job ${job?.id} failed: ${err.message}`);
  });
}

console.log('Noder worker started — queues:', Object.values(QUEUE_NAMES).join(', '));

async function shutdown(): Promise<void> {
  console.log('worker shutting down...');
  await Promise.all([embeddingQueue.close(), rebalanceQueue.close(), notificationQueue.close()]);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
