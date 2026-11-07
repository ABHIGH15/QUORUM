/**
 * Quorum AI Agent & Adapt Loop Tests (§9.1, §9.3, §12.2 S1/S2)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import { createTestDb } from '../lib/db/test-db';
import { CURATED_CATALOG } from '../lib/agent/catalog';
import { searchOptions, compareOptions, createProposal, explainDecision } from '../lib/agent/tools';
import { runAgent } from '../lib/agent/agent';

describe('AI Agent - Curated Catalog, Tools, & Adapt Loop', () => {
  let pool: pg.Pool;

  const testGroupId = '22222222-2222-2222-2222-222222222222';
  const testVendorId = 'v_projector_shop';

  beforeEach(async () => {
    const testDb = createTestDb();
    pool = testDb.pool;

    // Seed User
    const userId = '11111111-1111-1111-1111-111111111101';
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1, 'Asha')`,
      [userId]
    );

    // Seed Group
    await pool.query(
      `INSERT INTO groups (id, name, mode, status, created_by)
       VALUES ($1, 'Event Committee', 'POOLED', 'ACTIVE', $2)`,
      [testGroupId, userId]
    );

    // Seed 6 Memberships
    const memberIds = [];
    for (let i = 1; i <= 6; i++) {
      const uId = `11111111-1111-1111-1111-11111111110${i}`;
      const mId = `44444444-4444-4444-4444-44444444440${i}`;
      memberIds.push(mId);
      if (i > 1) {
        await pool.query(
          `INSERT INTO users (id, display_name) VALUES ($1, $2)`,
          [uId, `Member ${i}`]
        );
      }
      await pool.query(
        `INSERT INTO memberships (id, group_id, user_id, role, status)
         VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE')`,
        [mId, testGroupId, uId]
      );
    }

    // Seed Policy ($480 budget, $200 hard cap, $150 unanimity)
    const policySnapshot = {
      version: 1,
      currency: 'USD',
      budget_cents: 48000,
      hard_cap_cents: 20000,
      unanimous_above_cents: 15000,
      approval_tiers: [
        { max_cents: 6000, votes_required: 2 },
        { max_cents: 20000, votes_required: 4 },
      ],
      veto_window_minutes: 2,
      proposal_expiry_hours: 72,
      vendors: {
        mode: 'ALLOWLIST_ONLY',
        allowlist_vendor_ids: [testVendorId],
      },
      categories_allowed: ['equipment'],
      funding: {
        per_member_cents: 8000,
        min_contributors: 6,
        authorization_window_hours: 48,
        capture_retry_attempts: 2,
        capture_retry_interval_minutes: 2,
        partial_failure_decision: 'GROUP_VOTE',
        partial_failure_default: 'UNWIND',
        reduced_budget_votes_required: 'MAJORITY_OF_CONTRIBUTORS',
      },
      amendment_votes_required: 4,
    };

    await pool.query(
      `INSERT INTO policies (group_id, version, status, policy)
       VALUES ($1, 1, 'ACTIVE', $2)`,
      [testGroupId, JSON.stringify(policySnapshot)]
    );

    // Seed Vendor
    await pool.query(
      `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
       VALUES ($1, 'Projector Shop', 'vendor@sandbox.quorum.app', 'equipment', true, 'CATALOG')`,
      [testVendorId]
    );

    // Seed Funding Round & Contributions ($480 captured)
    const roundId = '55555555-5555-5555-5555-555555555555';
    await pool.query(
      `INSERT INTO funding_rounds (id, group_id, status, per_member_cents, min_contributors, authorization_deadline)
       VALUES ($1, $2, 'FUNDED', 8000, 6, NOW() - interval '1 hour')`,
      [roundId, testGroupId]
    );

    for (const mId of memberIds) {
      await pool.query(
        `INSERT INTO contributions (round_id, member_id, amount_cents, status)
         VALUES ($1, $2, 8000, 'CAPTURED')`,
        [roundId, mId]
      );
      await pool.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents)
         VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', $2, 8000)`,
        [testGroupId, mId]
      );
    }
  });

  describe('Catalog & Search Tool', () => {
    it('Finds projectors and filters by max price', () => {
      const allProjectors = searchOptions({ query: 'projector' });
      expect(allProjectors.length).toBeGreaterThanOrEqual(4);

      // Search under $200 (hard cap)
      const compliantProjectors = searchOptions({ query: 'projector', maxPriceCents: 20000 });
      expect(compliantProjectors.some((p) => p.priceCents === 35000)).toBe(false);
      expect(compliantProjectors.some((p) => p.priceCents === 14500)).toBe(true);
      expect(compliantProjectors.some((p) => p.priceCents === 13500)).toBe(true);
    });

    it('Ranks and compares options against policy', () => {
      const projectors = searchOptions({ query: 'projector' });
      const compared = compareOptions(projectors, {
        hardCapCents: 20000,
        unanimousAboveCents: 15000,
        approval_tiers: [
          { max_cents: 6000, votes_required: 2 },
          { max_cents: 20000, votes_required: 4 },
        ],
        allowedCategories: ['equipment'],
        allowedVendors: [testVendorId],
        availableCents: 48000,
        totalEligibleVoters: 6,
      });

      const pro4k = compared.find((c) => c.item.priceCents === 35000)!;
      expect(pro4k.compliantWithCap).toBe(false);
      expect(pro4k.guardPrediction).toBe('LIKELY_BLOCKED');

      const optiView = compared.find((c) => c.item.priceCents === 14500)!;
      expect(optiView.compliantWithCap).toBe(true);
      expect(optiView.requiredVotes).toBe(4);
      expect(optiView.guardPrediction).toBe('LIKELY_APPROVED');

      const executive = compared.find((c) => c.item.priceCents === 18000)!;
      expect(executive.compliantWithCap).toBe(true);
      expect(executive.requiredVotes).toBe(6); // Unanimous tier
    });
  });

  describe('create_proposal & explain_decision', () => {
    it('Blocks $350 projector in PROPOSAL phase and returns maxAllowedAmountCents suggestion', async () => {
      const result = await createProposal({
        pool,
        groupId: testGroupId,
        itemId: 'prod_proj_pro_4k', // $350.00
        rationale: 'Top quality 4K projector for cinema night',
        now: '2026-11-06T12:00:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('BLOCKED');
      expect(result.proposalId).toBeDefined();
      expect(result.proposalId.length).toBeGreaterThan(0);
      expect(result.guardResult.decision).toBe('BLOCKED');
      expect(result.guardResult.reasonCodes).toContain('HARD_CAP_EXCEEDED');
      expect(result.adaptationSuggested?.maxAllowedAmountCents).toBe(20000); // $200.00 cap

      // Verify the blocked proposal is saved in DB with status BLOCKED and audit row
      const blockedRow = await pool.query(`SELECT status, amount_cents FROM proposals WHERE id = $1`, [result.proposalId]);
      expect(blockedRow.rows).toHaveLength(1);
      expect(blockedRow.rows[0].status).toBe('BLOCKED');
      expect(blockedRow.rows[0].amount_cents).toBe(35000);
    });

    it('Allows compliant $145 projector in PROPOSAL phase, inserts OPEN proposal and audit record', async () => {
      const result = await createProposal({
        pool,
        groupId: testGroupId,
        itemId: 'prod_proj_hd_standard', // $145.00
        rationale: 'Compliant 1080p projector',
        now: '2026-11-06T12:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('OPEN');
      expect(result.proposalId).toBeDefined();

      // Verify DB row
      const propRes = await pool.query(`SELECT * FROM proposals WHERE id = $1`, [result.proposalId]);
      expect(propRes.rows).toHaveLength(1);
      expect(propRes.rows[0].status).toBe('OPEN');
      expect(propRes.rows[0].amount_cents).toBe(14500);

      // Verify explain_decision
      const explanation = await explainDecision(pool, result.proposalId);
      expect(explanation.found).toBe(true);
      expect(explanation.decision).toBe('NEEDS_VOTES'); // Needs votes in VOTING/PROPOSAL
      expect(explanation.numbers?.votesRequired).toBe(4);
    });
  });

  describe('The Adapt Loop (§9.3, S1 & S2 Demo Beat)', () => {
    it('S1/S2 Scenario: When user requests a projector, agent hits $350 cap block, adapts to $145, and succeeds', async () => {
      const result = await runAgent({
        pool,
        groupId: testGroupId,
        query: 'projector',
        now: '2026-11-06T12:00:00Z',
        forceDeterministic: true,
      });

      expect(result.success).toBe(true);
      expect(result.adaptationOccurred).toBe(true);
      expect(result.proposedItem?.priceCents).toBe(14500);
      expect(result.proposedItem?.name).toContain('OptiView HD');

      // Verify the execution steps trace
      const actions = result.steps.map((s) => s.action);
      expect(actions).toContain('EVALUATE');
      expect(actions).toContain('SEARCH');
      expect(actions).toContain('PROPOSE_BLOCKED');
      expect(actions).toContain('ADAPT');
      expect(actions).toContain('PROPOSE_SUCCESS');

      // Verify BOTH proposals exist in DB: the visible BLOCKED $350 proposal and the final OPEN $145 proposal
      const allProps = await pool.query(
        `SELECT id, status, amount_cents FROM proposals WHERE group_id = $1 ORDER BY created_at ASC`,
        [testGroupId]
      );
      expect(allProps.rows).toHaveLength(2);
      expect(allProps.rows[0].status).toBe('BLOCKED');
      expect(allProps.rows[0].amount_cents).toBe(35000);
      expect(allProps.rows[1].status).toBe('OPEN');
      expect(allProps.rows[1].amount_cents).toBe(14500);
    });

    it('S2->S3 Handoff: When $145 item is vetoed, agent excludes it and proposes the $135 alternative', async () => {
      // 1. Run agent initially -> proposes $145 OptiView HD
      const run1 = await runAgent({
        pool,
        groupId: testGroupId,
        query: 'projector',
        now: '2026-11-06T12:00:00Z',
        forceDeterministic: true,
      });
      expect(run1.success).toBe(true);
      expect(run1.proposedItem?.priceCents).toBe(14500);

      const propId = run1.proposedItem!.proposalId;

      // 2. Member Elena casts VETO on this proposal (simulating S2)
      await pool.query(
        `UPDATE proposals SET status = 'VETOED' WHERE id = $1`,
        [propId]
      );
      await pool.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, ref_type, ref_id, data)
         VALUES ($1, 'VETO_CAST', 'MEMBER', '44444444-4444-4444-4444-444444444405', 'PROPOSAL', $2, '{"choice":"VETO"}')`,
        [testGroupId, propId]
      );

      // 3. User asks the agent for another projector (simulating S2 -> S3 transition)
      const run2 = await runAgent({
        pool,
        groupId: testGroupId,
        query: 'projector',
        now: '2026-11-06T12:05:00Z',
        forceDeterministic: true,
      });

      // 4. Verify agent excluded the $145 vetoed item and proposed the $135 PocketCast Portable Mini Projector!
      expect(run2.success).toBe(true);
      expect(run2.proposedItem?.priceCents).toBe(13500);
      expect(run2.proposedItem?.id).toBe('prod_proj_portable_lite');
      expect(run2.proposedItem?.name).toContain('PocketCast');
      expect(run2.finalMessage).toContain('PocketCast');
    });

    it('Direct Compliant Request: Succeeds directly without adaptation when item is within limits', async () => {
      const result = await runAgent({
        pool,
        groupId: testGroupId,
        query: 'Boundary Mic', // $59.00
        now: '2026-11-06T12:00:00Z',
        forceDeterministic: true,
      });

      expect(result.success).toBe(true);
      expect(result.adaptationOccurred).toBe(false);
      expect(result.proposedItem?.priceCents).toBe(5900);

      const actions = result.steps.map((s) => s.action);
      expect(actions).toContain('SEARCH');
      expect(actions).toContain('PROPOSE_SUCCESS');
      expect(actions).not.toContain('PROPOSE_BLOCKED');
      expect(actions).not.toContain('ADAPT');
    });
  });
});
