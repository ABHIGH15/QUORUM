/**
 * Quorum Payment Execution Transaction (§3.2 I3, I4, §7.4)
 * 
 * Strict Invariants:
 * 1. Executes inside a direct PostgreSQL interactive transaction with row-lock:
 *    SELECT id FROM groups WHERE id = $1 FOR UPDATE
 * 2. Re-runs Quorum Guard in EXECUTION phase inside the lock. Prior approvals are never sufficient alone.
 * 3. Enforces append-only ledger and the `one_live_payment_per_proposal` constraint.
 * 4. COMMITS the transaction (releasing the row lock) BEFORE calling PayPal API.
 * 5. PayPal API is called outside the DB transaction using a deterministic sender_batch_id.
 * 6. Crash recovery: payments in CREATED status can be safely resumed without double-spend.
 * 7. Voter & Executor validation: Only active members with captured contributions can vote or execute.
 * 8. Ambiguous vs. Definite failures: Ambiguous errors retain reservations in CREATED for idempotent recovery.
 */

import pg from 'pg';
import { withTransaction } from '../db/pool';
import { evaluate } from '../guard/evaluate';
import { GuardInput } from '../guard/types';
import {
  VendorPaymentAdapter,
  ExecutionTransactionResult,
  PaymentExecutionOutcome,
  DefinitePaymentFailure,
  AmbiguousPaymentFailure,
} from './types';

export interface ExecuteProposalPaymentParams {
  groupId: string;
  proposalId: string;
  executorMemberId: string; // Mandatory (I7)
  pool: pg.Pool;
  adapter: VendorPaymentAdapter;
  now?: string; // Injected ISO timestamp for deterministic testing
}

export interface RecordOutcomeParams {
  pool: pg.Pool;
  groupId: string;
  proposalId: string;
  paymentId: string;
  proposalAmountCents: number;
  outcome: PaymentExecutionOutcome;
  errorCode?: string;
}

/**
 * Shared helper to record external payment outcomes consistently
 * across both direct execution and crash recovery paths.
 */
export async function recordOutcome(params: RecordOutcomeParams): Promise<void> {
  const { pool, groupId, proposalId, paymentId, proposalAmountCents, outcome, errorCode } = params;

  await withTransaction(pool, async (client) => {
    if (outcome.status === 'SUCCEEDED') {
      await client.query(
        `UPDATE payments 
         SET status = 'SUCCEEDED', paypal_batch_id = $1, paypal_item_id = $2, updated_at = NOW() 
         WHERE id = $3`,
        [outcome.batchId, outcome.itemId || null, paymentId]
      );
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'PAYOUT_SUCCEEDED', 'PAYPAL', 'PAYMENT', $2, $3, $4)`,
        [
          groupId,
          paymentId,
          proposalAmountCents,
          JSON.stringify({
            paypal_batch_id: outcome.batchId,
            paypal_item_id: outcome.itemId,
            recovered_duplicate: outcome.recoveredDuplicate || false,
          }),
        ]
      );
      // Critical Balance Invariant: Release the reservation on payout success so it is not double-deducted!
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'FUNDS_RELEASED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
        [
          groupId,
          paymentId,
          proposalAmountCents,
          JSON.stringify({
            reason: 'PAYOUT_SUCCEEDED',
            payment_id: paymentId,
          }),
        ]
      );
      await client.query(
        `UPDATE proposals SET status = 'EXECUTED' WHERE id = $1`,
        [proposalId]
      );
    } else if (outcome.status === 'PENDING') {
      await client.query(
        `UPDATE payments 
         SET status = 'PENDING', paypal_batch_id = $1, paypal_item_id = $2, updated_at = NOW() 
         WHERE id = $3`,
        [outcome.batchId, outcome.itemId || null, paymentId]
      );
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'PAYOUT_SUBMITTED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
        [
          groupId,
          paymentId,
          proposalAmountCents,
          JSON.stringify({
            paypal_batch_id: outcome.batchId,
            recovered_duplicate: outcome.recoveredDuplicate || false,
          }),
        ]
      );
    } else if (outcome.status === 'UNCLAIMED') {
      await client.query(
        `UPDATE payments 
         SET status = 'UNCLAIMED', paypal_batch_id = $1, paypal_item_id = $2, updated_at = NOW() 
         WHERE id = $3`,
        [outcome.batchId, outcome.itemId || null, paymentId]
      );
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'PAYOUT_UNCLAIMED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
        [
          groupId,
          paymentId,
          proposalAmountCents,
          JSON.stringify({
            paypal_batch_id: outcome.batchId,
            paypal_item_id: outcome.itemId,
          }),
        ]
      );
    } else if (outcome.status === 'FAILED') {
      await client.query(
        `UPDATE payments SET status = 'FAILED', error_code = $1, updated_at = NOW() WHERE id = $2`,
        [errorCode || 'PAYMENT_FAILED', paymentId]
      );
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'FUNDS_RELEASED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
        [groupId, paymentId, proposalAmountCents, JSON.stringify({ error: errorCode, reason: 'PAYOUT_FAILED' })]
      );
      await client.query(
        `UPDATE proposals SET status = 'EXECUTION_FAILED' WHERE id = $1`,
        [proposalId]
      );
    }
  });
}

export async function executeProposalPayment(
  params: ExecuteProposalPaymentParams
): Promise<ExecutionTransactionResult> {
  const { groupId, proposalId, executorMemberId, pool, adapter, now } = params;
  const nowIso = now || new Date().toISOString();

  let paymentId: string = '';
  let senderBatchId: string = '';
  let proposalAmountCents: number = 0;
  let vendorEmail: string = '';
  let attemptNumber: number = 1;

  // ---------------------------------------------------------------------------
  // STEP 1: Direct PostgreSQL Interactive Row-Lock Transaction
  // ---------------------------------------------------------------------------
  let preExecution: any;
  try {
    preExecution = await withTransaction(pool, async (client) => {
      // 1. Validate mandatory executorMemberId
      if (!executorMemberId) {
        return {
          allowed: false,
          error: 'Executor member ID is mandatory for execution (I7)',
        };
      }

      // 2. Serialize execution for this group using exclusive row-level lock
      const groupRes = await client.query(
        `SELECT id, name, mode, status, active_policy_id FROM groups WHERE id = $1 FOR UPDATE`,
        [groupId]
      );
      if (groupRes.rows.length === 0) {
        throw new Error(`Group '${groupId}' not found`);
      }
      const groupRow = groupRes.rows[0];

      // 3. Fetch and lock proposal
      const propRes = await client.query(
        `SELECT * FROM proposals WHERE id = $1 AND group_id = $2 FOR UPDATE`,
        [proposalId, groupId]
      );
      if (propRes.rows.length === 0) {
        throw new Error(`Proposal '${proposalId}' not found in group '${groupId}'`);
      }
      const propRow = propRes.rows[0];
      proposalAmountCents = propRow.amount_cents || 0;

      // 4. Handle VETO_WINDOW expiry lazy synchronization
      if (propRow.status === 'VETO_WINDOW' && propRow.veto_ends_at) {
        const vetoEndMs = new Date(propRow.veto_ends_at).getTime();
        const nowMs = new Date(nowIso).getTime();
        if (nowMs >= vetoEndMs) {
          const vetoCountRes = await client.query(
            `SELECT COUNT(*)::int as count FROM votes WHERE proposal_id = $1 AND (kind = 'VETO' OR choice = 'VETO')`,
            [proposalId]
          );
          const hasVeto = (vetoCountRes.rows[0]?.count || 0) > 0;
          const nextStatus = hasVeto ? 'VETOED' : 'EXECUTABLE';
          await client.query(`UPDATE proposals SET status = $1 WHERE id = $2`, [nextStatus, proposalId]);
          propRow.status = nextStatus;
        }
      }

      // 5. Strictly enforce proposal executable status
      if (propRow.status !== 'EXECUTABLE' && propRow.status !== 'EXECUTION_FAILED') {
        return {
          allowed: false,
          error: `Proposal '${proposalId}' is not executable (current status: '${propRow.status}')`,
        };
      }

      // 6. Query Active Captured Contributing Members
      const membersRes = await client.query(
        `SELECT DISTINCT m.id 
         FROM memberships m
         LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'CAPTURED'
         LEFT JOIN ledger_events le ON le.actor_id = m.id AND le.group_id = $1 AND le.type = 'CONTRIBUTION_CAPTURED'
         WHERE m.group_id = $1 
           AND m.status = 'ACTIVE'
           AND (c.id IS NOT NULL OR le.id IS NOT NULL)`,
        [groupId]
      );
      const eligibleVoters = membersRes.rows.map((r) => r.id);

      // 7. Verify Executor Membership & Contributor Status (I7)
      const executorRes = await client.query(
        `SELECT m.id, m.role, m.status 
         FROM memberships m
         WHERE m.id = $1 AND m.group_id = $2`,
        [executorMemberId, groupId]
      );
      if (executorRes.rows.length === 0) {
        return {
          allowed: false,
          error: `Executor member '${executorMemberId}' not found in group '${groupId}'`,
        };
      }
      const executor = executorRes.rows[0];
      if (executor.status !== 'ACTIVE') {
        return {
          allowed: false,
          error: `Executor member '${executorMemberId}' is not ACTIVE (status: ${executor.status})`,
        };
      }
      if (!eligibleVoters.includes(executorMemberId)) {
        return {
          allowed: false,
          error: `Executor member '${executorMemberId}' is not an active captured contributor`,
        };
      }

      // 8. Check for any live payment already recorded (I3 / I4)
      const livePaymentRes = await client.query(
        `SELECT id, status, sender_batch_id FROM payments 
         WHERE proposal_id = $1 AND kind = 'PAYOUT' AND status NOT IN ('FAILED', 'RETURNED')`,
        [proposalId]
      );
      const existingLivePayment = livePaymentRes.rows.length > 0;

      // 9. Query Active Policy
      const policyRes = await client.query(
        `SELECT policy, version FROM policies WHERE group_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
        [groupId]
      );
      if (policyRes.rows.length === 0) {
        throw new Error(`Active policy not found for group '${groupId}'`);
      }
      const policyData = policyRes.rows[0].policy;
      const policyVersion = policyRes.rows[0].version;

      // 10. Query Curated Vendor (if specified)
      let vendorData = undefined;
      if (propRow.vendor_id) {
        const vendorRes = await client.query(
          `SELECT id, name, paypal_email, category, verified, source FROM vendors WHERE id = $1`,
          [propRow.vendor_id]
        );
        if (vendorRes.rows.length > 0) {
          vendorData = vendorRes.rows[0];
          vendorEmail = vendorData.paypal_email;
        }
      }

      // 11. Query Recorded Votes
      const votesRes = await client.query(
        `SELECT proposal_id, member_id, kind, choice, created_at FROM votes WHERE proposal_id = $1 ORDER BY created_at ASC`,
        [proposalId]
      );
      const votes = votesRes.rows.map((r) => ({
        proposal_id: r.proposal_id,
        member_id: r.member_id,
        kind: r.kind as 'VOTE' | 'VETO',
        choice: r.choice as 'APPROVE' | 'REJECT' | 'VETO',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
      }));

      // 12. Compute Financial Balances from Append-Only Ledger (§4.3)
      const ledgerRes = await client.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
           COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_REFUNDED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
           COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
           COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
           COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
         FROM ledger_events WHERE group_id = $1`,
        [groupId]
      );
      const ledger = ledgerRes.rows[0];
      const captured = parseInt(ledger.captured, 10);
      const refunded = parseInt(ledger.refunded, 10);
      const paid = parseInt(ledger.paid, 10);
      const reserved = parseInt(ledger.reserved, 10);
      const released = parseInt(ledger.released, 10);

      const netReserved = Math.max(0, reserved - released);
      const availableCents = captured - refunded - paid - netReserved;
      const fundingReady = groupRow.status === 'ACTIVE';

      // 13. Re-run Quorum Guard in EXECUTION Phase inside the Row Lock
      const guardInput: GuardInput = {
        phase: 'EXECUTION',
        now: nowIso,
        policy: policyData,
        group: {
          id: groupRow.id,
          mode: groupRow.mode,
          status: groupRow.status,
        },
        proposal: {
          id: propRow.id,
          group_id: propRow.group_id,
          type: propRow.type,
          status: propRow.status,
          created_by_kind: propRow.created_by_kind,
          created_by: propRow.created_by,
          policy_version: propRow.policy_version,
          vendor_id: propRow.vendor_id,
          category: propRow.category,
          amount_cents: propRow.amount_cents,
          payload: propRow.payload || {},
          voting_deadline: propRow.voting_deadline ? new Date(propRow.voting_deadline).toISOString() : undefined,
          veto_ends_at: propRow.veto_ends_at ? new Date(propRow.veto_ends_at).toISOString() : undefined,
        },
        votes,
        eligibleVoters,
        vendor: vendorData,
        funds: {
          availableCents,
          reservedCents: netReserved,
          fundingReady,
        },
        existingLivePayment,
      };

      const guardResult = evaluate(guardInput);

      // 14. Audit Log: Insert Guard Decision
      await client.query(
        `INSERT INTO guard_decisions (proposal_id, phase, policy_version, input_snapshot, result, decision)
         VALUES ($1, 'EXECUTION', $2, $3, $4, $5)`,
        [
          proposalId,
          policyVersion,
          JSON.stringify(guardInput),
          JSON.stringify(guardResult),
          guardResult.decision,
        ]
      );

      // 15. If Guard blocks execution, abort and do not reserve funds
      if (!guardResult.executionAllowed) {
        return {
          allowed: false,
          guardResult,
        };
      }

      // 16. Calculate Attempt Number from historical payments for this proposal
      const countRes = await client.query(
        `SELECT COUNT(*)::int as count FROM payments WHERE proposal_id = $1`,
        [proposalId]
      );
      attemptNumber = (countRes.rows[0]?.count || 0) + 1;
      senderBatchId = `q_${proposalId}_${attemptNumber}`;

      // 17. Insert Payment row in CREATED status
      const paymentInsertRes = await client.query(
        `INSERT INTO payments (group_id, proposal_id, kind, status, amount_cents, sender_batch_id)
         VALUES ($1, $2, 'PAYOUT', 'CREATED', $3, $4)
         RETURNING id`,
        [groupId, proposalId, proposalAmountCents, senderBatchId]
      );
      paymentId = paymentInsertRes.rows[0].id;

      // 18. Append FUNDS_RESERVED to Ledger
      await client.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, ref_type, ref_id, amount_cents, data)
         VALUES ($1, 'FUNDS_RESERVED', 'MEMBER', $2, 'PROPOSAL', $3, $4, $5)`,
        [
          groupId,
          executorMemberId,
          proposalId,
          proposalAmountCents,
          JSON.stringify({ payment_id: paymentId, sender_batch_id: senderBatchId }),
        ]
      );

      // 19. Advance Proposal Status to EXECUTING
      await client.query(
        `UPDATE proposals SET status = 'EXECUTING' WHERE id = $1`,
        [proposalId]
      );

      // COMMIT ends here. Row lock is automatically released!
      return {
        allowed: true,
        guardResult,
        paymentId,
        senderBatchId,
        proposalAmountCents,
        vendorEmail,
        attemptNumber,
      };
    });
  } catch (err: any) {
    if (
      err.code === '23505' ||
      err.message?.includes('duplicate key') ||
      err.message?.includes('already exists')
    ) {
      return {
        success: false,
        phase: 'GUARD_BLOCKED',
        error: 'Concurrent payment execution blocked by unique database constraint (one_live_payment_per_proposal)',
      };
    }
    throw err;
  }

  if (!preExecution.allowed) {
    return {
      success: false,
      phase: 'GUARD_BLOCKED',
      guardResult: preExecution.guardResult,
      error: preExecution.error,
    };
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Outside DB Transaction: Invoke Payment Adapter (PayPal API)
  // (Notice: The PostgreSQL row lock is NOT held during external network calls!)
  // ---------------------------------------------------------------------------
  try {
    const outcome = await adapter.executePayment({
      groupId,
      proposalId,
      amountCents: proposalAmountCents,
      vendorEmail: vendorEmail,
      senderBatchId,
      attempt: attemptNumber,
    });

    // -------------------------------------------------------------------------
    // STEP 3: Record External Outcome in Database
    // -------------------------------------------------------------------------
    await recordOutcome({
      pool,
      groupId,
      proposalId,
      paymentId,
      proposalAmountCents,
      outcome,
    });

    return {
      success: true,
      phase: outcome.status === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_SUBMITTED',
      paymentId,
      senderBatchId,
      paypalBatchId: outcome.batchId,
      guardResult: preExecution.guardResult,
    };
  } catch (err: any) {
    if (err instanceof DefinitePaymentFailure) {
      // Definite failure (e.g. 4xx business error or invalid credentials):
      // Mark payment FAILED, release reserved funds, mark proposal EXECUTION_FAILED
      await recordOutcome({
        pool,
        groupId,
        proposalId,
        paymentId,
        proposalAmountCents,
        outcome: {
          status: 'FAILED',
          batchId: '',
          rawResponse: err.rawResponse,
        },
        errorCode: err.code || err.message,
      });

      return {
        success: false,
        phase: 'PAYMENT_FAILED',
        paymentId,
        senderBatchId,
        error: err.message,
        guardResult: preExecution.guardResult,
      };
    }

    // Ambiguous failure: network drop, timeout, 5xx, or unparseable body.
    // The payment remains in 'CREATED' status with funds reserved.
    // Proposal remains in 'EXECUTING'. Recovery retries with the exact same senderBatchId.
    return {
      success: false,
      phase: 'PAYMENT_PENDING_RECOVERY',
      paymentId,
      senderBatchId,
      error: err.message,
      guardResult: preExecution.guardResult,
    };
  }
}

/**
 * Crash Recovery: Resumes any payment stuck in 'CREATED' status
 * (e.g. if the process died between DB commit and the PayPal call)
 * Uses FOR UPDATE SKIP LOCKED to prevent race conditions among recovery workers.
 */
export async function resumeCreatedPayments(params: {
  groupId: string;
  pool: pg.Pool;
  adapter: VendorPaymentAdapter;
  olderThanSeconds?: number;
}): Promise<ExecutionTransactionResult[]> {
  const { groupId, pool, adapter, olderThanSeconds = 60 } = params;
  const results: ExecutionTransactionResult[] = [];

  // Claim stuck payments using standard PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED
  const claimedPayments = await withTransaction(pool, async (client) => {
    const res = await client.query(
      `SELECT id, proposal_id, amount_cents, sender_batch_id
       FROM payments
       WHERE group_id = $1 
         AND status = 'CREATED'
         AND updated_at <= NOW() - ($2 || ' seconds')::interval
       FOR UPDATE SKIP LOCKED`,
      [groupId, olderThanSeconds]
    );

    // Bump updated_at immediately so concurrent workers skip these rows
    if (res.rows.length > 0) {
      const ids = res.rows.map((r) => r.id);
      await client.query(
        `UPDATE payments SET updated_at = NOW() WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }

    return res.rows;
  });

  for (const row of claimedPayments) {
    const propRes = await pool.query(
      `SELECT vendor_id FROM proposals WHERE id = $1`,
      [row.proposal_id]
    );
    const vendorId = propRes.rows[0]?.vendor_id;
    if (!vendorId) continue;

    const vendorRes = await pool.query(
      `SELECT paypal_email FROM vendors WHERE id = $1`,
      [vendorId]
    );
    const vendorEmail = vendorRes.rows[0]?.paypal_email;
    if (!vendorEmail) continue;

    try {
      const outcome = await adapter.executePayment({
        groupId,
        proposalId: row.proposal_id,
        amountCents: row.amount_cents,
        vendorEmail,
        senderBatchId: row.sender_batch_id,
      });

      await recordOutcome({
        pool,
        groupId,
        proposalId: row.proposal_id,
        paymentId: row.id,
        proposalAmountCents: row.amount_cents,
        outcome,
      });

      results.push({
        success: true,
        phase: outcome.status === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_SUBMITTED',
        paymentId: row.id,
        senderBatchId: row.sender_batch_id,
        paypalBatchId: outcome.batchId,
      });
    } catch (err: any) {
      if (err instanceof DefinitePaymentFailure) {
        await recordOutcome({
          pool,
          groupId,
          proposalId: row.proposal_id,
          paymentId: row.id,
          proposalAmountCents: row.amount_cents,
          outcome: {
            status: 'FAILED',
            batchId: '',
            rawResponse: err.rawResponse,
          },
          errorCode: err.code || err.message,
        });

        results.push({
          success: false,
          phase: 'PAYMENT_FAILED',
          paymentId: row.id,
          senderBatchId: row.sender_batch_id,
          error: err.message,
        });
      } else {
        // Ambiguous failure during recovery: leave in CREATED for subsequent recovery
        results.push({
          success: false,
          phase: 'PAYMENT_PENDING_RECOVERY',
          paymentId: row.id,
          senderBatchId: row.sender_batch_id,
          error: err.message,
        });
      }
    }
  }

  return results;
}
