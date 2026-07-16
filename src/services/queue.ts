// src/services/queue.ts
// Vendor-abstracted queue layer over Bull. Routes/services call enqueue helpers;
// swapping to QStash later = reimplement this file only (same job interface).
import Bull from 'bull';
import type { Queue } from 'bull';
import { config } from '../config.js';
import type { EmbeddingJob, NotificationJob, RebalanceJob } from '../types/index.js';

export const QUEUE_NAMES = {
  embedding: 'embedding',
  rebalance: 'layout-rebalance',
  notification: 'notification',
} as const;

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 500,
  removeOnFail: 1000,
};

function makeQueue<T>(name: string): Queue<T> {
  return new Bull<T>(name, config.redisUrl, { defaultJobOptions });
}

export class QueueService {
  readonly embedding: Queue<EmbeddingJob>;
  readonly rebalance: Queue<RebalanceJob>;
  readonly notification: Queue<NotificationJob>;

  constructor() {
    this.embedding = makeQueue<EmbeddingJob>(QUEUE_NAMES.embedding);
    this.rebalance = makeQueue<RebalanceJob>(QUEUE_NAMES.rebalance);
    this.notification = makeQueue<NotificationJob>(QUEUE_NAMES.notification);
  }

  async enqueueEmbedding(nodeId: string): Promise<void> {
    // jobId dedupes concurrent re-embeds of the same node
    await this.embedding.add({ nodeId }, { jobId: `embed:${nodeId}:${Date.now()}` });
  }

  async enqueueRebalance(hierarchyNodeId: string): Promise<void> {
    // stable jobId collapses bursts of inserts into one rebalance
    await this.rebalance.add({ hierarchyNodeId }, { jobId: `rebalance:${hierarchyNodeId}`, delay: 5000 });
  }

  async enqueueNotification(job: NotificationJob): Promise<void> {
    await this.notification.add(job);
  }

  async close(): Promise<void> {
    await Promise.all([this.embedding.close(), this.rebalance.close(), this.notification.close()]);
  }
}
