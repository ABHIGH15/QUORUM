import { getPool } from '@/lib/db/pool';
import { executeProposalPayment } from '@/lib/payments/transaction';
import { PayoutAdapter } from '@/lib/payments/adapters/payout-adapter';

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
  // Gated body fallback: strictly for automated test suites and controlled demo mode
  if (process.env.NODE_ENV === 'test' || process.env.DEMO_MODE === 'true') {
    if (body && body.executorMemberId) {
      return body.executorMemberId;
    }
    if (body && body.memberId) {
      return body.memberId;
    }
  }
  return null;
}

/**
 * Proposal Payment Execution Route (§7, §8)
 * 
 * Invariants:
 * 1. Must be triggered by an active contributing member persona (derived from session cookie / header).
 * 2. Runs Quorum Guard inside interactive PostgreSQL row lock (SELECT ... FOR UPDATE).
 * 3. Commits reservation before calling external PayPal API.
 * 4. Strictly idempotent using q_<proposalId>_<attempt> sender_batch_id.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const proposalId = context.params.id;
    const body = await request.json().catch(() => ({}));
    const executorMemberId = getMemberIdFromRequest(request, body);

    if (!executorMemberId) {
      return Response.json(
        {
          error: 'Missing executor member persona. An active contributing member must authorize execution (I7).',
          code: 'NO_UNILATERAL_EXECUTION',
        },
        { status: 403 }
      );
    }

    const pool = getPool();

    // Query proposal to find group_id
    const propRes = await pool.query('SELECT group_id, status FROM proposals WHERE id = $1', [proposalId]);
    if (propRes.rows.length === 0) {
      return Response.json({ error: `Proposal '${proposalId}' not found.` }, { status: 404 });
    }
    const groupId = propRes.rows[0].group_id;

    const adapter = new PayoutAdapter();
    const result = await executeProposalPayment({
      groupId,
      proposalId,
      executorMemberId,
      pool,
      adapter,
    });

    if (!result.success) {
      return Response.json(
        {
          success: false,
          code: result.code || 'NO_UNILATERAL_EXECUTION',
          phase: result.phase,
          error: result.error,
          guardResult: result.guardResult,
        },
        { status: 403 }
      );
    }

    return Response.json({
      success: true,
      phase: result.phase,
      paymentId: result.paymentId,
      senderBatchId: result.senderBatchId,
      paypalBatchId: result.paypalBatchId,
    });
  } catch (err: any) {
    console.error('[API Proposal Execution Error]', err);
    return Response.json(
      { error: err.message || 'Execution failed unexpectedly' },
      { status: 500 }
    );
  }
}
