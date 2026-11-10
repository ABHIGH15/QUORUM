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

async function testVetoAdaptation() {
  console.log('=============================================================');
  console.log('   Quorum Post-Veto Adaptation Test ($145 Vetoed -> $135)    ');
  console.log('=============================================================\n');

  const apiKey = process.env.GEMINI_API_KEY;

  async function setupGroupWithVeto(pool, groupId) {
    const userId = crypto.randomUUID();
    const policyId = crypto.randomUUID();

    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, 'Asha')`, [userId]);
    await pool.query(`INSERT INTO groups (id, name, mode, status, created_by) VALUES ($1, 'Movie Club', 'POOLED', 'ACTIVE', $2)`, [groupId, userId]);

    for (let m = 0; m < 6; m++) {
      const uId = crypto.randomUUID();
      const mId = crypto.randomUUID();
      await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, $2)`, [uId, `Member ${m + 1}`]);
      await pool.query(`INSERT INTO memberships (id, group_id, user_id, status) VALUES ($1, $2, $3, 'ACTIVE')`, [mId, groupId, uId]);
      await pool.query(`INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents) VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', $2, 8000)`, [groupId, mId]);
    }

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
      vendors: { mode: 'OPEN', allowlist_vendor_ids: ['v_projector_shop'] },
      categories_allowed: ['equipment'],
    };

    await pool.query(`INSERT INTO policies (id, group_id, version, status, policy) VALUES ($1, $2, 1, 'ACTIVE', $3)`, [policyId, groupId, JSON.stringify(policySnapshot)]);
    await pool.query(`UPDATE groups SET active_policy_id = $1 WHERE id = $2`, [policyId, groupId]);

    await pool.query(
      `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
       VALUES ('v_projector_shop', 'Lumina Vision Inc.', 'vendor-projector@sandbox.quorum.app', 'Electronics', true, 'CATALOG')`
    );

    // Record previously VETOED $145 OptiView HD proposal
    const vetoedPropId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO proposals (id, group_id, type, status, created_by_kind, policy_version, vendor_id, category, amount_cents, payload)
       VALUES ($1, $2, 'PURCHASE', 'VETOED', 'AGENT', 1, 'v_projector_shop', 'equipment', 14500, $3)`,
      [
        vetoedPropId,
        groupId,
        JSON.stringify({
          catalog_item_id: 'prod_proj_hd_standard',
          itemId: 'prod_proj_hd_standard',
          item_name: 'OptiView HD Classroom Projector',
        }),
      ]
    );

    return { vetoedPropId };
  }

  // --- Test 1: Fallback Adaptation ---
  console.log('--- Test 1: Fallback (Rule-Based) Post-Veto Adaptation ---');
  const db1 = createTestDb();
  const gid1 = crypto.randomUUID();
  await setupGroupWithVeto(db1.pool, gid1);

  const fallbackResult = await runAgent({
    pool: db1.pool,
    groupId: gid1,
    query: 'Can you propose another projector for our group?',
    forceDeterministic: true,
  });

  console.log(`Fallback Result:`);
  console.log(`  Engine: ${fallbackResult.engine}`);
  console.log(`  Proposed: ${fallbackResult.proposedItem?.name} ($${((fallbackResult.proposedItem?.priceCents || 0) / 100).toFixed(2)})`);
  console.log(`  Item ID: ${fallbackResult.proposedItem?.id}`);
  const fallbackPassed = fallbackResult.proposedItem?.id === 'prod_proj_portable_lite' && fallbackResult.proposedItem?.priceCents === 13500;
  console.log(`  -> Fallback Test: ${fallbackPassed ? 'PASS (Proposed $135 PocketCast, excluded vetoed $145)' : 'FAIL'}\n`);

  // --- Test 2: Live Gemini Post-Veto Adaptation ---
  console.log('--- Test 2: Live Gemini Post-Veto Adaptation ---');
  const db2 = createTestDb();
  const gid2 = crypto.randomUUID();
  await setupGroupWithVeto(db2.pool, gid2);

  const liveResult = await runAgent({
    pool: db2.pool,
    groupId: gid2,
    query: 'The group vetoed our previous projector proposal. Can you propose another compliant projector for our movie nights?',
    apiKey,
  });

  console.log(`Live Gemini Result:`);
  console.log(`  Engine: ${liveResult.engine} (${liveResult.model})`);
  console.log(`  Proposed: ${liveResult.proposedItem?.name} ($${((liveResult.proposedItem?.priceCents || 0) / 100).toFixed(2)})`);
  console.log(`  Item ID: ${liveResult.proposedItem?.id}`);
  const livePassed = liveResult.proposedItem?.id === 'prod_proj_portable_lite' && liveResult.proposedItem?.priceCents === 13500;
  console.log(`  -> Live Test: ${livePassed ? 'PASS (Proposed $135 PocketCast, excluded vetoed $145)' : 'FAIL'}\n`);

  if (!fallbackPassed || !livePassed) {
    process.exit(1);
  }
}

testVetoAdaptation().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
