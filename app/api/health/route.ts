import { getPool } from '@/lib/db/pool';
import { reconcilePendingPayouts } from '@/lib/payments/transaction';

/**
 * Health Check & Zero-Cost Scheduler Trigger (§8.7)
 * 
 * Verifies database connectivity and acts as a periodic heartbeat
 * for keep-alive, lazy state synchronization (tick), and asynchronous
 * payout status reconciliation.
 */
export async function GET() {
  const startTime = Date.now();
  let dbStatus = 'disconnected';
  let dbError: string | null = null;
  let activeGroupsCount = 0;
  let reconciledCount = 0;

  try {
    const pool = getPool();
    const res = await pool.query('SELECT NOW() as now, count(*)::int as active_count FROM groups WHERE status = $1', ['ACTIVE']);
    dbStatus = 'connected';
    activeGroupsCount = res.rows[0]?.active_count || 0;

    try {
      const reconciled = await reconcilePendingPayouts(pool);
      reconciledCount = reconciled.length;
    } catch (recErr: any) {
      // Non-blocking for health check
    }
  } catch (err: any) {
    dbStatus = 'error';
    dbError = err.message;
  }

  const responseBody = {
    status: dbStatus === 'connected' ? 'healthy' : 'degraded',
    service: 'quorum-governance-agent',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    latencyMs: Date.now() - startTime,
    database: {
      status: dbStatus,
      activeGroups: activeGroupsCount,
      error: dbError,
    },
    reconciliation: {
      reconciledPayouts: reconciledCount,
    },
    version: '0.1.0',
  };

  return Response.json(responseBody, {
    status: dbStatus === 'connected' ? 200 : 503,
  });
}
