// src/workers/rebalance.worker.ts
// layout:rebalance — redistributes node positions inside one dense cluster
// without touching any other cluster's coordinates.
import type { Sql } from 'postgres';
import { LayoutService } from '../services/layout.js';
import type { RebalanceJob } from '../types/index.js';

export async function processRebalanceJob(sql: Sql, job: RebalanceJob): Promise<void> {
  const layout = new LayoutService(sql);
  const moved = await layout.rebalanceCluster(job.hierarchyNodeId);
  console.log(`[layout-rebalance] cluster ${job.hierarchyNodeId}: repositioned ${moved} nodes`);
}
