/**
 * Quorum PostgreSQL Database Pool
 * 
 * Provides:
 * - Direct pg.Pool connection supporting interactive row-locking (SELECT ... FOR UPDATE)
 * - Safe transaction runner with automatic BEGIN / COMMIT / ROLLBACK
 * - Support for test-injected clients / in-memory pools (pg-mem)
 */

import pg from 'pg';
import { createTestDb } from './test-db';

const { Pool } = pg;

let globalPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (globalPool) {
    return globalPool;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // In production, direct PostgreSQL connection (Supabase Session Pooler port 5432) is strictly required
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_IN_MEMORY_DB !== 'true') {
      throw new Error(
        'DATABASE_URL is not set. In production, a direct PostgreSQL connection string (Supabase Session Pooler port 5432) is strictly required.'
      );
    }
    console.warn('⚠️ DATABASE_URL is not set. Running in-memory PostgreSQL instance for local development.');
    const testDb = createTestDb();
    globalPool = testDb.pool;
    return globalPool;
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

  if ('totalCount' in poolOrClient || !('release' in poolOrClient)) {
    client = await (poolOrClient as pg.Pool).connect();
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
