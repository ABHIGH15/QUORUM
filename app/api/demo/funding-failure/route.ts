import { getPool } from '@/lib/db/pool';
import crypto from 'node:crypto';

/**
 * Demo S4 Funding Partial Failure Simulation Endpoint (§11, §12)
 * 
 * Invariants:
 * 1. Simulates PayPal authorization capture failure for Farid after 3 retries.
 * 2. Updates funding_round status to PARTIAL_FAILURE.
 * 3. Records ledger correction so pool balance reflects 5 captured members ($400.00).
 * 4. Generates the two S4 decision proposals:
 *    - ACCEPT_REDUCED_BUDGET ($400.00 new budget)
 *    - UNWIND_FUNDING (Refund 5 captured members)
 * 5. Provides UNWIND execution to issue simulated refunds to all captured members.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const groupId = body.groupId || '00000000-0000-0000-0000-000000000001';
    const action = body.action || 'FAIL'; // 'FAIL' | 'UNWIND' | 'ACCEPT_REDUCED'
    const pool = getPool();

    // Verify group exists
    const groupRes = await pool.query('SELECT id, status FROM groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) {
      return Response.json({ error: `Group '${groupId}' not found` }, { status: 404 });
    }

    if (action === 'FAIL') {
      const faridMemberId = '20000000-0000-0000-0000-000000000006';

      // 1. Mark Farid's contribution as CAPTURE_FAILED (3 attempts)
      await pool.query(
        `UPDATE contributions 
         SET status = 'CAPTURE_FAILED', capture_attempts = 3 
         WHERE member_id = $1`,
        [faridMemberId]
      );

      // 2. Adjust ledger balance by adding a REFUND_ISSUED for Farid's contribution
      // so available pool balance drops from $480.00 to $400.00
      await pool.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents, data)
         VALUES ($1, 'CONTRIBUTION_REFUNDED', 'SYSTEM', $2, 8000, $3)`,
        [
          groupId,
          faridMemberId,
          JSON.stringify({
            reason: 'SIMULATED_CAPTURE_FAILURE',
            member: 'Farid Al-Mansoor',
            simulated: true,
            attempts: 3,
            detail: 'PayPal card authorization capture failed: PAYER_ACTION_REQUIRED after 3 retry intervals.',
          }),
        ]
      );

      // 3. Update active funding round status to PARTIAL_FAILURE
      await pool.query(
        `UPDATE funding_rounds SET status = 'PARTIAL_FAILURE' WHERE group_id = $1`,
        [groupId]
      );

      // 4. Create the two S4 governance proposals
      const acceptReducedPropId = crypto.randomUUID();
      const unwindPropId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO proposals (id, group_id, type, status, created_by_kind, policy_version, amount_cents, payload, veto_ends_at)
         VALUES ($1, $2, 'ACCEPT_REDUCED_BUDGET', 'OPEN', 'SYSTEM', 1, 0, $3, NOW() + INTERVAL '2 minutes')`,
        [
          acceptReducedPropId,
          groupId,
          JSON.stringify({
            title: 'Option A: Accept Reduced Budget ($400.00)',
            new_budget_cents: 40000,
            original_goal_cents: 48000,
            captured_members_count: 5,
            failed_member_name: 'Farid Al-Mansoor',
            reason: 'Partial failure: 5 of 6 member contributions captured ($400.00 USD). Option A allows the group to proceed with $400.00 budget.',
            simulated: true,
          }),
        ]
      );

      await pool.query(
        `INSERT INTO proposals (id, group_id, type, status, created_by_kind, policy_version, amount_cents, payload, veto_ends_at)
         VALUES ($1, $2, 'UNWIND_FUNDING', 'OPEN', 'SYSTEM', 1, 0, $3, NOW() + INTERVAL '2 minutes')`,
        [
          unwindPropId,
          groupId,
          JSON.stringify({
            title: 'Option B: Unwind Funding & Refund All ($400.00)',
            reason: 'Partial failure: Option B executes safe unwinding. Voids pending authorizations and refunds all 5 captured members ($80.00 each).',
            refund_count: 5,
            total_refund_cents: 40000,
            simulated: true,
          }),
        ]
      );

      return Response.json({
        success: true,
        message: "Simulated Farid's capture failure: 5/6 members captured ($400.00 pool). S4 proposals generated.",
        roundStatus: 'PARTIAL_FAILURE',
        failedMemberId: faridMemberId,
        acceptReducedProposalId: acceptReducedPropId,
        unwindProposalId: unwindPropId,
      });
    }

    if (action === 'UNWIND') {
      // Execute Option B: Unwind pool and refund 5 captured members
      const capturedMembersRes = await pool.query(
        `SELECT m.id, u.display_name, c.amount_cents 
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN contributions c ON c.member_id = m.id
         WHERE m.group_id = $1 AND c.status = 'CAPTURED'`,
        [groupId]
      );

      for (const m of capturedMembersRes.rows) {
        await pool.query(
          `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents, data)
           VALUES ($1, 'CONTRIBUTION_REFUNDED', 'SYSTEM', $2, $3, $4)`,
          [
            groupId,
            m.id,
            m.amount_cents,
            JSON.stringify({
              reason: 'UNWIND_FUNDING_EXECUTED',
              member_name: m.display_name,
              simulated: true,
            }),
          ]
        );
      }

      // Mark contributions refunded
      await pool.query(
        `UPDATE contributions SET status = 'REFUNDED' WHERE status = 'CAPTURED' AND round_id IN (SELECT id FROM funding_rounds WHERE group_id = $1)`,
        [groupId]
      );

      // Mark funding round UNWOUND
      await pool.query(`UPDATE funding_rounds SET status = 'UNWOUND' WHERE group_id = $1`, [groupId]);

      // Mark UNWIND_FUNDING proposals EXECUTED
      await pool.query(
        `UPDATE proposals SET status = 'EXECUTED' WHERE group_id = $1 AND type = 'UNWIND_FUNDING'`,
        [groupId]
      );

      // Mark ACCEPT_REDUCED_BUDGET proposals CANCELLED
      await pool.query(
        `UPDATE proposals SET status = 'CANCELLED' WHERE group_id = $1 AND type = 'ACCEPT_REDUCED_BUDGET'`,
        [groupId]
      );

      return Response.json({
        success: true,
        message: 'Funding pool successfully unwound. 5 member refunds recorded in ledger.',
        roundStatus: 'UNWOUND',
      });
    }

    if (action === 'ACCEPT_REDUCED') {
      // Execute Option A: Accept reduced budget ($400)
      await pool.query(`UPDATE funding_rounds SET status = 'FUNDED' WHERE group_id = $1`, [groupId]);

      await pool.query(
        `UPDATE proposals SET status = 'EXECUTED' WHERE group_id = $1 AND type = 'ACCEPT_REDUCED_BUDGET'`,
        [groupId]
      );

      await pool.query(
        `UPDATE proposals SET status = 'CANCELLED' WHERE group_id = $1 AND type = 'UNWIND_FUNDING'`,
        [groupId]
      );

      return Response.json({
        success: true,
        message: 'Reduced budget accepted. Group funded at $400.00 with 5 contributing members.',
        roundStatus: 'FUNDED',
      });
    }

    return Response.json({ error: `Unknown action: '${action}'` }, { status: 400 });
  } catch (err: any) {
    console.error('[Funding Failure Endpoint Error]', err);
    return Response.json({ error: err.message || 'Failed to simulate funding failure' }, { status: 500 });
  }
}
