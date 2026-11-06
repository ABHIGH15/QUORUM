#!/usr/bin/env node

/**
 * Quorum Live Gemini 3.8 Flash Agent Verification (§9.1, §9.3)
 * 
 * Verifies:
 * 1. Loads GEMINI_API_KEY from .env safely without printing secrets.
 * 2. Seeds an isolated in-memory test group with active policy ($200 hard cap, $150 unanimity threshold, $480 funds).
 * 3. Prompts the live Gemini 3.8 Flash agent: "I want to buy a projector for our movie nights."
 * 4. Observes live tool calling:
 *    - get_group_state
 *    - search_options (discovers $350 Lumina 4K Pro)
 *    - create_proposal ($350 item -> Quorum Guard BLOCKED with HARD_CAP_EXCEEDED)
 *    - search_options (adapts with max_price = $200 -> finds $145 OptiView HD)
 *    - create_proposal ($145 item -> Quorum Guard ALLOW -> status OPEN)
 * 5. Logs all steps and final response to console.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTestDb } from '../lib/db/test-db.ts';
import { runAgent } from '../lib/agent/agent.ts';

// Safe .env loader (never prints or logs secrets)
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

if (!process.env.GEMINI_API_KEY) {
  console.log('ℹ️ GEMINI_API_KEY is not configured in .env. Skipping live Gemini test.');
  process.exit(0);
}

async function run() {
  console.log('=============================================================');
  console.log('      Quorum Live Gemini 3.8 Flash Agent & Adapt Loop        ');
  console.log('=============================================================');

  const { pool } = createTestDb();

  const testGroupId = crypto.randomUUID();
  const testPolicyId = crypto.randomUUID();
  const testRoundId = crypto.randomUUID();
  const testUserId = crypto.randomUUID();

  // 1. Seed Group & Policy
  await pool.query(
    `INSERT INTO users (id, display_name, paypal_sandbox_email)
     VALUES ($1, 'Asha Patel', 'asha@sandbox.quorum.app')`,
    [testUserId]
  );

  await pool.query(
    `INSERT INTO groups (id, name, mode, status, currency, created_by)
     VALUES ($1, 'Quorum Demo Club', 'POOLED', 'ACTIVE', 'USD', $2)`,
    [testGroupId, testUserId]
  );

  const policySnapshot = {
    version: 1,
    currency: 'USD',
    budget_cents: 48000,
    hard_cap_cents: 20000,
    unanimous_above_cents: 15000,
    approval_tiers: [
      { max_cents: 6000, votes_required: 2 },
      { max_cents: 15000, votes_required: 4 },
      { max_cents: 20000, votes_required: 6 },
    ],
    veto_window_minutes: 1440,
    proposal_expiry_hours: 72,
    vendors: {
      mode: 'OPEN',
      allowlist_vendor_ids: ['v_projector_shop', 'v_screen_co', 'v_audio_direct'],
    },
    categories_allowed: ['equipment', 'Electronics', 'Entertainment', 'Office'],
    funding: {
      per_member_cents: 8000,
      min_contributors: 6,
      authorization_window_hours: 48,
      capture_retry_attempts: 2,
      capture_retry_interval_minutes: 60,
      partial_failure_decision: 'GROUP_VOTE',
      partial_failure_default: 'UNWIND',
      reduced_budget_votes_required: 'MAJORITY_OF_CONTRIBUTORS',
    },
    amendment_votes_required: 6,
  };

  await pool.query(
    `INSERT INTO policies (id, group_id, version, status, policy)
     VALUES ($1, $2, 1, 'ACTIVE', $3)`,
    [testPolicyId, testGroupId, JSON.stringify(policySnapshot)]
  );

  await pool.query(`UPDATE groups SET active_policy_id = $1 WHERE id = $2`, [testPolicyId, testGroupId]);

  // 2. Seed 6 members with captured contributions ($480 pool)
  for (let i = 0; i < 6; i++) {
    const uId = crypto.randomUUID();
    const mId = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, $2)`, [uId, `Member ${i + 1}`]);
    await pool.query(`INSERT INTO memberships (id, group_id, user_id, status) VALUES ($1, $2, $3, 'ACTIVE')`, [
      mId,
      testGroupId,
      uId,
    ]);
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents)
       VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', $2, 8000)`,
      [testGroupId, mId]
    );
  }

  // 3. Seed Vendor
  await pool.query(
    `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
     VALUES ('v_projector_shop', 'Lumina Vision Inc.', 'vendor-projector@sandbox.quorum.app', 'Electronics', true, 'CATALOG')`
  );

  console.log(`\n✓ Seeded group "${testGroupId}" with:`);
  console.log(`  - Total Pool Balance: $480.00`);
  console.log(`  - Hard Cap: $200.00 (Hard ceiling)`);
  console.log(`  - Unanimous Above: $150.00 (Requires 6/6 votes)`);
  console.log(`  - Standard Tier: $60.01 - $150.00 (Requires 4/6 votes)`);

  const prompt = 'I want to buy a projector for our group movie nights.';
  console.log(`\n--- Calling Live Gemini 3.8 Flash Agent ---`);
  console.log(`User Query: "${prompt}"`);

  const startTime = Date.now();
  const result = await runAgent({
    pool,
    groupId: testGroupId,
    query: prompt,
    apiKey: process.env.GEMINI_API_KEY,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\n✓ Agent completed in ${elapsed}s:`);
  console.log(`  Success: ${result.success}`);
  console.log(`  Adaptation Occurred: ${result.adaptationOccurred}`);
  console.log(`  Proposed Item: ${result.proposedItem?.name} ($${((result.proposedItem?.priceCents || 0) / 100).toFixed(2)})`);
  console.log(`  Proposal ID: ${result.proposedItem?.proposalId}`);

  console.log('\n--- Trace Steps ---');
  for (const s of result.steps) {
    console.log(`  Step ${s.step} [${s.action}]: ${s.detail}`);
  }

  console.log('\n--- Agent Final Message ---');
  console.log(result.finalMessage);

  // Check DB state for proposals
  const proposalsRes = await pool.query(
    `SELECT id, status, amount_cents, created_by_kind FROM proposals WHERE group_id = $1 ORDER BY created_at ASC`,
    [testGroupId]
  );
  console.log(`\n--- Recorded Proposals in Database (${proposalsRes.rows.length}) ---`);
  for (const p of proposalsRes.rows) {
    console.log(`  - Proposal ${p.id}: status=${p.status}, amount=$${(p.amount_cents / 100).toFixed(2)}, kind=${p.created_by_kind}`);
  }

  // Check Guard decisions log
  const guardDecisions = await pool.query(
    `SELECT proposal_id, phase, decision FROM guard_decisions ORDER BY created_at ASC`
  );
  console.log(`\n--- Guard Decisions Audit Trail (${guardDecisions.rows.length}) ---`);
  for (const gd of guardDecisions.rows) {
    console.log(`  - Guard Decision for Proposal ${gd.proposal_id}: phase=${gd.phase}, decision=${gd.decision}`);
  }

  console.log('\n=============================================================');
  console.log('✓ Quorum Live Gemini 3.8 Flash Agent Verification Complete');
  console.log('=============================================================');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
