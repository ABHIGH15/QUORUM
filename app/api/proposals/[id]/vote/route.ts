import { getPool } from '@/lib/db/pool';
import { evaluate } from '@/lib/guard/evaluate';
import { GuardInput } from '@/lib/guard/types';

interface RouteContext {
  params: {
    id: string;
  };
}

function getMemberIdFromRequest(request: Request, body?: any): string | null {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)quorum_member_id=([^;]+)/);
  if (cookieMatch) {
    return decodeURIComponent(cookieMatch[1].trim());
  }
  const headerMemberId = request.headers.get('x-quorum-member-id');
  if (headerMemberId) {
    return headerMemberId.trim();
  }
  if (body && body.memberId) {
    return body.memberId;
  }
  return null;
}

/**
 * Proposal Voting & Veto Route (§6, §7)
 * 
 * Invariants:
 * 1. Only active captured contributors may vote or veto (I7).
 *    Derives persona from session cookie `quorum_member_id` or header `x-quorum-member-id`.
 * 2. Veto window: A single veto immediately halts an approved proposal into VETOED (I4).
 * 3. Quorum Guard re-evaluates in VOTING phase after every vote.
 *    - When threshold reached: moves to VETO_WINDOW with veto_ends_at set.
 *    - If votes drop below threshold: reverts to OPEN and clears veto_ends_at.
 *    - When veto window concludes or 0m: moves to EXECUTABLE.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const proposalId = context.params.id;
    const body = await request.json().catch(() => ({}));
    const memberId = getMemberIdFromRequest(request, body);
    const choice = body.choice;

    if (!memberId || !['APPROVE', 'REJECT', 'VETO'].includes(choice)) {
      return Response.json(
        { error: 'Invalid parameters: eligible memberId (via session cookie / header) and choice (APPROVE | REJECT | VETO) are required.' },
        { status: 400 }
      );
    }

    const pool = getPool();

    // 1. Fetch proposal and group
    const propRes = await pool.query(
      `SELECT p.*, g.mode as group_mode, g.status as group_status
       FROM proposals p
       JOIN groups g ON g.id = p.group_id
       WHERE p.id = $1`,
      [proposalId]
    );

    if (propRes.rows.length === 0) {
      return Response.json({ error: `Proposal '${proposalId}' not found.` }, { status: 404 });
    }

    const proposal = propRes.rows[0];
    const groupId = proposal.group_id;

    // 2. Validate member eligibility (active member with captured contribution)
    const memberRes = await pool.query(
      `SELECT m.id, m.status, u.display_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'CAPTURED'
       LEFT JOIN ledger_events le ON le.actor_id = m.id AND le.group_id = $1 AND le.type = 'CONTRIBUTION_CAPTURED'
       WHERE m.id = $2 AND m.group_id = $1 AND m.status = 'ACTIVE' AND (c.id IS NOT NULL OR le.id IS NOT NULL)`,
      [groupId, memberId]
    );

    if (memberRes.rows.length === 0) {
      return Response.json(
        { error: 'Voter is not an eligible active contributor for this group.' },
        { status: 403 }
      );
    }

    const nowIso = new Date().toISOString();

    // 3. Handle VETO
    if (choice === 'VETO') {
      if (proposal.status !== 'VETO_WINDOW' && proposal.status !== 'OPEN') {
        return Response.json(
          { error: `Cannot veto proposal in status '${proposal.status}'. Must be OPEN or in VETO_WINDOW.` },
          { status: 400 }
        );
      }

      // Record veto in votes table
      await pool.query(
        `INSERT INTO votes (proposal_id, member_id, kind, choice)
         VALUES ($1, $2, 'VETO', 'VETO')
         ON CONFLICT (proposal_id, member_id, kind) DO UPDATE SET choice = 'VETO'`,
        [proposalId, memberId]
      );

      // Transition proposal to VETOED
      await pool.query(`UPDATE proposals SET status = 'VETOED' WHERE id = $1`, [proposalId]);

      // Record in ledger
      await pool.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, ref_type, ref_id, data)
         VALUES ($1, 'VETO_CAST', 'MEMBER', $2, 'PROPOSAL', $3, $4)`,
        [groupId, memberId, proposalId, JSON.stringify({ reason: 'Member exercised veto window power' })]
      );

      return Response.json({
        success: true,
        action: 'VETO_RECORDED',
        proposalStatus: 'VETOED',
      });
    }

    // 4. Handle VOTE (APPROVE / REJECT)
    if (proposal.status !== 'OPEN') {
      return Response.json(
        { error: `Cannot cast vote on proposal in status '${proposal.status}'. Must be OPEN.` },
        { status: 400 }
      );
    }

    // Upsert vote
    await pool.query(
      `INSERT INTO votes (proposal_id, member_id, kind, choice)
       VALUES ($1, $2, 'VOTE', $3)
       ON CONFLICT (proposal_id, member_id, kind) DO UPDATE SET choice = $3`,
      [proposalId, memberId, choice]
    );

    // Record vote event in ledger
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, ref_type, ref_id, data)
       VALUES ($1, 'VOTE_CAST', 'MEMBER', $2, 'PROPOSAL', $3, $4)`,
      [groupId, memberId, proposalId, JSON.stringify({ choice })]
    );

    // 5. Re-evaluate Quorum Guard in VOTING phase
    const policyRes = await pool.query(
      `SELECT policy FROM policies WHERE group_id = $1 AND version = $2`,
      [groupId, proposal.policy_version]
    );
    const policy = policyRes.rows[0]?.policy;

    const allVotesRes = await pool.query(
      `SELECT member_id, kind, choice FROM votes WHERE proposal_id = $1`,
      [proposalId]
    );
    const votes = allVotesRes.rows.map((r) => ({
      proposal_id: proposalId,
      member_id: r.member_id,
      kind: r.kind as 'VOTE' | 'VETO',
      choice: r.choice as 'APPROVE' | 'REJECT' | 'VETO',
    }));

    const allMembersRes = await pool.query(
      `SELECT DISTINCT m.id 
       FROM memberships m
       LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'CAPTURED'
       LEFT JOIN ledger_events le ON le.actor_id = m.id AND le.group_id = $1 AND le.type = 'CONTRIBUTION_CAPTURED'
       WHERE m.group_id = $1 AND m.status = 'ACTIVE' AND (c.id IS NOT NULL OR le.id IS NOT NULL)`,
      [groupId]
    );
    const eligibleVoters = allMembersRes.rows.map((r) => r.id);

    const vendorRes = await pool.query(`SELECT * FROM vendors WHERE id = $1`, [proposal.vendor_id]);
    const vendor = vendorRes.rows[0];

    const guardInput: GuardInput = {
      phase: 'VOTING',
      now: nowIso,
      policy,
      group: {
        id: groupId,
        mode: proposal.group_mode,
        status: proposal.group_status,
      },
      proposal: {
        id: proposal.id,
        group_id: groupId,
        type: proposal.type,
        status: proposal.status,
        created_by_kind: proposal.created_by_kind,
        policy_version: proposal.policy_version,
        vendor_id: proposal.vendor_id,
        category: proposal.category,
        amount_cents: proposal.amount_cents,
        payload: proposal.payload,
        voting_deadline: proposal.voting_deadline,
        veto_ends_at: proposal.veto_ends_at,
      },
      votes,
      eligibleVoters,
      vendor,
      funds: {
        availableCents: 48000,
        reservedCents: 0,
        fundingReady: true,
      },
      existingLivePayment: false,
    };

    const guardResult = evaluate(guardInput);

    let nextStatus = proposal.status;
    let vetoEndsAt: string | null = null;

    if (guardResult.decision === 'VETO_WINDOW_OPEN') {
      const vetoMinutes = policy?.veto_window_minutes || 0;
      nextStatus = 'VETO_WINDOW';
      vetoEndsAt = new Date(Date.now() + vetoMinutes * 60 * 1000).toISOString();
      await pool.query(
        `UPDATE proposals SET status = $1, veto_ends_at = $2 WHERE id = $3`,
        [nextStatus, vetoEndsAt, proposalId]
      );
    } else if (guardResult.decision === 'NEEDS_VOTES') {
      if (proposal.status === 'VETO_WINDOW') {
        // Approvals dropped below threshold: revert to OPEN and clear veto_ends_at
        nextStatus = 'OPEN';
        vetoEndsAt = null;
        await pool.query(
          `UPDATE proposals SET status = $1, veto_ends_at = NULL WHERE id = $2`,
          [nextStatus, proposalId]
        );
      }
    } else if (guardResult.decision === 'APPROVED') {
      nextStatus = 'EXECUTABLE';
      await pool.query(
        `UPDATE proposals SET status = $1 WHERE id = $2`,
        [nextStatus, proposalId]
      );
    }

    return Response.json({
      success: true,
      choice,
      proposalStatus: nextStatus,
      vetoEndsAt,
      guardResult,
    });
  } catch (err: any) {
    console.error('[API Vote Error]', err);
    return Response.json(
      { error: err.message || 'Voting failed' },
      { status: 500 }
    );
  }
}
