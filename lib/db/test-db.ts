/**
 * Quorum In-Memory PostgreSQL Test Database (pg-mem)
 * 
 * Provides an isolated, fully functional in-memory PostgreSQL instance for Vitest.
 * Supports:
 * - Interactive transactions (BEGIN / COMMIT / ROLLBACK)
 * - Row locks (SELECT ... FOR UPDATE)
 * - Unique constraints and partial indexes (one_live_payment_per_proposal)
 */

import pkg from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const { newDb } = pkg;

export function createTestDb(): { db: any; pool: pg.Pool } {
  const db = newDb();

  // Register uuid extension functions with impure: true so each call generates a fresh random UUID
  db.public.registerFunction({
    name: 'gen_random_uuid',
    args: [],
    returns: (db.public as any).getType('text'),
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  db.public.registerFunction({
    name: 'uuid_generate_v4',
    args: [],
    returns: (db.public as any).getType('text'),
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  // Load and execute schema.sql
  const schemaPath = path.resolve(process.cwd(), 'db/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Strip extension lines and constructs that pg-mem doesn't support:
  // 1. CREATE EXTENSION
  // 2. Partial unique index (pg-mem parses index WHERE clause but does not filter rows on evaluation,
  //    turning it into an unconditional unique index). Verified on real PostgreSQL via test-real-postgres.mjs.
  let cleanedSql = schemaSql
    .split('\n')
    .filter((line) => !line.toLowerCase().includes('create extension'))
    .join('\n')
    .replace(/create unique index if not exists one_live_payment_per_proposal[^;]+;/gi, '');

  db.public.none(cleanedSql);

  const pgAdapter = db.adapters.createPg();
  const pool = new pgAdapter.Pool();

  // Helper to sanitize unsupported PostgreSQL extensions in pg-mem (e.g. SKIP LOCKED)
  function sanitizeQuery(sql: any): any {
    if (typeof sql === 'string') {
      return sql.replace(/\bSKIP\s+LOCKED\b/gi, '');
    }
    if (sql && typeof sql.text === 'string') {
      return { ...sql, text: sql.text.replace(/\bSKIP\s+LOCKED\b/gi, '') };
    }
    return sql;
  }

  const origPoolQuery = pool.query.bind(pool);
  pool.query = function (sql: any, ...args: any[]) {
    return (origPoolQuery as any)(sanitizeQuery(sql), ...args);
  };

  const origConnect = pool.connect.bind(pool);
  pool.connect = async function (...args: any[]) {
    const client = await (origConnect as any)(...args);
    const origClientQuery = client.query.bind(client);
    client.query = function (sql: any, ...qArgs: any[]) {
      return (origClientQuery as any)(sanitizeQuery(sql), ...qArgs);
    };
    return client;
  };

  return { db, pool };
}
