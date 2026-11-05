/**
 * Quorum PostgreSQL Database Pool
 * 
 * Provides:
 * - Direct pg.Pool connection supporting interactive row-locking (SELECT ... FOR UPDATE)
 * - Safe transaction runner with automatic BEGIN / COMMIT / ROLLBACK
 * - Support for test-injected clients / in-memory pools (pg-mem)
 */

import pg from 'pg';

const { Pool } = pg;

let globalPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (globalPool) {
    return globalPool;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // When running in an environment without DATABASE_URL, create a dummy or throw helpful error
    throw new Error(
      'DATABASE_URL is not set. For production/Render, set DATABASE_URL (Session pooler: port 5432). For tests, inject a pg-mem pool.'
    );
  }

  globalPool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  return globalPool;
}

export function setPool(pool: pg.Pool): void {
  globalPool = pool;
}

export async function closePool(): Promise<void> {
  if (globalPool) {
    await globalPool.end();
    globalPool = null;
  }
}

/**
 * Runs a callback inside a PostgreSQL transaction (BEGIN ... COMMIT / ROLLBACK)
 */
export async function withTransaction<T>(
  poolOrClient: pg.Pool | pg.PoolClient,
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  let client: pg.PoolClient;
  let shouldRelease = false;

  if ('connect' in poolOrClient && typeof poolOrClient.connect === 'function') {
    client = await poolOrClient.connect();
    shouldRelease = true;
  } else {
    client = poolOrClient as pg.PoolClient;
  }

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Ignore secondary rollback error
    }
    throw error;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}
