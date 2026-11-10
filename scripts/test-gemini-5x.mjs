import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTestDb } from '../lib/db/test-db.ts';
import { runAgent } from '../lib/agent/agent.ts';

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

async function run5x() {
  console.log('=============================================================');
  console.log('      Quorum Live Gemini 5x Movie-Night Projector Test       ');
  console.log('=============================================================\n');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: GEMINI_API_KEY is not set in .env');
    process.exit(1);
  }

  const results = [];

  for (let i = 1; i <= 5; i++) {
    console.log(`\n--- Run ${i}/5 ---`);
    const { pool } = createTestDb();
    const testGroupId = crypto.randomUUID();
    const testPolicyId = crypto.randomUUID();
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
      veto_window_minutes: 2,
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
    for (let m = 0; m < 6; m++) {
      const uId = crypto.randomUUID();
      const mId = crypto.randomUUID();
      await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, $2)`, [uId, `Member ${m + 1}`]);
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

    const startTime = Date.now();
    try {
      const res = await runAgent({
        pool,
        groupId: testGroupId,
        query: 'I want to buy a projector for our group movie nights.',
        apiKey,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const blockedRes = await pool.query(
        `SELECT COUNT(*)::int as count FROM proposals WHERE group_id = $1 AND status = 'BLOCKED'`,
        [testGroupId]
      );
      const blockedCount = blockedRes.rows[0].count;

      const pick = {
        run: i,
        engine: res.engine,
        model: res.model,
        proposedItem: res.proposedItem?.name,
        priceFormatted: `$${((res.proposedItem?.priceCents || 0) / 100).toFixed(2)}`,
        priceCents: res.proposedItem?.priceCents,
        blockedProposalsCount: blockedCount,
        elapsedSec: elapsed,
        adaptationOccurred: res.adaptationOccurred,
      };
      results.push(pick);
      console.log(`  ✓ Run ${i}: Picked ${pick.proposedItem} (${pick.priceFormatted}) [${pick.engine} / ${pick.model}] - BLOCKED rows in DB: ${blockedCount} - took ${elapsed}s`);
    } catch (err) {
      console.error(`  ✗ Run ${i} failed:`, err.message);
      results.push({ run: i, error: err.message });
    }

    if (i < 5) {
      console.log('  Waiting 8s for API cooldown to prevent free-tier 15 RPM limit...');
      await new Promise((r) => setTimeout(r, 8000));
    }
  }

  console.log('\n=============================================================');
  console.log('                     Summary of 5 Runs                       ');
  console.log('=============================================================');
  console.table(results.map(r => ({
    Run: r.run,
    Item: r.proposedItem,
    Price: r.priceFormatted,
    Model: r.model || r.engine,
    'Blocked Count': r.blockedProposalsCount,
    'Adapted?': r.adaptationOccurred,
  })));

  const count145 = results.filter(r => r.priceCents === 14500).length;
  console.log(`\nResult: Picked $145 OptiView HD in ${count145}/5 runs (Required: at least 4/5).`);
  console.log(`Duplicate BLOCKED items per run: ${results.every(r => r.blockedProposalsCount <= 1) ? 'FIXED (at most 1 blocked proposal per run)' : 'FAILED'}`);
}

run5x().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
