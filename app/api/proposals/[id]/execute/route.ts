import { getPool } from '@/lib/db/pool';
import { executeProposalPayment } from '@/lib/payments/transaction';
import { PayoutAdapter } from '@/lib/payments/adapters/payout-adapter';

interface RouteContext {
  params: {
    id: string;
  };
}

/**
 * Proposal Payment Execution Route (§7, §8)
 * 
 * Invariants:
 * 1. Must be triggered by an active contributing member persona (executorMemberId).
 * 2. Runs Quorum Guard inside interactive PostgreSQL row lock (SELECT ... FOR UPDATE).
 * 3. Commits reservation before calling external PayPal API.
 * 4. Strictly idempotent using q_<proposalId>_<attempt> sender_batch_id.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const proposalId = context.params.id;
    const body = await request.json().catch(() => ({}));
    const executorMemberId = body.executorMemberId || request.headers.get('x-quorum-member-id');

    if (!executorMemberId) {
      return Response.json(
        { error: 'Missing executor member persona. An active contributing member must authorize execution (I7).' },
        { status: 400 }
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
          phase: result.phase,
          error: result.error,
          guardResult: result.guardResult,
        },
        { status: 422 }
      );
    }

    return Response.json({
      success: true,
      phase: result.phase,
      paymentId: result.paymentId,
      senderBatchId: result.senderBatchId,
      adapterStatus: result.adapterStatus,
    });
  } catch (err: any) {
    console.error('[API Proposal Execution Error]', err);
    return Response.json(
      { error: err.message || 'Execution failed unexpectedly' },
      { status: 500 }
    );
  }
}
