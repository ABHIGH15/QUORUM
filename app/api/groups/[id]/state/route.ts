import { getPool } from '@/lib/db/pool';

interface RouteContext {
  params: {
    id: string;
  };
}

/**
 * Group State & Ledger Endpoint (§10, §11)
 * 
 * Returns full state for the Quorum Workspace and AG Grid Financial Ledger:
 * - Group details and mode
 * - Active policy rules and thresholds
 * - Fund breakdown (captured, refunded, paid, reserved, available)
 * - Proposals (including BLOCKED proposals with Guard reason codes)
 * - Ledger events (for AG Grid audit table)
 * - Memberships and persona switcher options
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const groupId = context.params.id;
    const pool = getPool();

    // 1. Group
    const groupRes = await pool.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) {
      return Response.json({ error: `Group '${groupId}' not found.` }, { status: 404 });
    }
    const group = groupRes.rows[0];

    // 2. Active Policy
    let policy = null;
    if (group.active_policy_id) {
      const polRes = await pool.query('SELECT * FROM policies WHERE id = $1', [group.active_policy_id]);
      policy = polRes.rows[0]?.policy || null;
    }

    // 3. Ledger Events (for AG Grid)
    const ledgerRes = await pool.query(
      `SELECT id, type, actor_kind, actor_id, ref_type, ref_id, amount_cents, data, created_at
       FROM ledger_events
       WHERE group_id = $1
       ORDER BY id ASC`,
      [groupId]
    );

    // 4. Financial breakdown from ledger
    const balanceQuery = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
        COALESCE(SUM(CASE WHEN type = 'REFUND_ISSUED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
        COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
        COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
        COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
       FROM ledger_events
       WHERE group_id = $1`,
      [groupId]
    );
    const b = balanceQuery.rows[0];
    const netReserved = Math.max(0, parseInt(b.reserved, 10) - parseInt(b.released, 10));
    const availableCents = parseInt(b.captured, 10) - parseInt(b.refunded, 10) - parseInt(b.paid, 10) - netReserved;

    // 4b. Lazy state synchronization: advance concluded veto windows to EXECUTABLE
    await pool.query(
      `UPDATE proposals
       SET status = 'EXECUTABLE'
       WHERE group_id = $1 AND status = 'VETO_WINDOW' AND veto_ends_at IS NOT NULL AND veto_ends_at <= NOW()`,
      [groupId]
    );

    // 5. Proposals
    const proposalsRes = await pool.query(
      `SELECT p.*, v.name as vendor_name
       FROM proposals p
       LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE p.group_id = $1
       ORDER BY p.created_at DESC`,
      [groupId]
    );

    const proposals = proposalsRes.rows;
    if (proposals.length > 0) {
      const propIds = proposals.map((p) => p.id);
      
      // 5a. Guard Decisions
      const decisionsRes = await pool.query(
        `SELECT proposal_id, decision, result, created_at
         FROM guard_decisions
         WHERE proposal_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [propIds]
      );
      const decMap = new Map();
      for (const d of decisionsRes.rows) {
        decMap.set(d.proposal_id, d);
      }

      // 5b. Proposal Votes
      const votesRes = await pool.query(
        `SELECT v.proposal_id, v.member_id, v.kind, v.choice, v.created_at, u.display_name
         FROM votes v
         JOIN memberships m ON m.id = v.member_id
         JOIN users u ON u.id = m.user_id
         WHERE v.proposal_id = ANY($1::uuid[])
         ORDER BY v.created_at ASC`,
        [propIds]
      );
      const votesMap = new Map<string, any[]>();
      for (const v of votesRes.rows) {
        if (!votesMap.has(v.proposal_id)) {
          votesMap.set(v.proposal_id, []);
        }
        votesMap.get(v.proposal_id)!.push(v);
      }

      // 5c. Proposal Payments
      const paymentsRes = await pool.query(
        `SELECT proposal_id, status, amount_cents, sender_batch_id, paypal_batch_id, paypal_item_id, error_code, created_at
         FROM payments
         WHERE proposal_id = ANY($1::uuid[])
         ORDER BY created_at DESC`,
        [propIds]
      );
      const paymentsMap = new Map<string, any>();
      for (const py of paymentsRes.rows) {
        if (!paymentsMap.has(py.proposal_id)) {
          paymentsMap.set(py.proposal_id, py);
        }
      }

      for (const p of proposals) {
        const latest = decMap.get(p.id);
        p.last_guard_decision = latest?.decision || null;
        p.last_guard_result = latest?.result || null;
        p.votes = votesMap.get(p.id) || [];
        p.latest_payment = paymentsMap.get(p.id) || null;
      }
    }

    // 6. Members
    const membersRes = await pool.query(
      `SELECT m.id as member_id, m.status, u.id as user_id, u.display_name, u.paypal_sandbox_email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY u.display_name ASC`,
      [groupId]
    );

    return Response.json({
      group,
      policy,
      funds: {
        capturedCents: parseInt(b.captured, 10),
        refundedCents: parseInt(b.refunded, 10),
        paidCents: parseInt(b.paid, 10),
        reservedCents: netReserved,
        availableCents,
      },
      proposals: proposalsRes.rows,
      ledger: ledgerRes.rows,
      members: membersRes.rows,
    });
  } catch (err: any) {
    console.error('[API Group State Error]', err);
    return Response.json(
      { error: err.message || 'Failed to fetch group state' },
      { status: 500 }
    );
  }
}
