// src/workers/notification.worker.ts
// Notification dispatch. v1 persists in-app notifications; email/push providers
// slot in here later without touching enqueue sites.
import type { Sql } from 'postgres';
import type { NotificationJob } from '../types/index.js';

export async function processNotificationJob(sql: Sql, job: NotificationJob): Promise<void> {
  // Lazily create the notifications table so the worker is self-sufficient
  // (kept out of core migrations because it's a worker-owned concern).
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    INSERT INTO notifications (recipient_id, type, payload)
    VALUES (${job.recipientId}, ${job.type}, ${sql.json(job.payload as never)})
  `;
}
