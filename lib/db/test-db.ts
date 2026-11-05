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
    returns: db.public.getType('text') as any,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  db.public.registerFunction({
    name: 'uuid_generate_v4',
    args: [],
    returns: db.public.getType('text') as any,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  // Load and execute schema.sql
  const schemaPath = path.resolve(process.cwd(), 'db/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Strip extension lines that pg-mem doesn't need
  const cleanedSql = schemaSql
    .split('\n')
    .filter((line) => !line.toLowerCase().includes('create extension'))
    .join('\n');

  db.public.none(cleanedSql);

  const pgAdapter = db.adapters.createPg();
  const pool = new pgAdapter.Pool();
  return { db, pool };
}
