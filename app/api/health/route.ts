import { getPool } from '@/lib/db/pool';

/**
 * Health Check & Zero-Cost Scheduler Trigger (§8.7)
 * 
 * Verifies database connectivity and acts as a periodic heartbeat
 * for keep-alive and lazy state synchronization (tick).
 */
export async function GET() {
  const startTime = Date.now();
  let dbStatus = 'disconnected';
  let dbError: string | null = null;
  let activeGroupsCount = 0;

  try {
    const pool = getPool();
    const res = await pool.query('SELECT NOW() as now, count(*)::int as active_count FROM groups WHERE status = $1', ['ACTIVE']);
    dbStatus = 'connected';
    activeGroupsCount = res.rows[0]?.active_count || 0;
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
    version: '0.1.0',
  };

  return Response.json(responseBody, {
    status: dbStatus === 'connected' ? 200 : 503,
  });
}
