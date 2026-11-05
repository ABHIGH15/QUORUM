/**
 * Quorum Payment Execution Transaction & Concurrency Tests
 * 
 * Verifies:
 * - Direct PostgreSQL interactive row-lock transaction
 * - Guard re-evaluation in EXECUTION phase inside the lock
 * - Post-commit PayPal API invocation
 * - Concurrency guarantee: Two simultaneous Execute clicks produce exactly ONE payment
 * - one_live_payment_per_proposal constraint as backstop
 * - Ambiguous failure handling: payment left in CREATED, funds kept reserved, retry reuses sender_batch_id
 * - Definite failure handling: payment marked FAILED, funds released, proposal EXECUTION_FAILED
 * - Double-deduction balance invariant: sequential purchases subtract exactly the purchased amounts
 * - Proposal status validation: non-executable proposals rejected
 * - Executor validation: active captured contributor required (I7)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import { createTestDb } from '../lib/db/test-db';
import { executeProposalPayment, resumeCreatedPayments } from '../lib/payments/transaction';
import {
  VendorPaymentAdapter,
  PaymentExecutionParams,
  PaymentExecutionOutcome,
  DefinitePaymentFailure,
  AmbiguousPaymentFailure,
} from '../lib/payments/types';

class MockPayoutAdapter implements VendorPaymentAdapter {
  public callCount = 0;
  public lastParams: PaymentExecutionParams | null = null;
  public failureType: 'NONE' | 'DEFINITE' | 'AMBIGUOUS' = 'NONE';
  public returnStatus: 'PENDING' | 'SUCCEEDED' | 'UNCLAIMED' = 'SUCCEEDED';
  public duplicateOnAttempt2 = false;

  async executePayment(params: PaymentExecutionParams): Promise<PaymentExecutionOutcome> {
    this.callCount++;
    this.lastParams = params;

    if (this.failureType === 'DEFINITE') {
      throw new DefinitePaymentFailure('PayPal business error: Invalid receiver', 'BUSINESS_ERROR');
    }

    if (this.failureType === 'AMBIGUOUS') {
      throw new AmbiguousPaymentFailure('PayPal connection timeout after 15s', 'TIMEOUT');
    }

    if (this.duplicateOnAttempt2 && this.callCount > 1) {
      // Simulate duplicate recovery
      return {
        status: 'SUCCEEDED',
        batchId: 'BATCH_RECOVERED_123',
        itemId: 'ITEM_RECOVERED_456',
        rawResponse: { duplicate: true },
        recoveredDuplicate: true,
      };
    }

    return {
      status: this.returnStatus,
      batchId: `BATCH_${params.senderBatchId}`,
      itemId: `ITEM_${params.senderBatchId}`,
      rawResponse: { success: true },
      recoveredDuplicate: false,
    };
  }
}

describe('Payment Transaction - Core Execution & Concurrency', () => {
  let pool: pg.Pool;
  let mockAdapter: MockPayoutAdapter;

  const testGroupId = '22222222-2222-2222-2222-222222222222';
  const testProposalId = '33333333-3333-3333-3333-333333333333';
  const testRoundId = '55555555-5555-5555-5555-555555555555';
  const testVendorId = 'v_projector_shop';

  const userIds = [
    '11111111-1111-1111-1111-111111111101',
    '11111111-1111-1111-1111-111111111102',
    '11111111-1111-1111-1111-111111111103',
    '11111111-1111-1111-1111-111111111104',
    '11111111-1111-1111-1111-111111111105',
    '11111111-1111-1111-1111-111111111106',
    '11111111-1111-1111-1111-111111111107', // Non-contributing user
  ];

  const memberAsha = '44444444-4444-4444-4444-444444444401';
  const memberBen = '44444444-4444-4444-4444-444444444402';
  const memberChloe = '44444444-4444-4444-4444-444444444403';
  const memberDev = '44444444-4444-4444-4444-444444444404';
  const memberElena = '44444444-4444-4444-4444-444444444405';
  const memberFarid = '44444444-4444-4444-4444-444444444406';
  const memberNonContributor = '44444444-4444-4444-4444-444444444407';

  beforeEach(async () => {
    const testDb = createTestDb();
    pool = testDb.pool;
    mockAdapter = new MockPayoutAdapter();

    // 1. Seed Users (7 users)
    const names = ['Asha Patel', 'Ben Miller', 'Chloe Chen', 'Dev Sharma', 'Elena Rostova', 'Farid Al-Mansoor', 'Ghost User'];
    for (let i = 0; i < 7; i++) {
      await pool.query(
        `INSERT INTO users (id, display_name, paypal_sandbox_email)
         VALUES ($1, $2, $3)`,
        [userIds[i], names[i], `user${i + 1}@sandbox.quorum.app`]
      );
    }

    // 2. Seed Group
    await pool.query(
      `INSERT INTO groups (id, name, mode, status, currency, created_by)
       VALUES ($1, 'Quorum Demo Club', 'POOLED', 'ACTIVE', 'USD', $2)`,
      [testGroupId, userIds[0]]
    );

    // 3. Seed Memberships (6 active contributors + 1 non-contributor)
    const memberIds = [memberAsha, memberBen, memberChloe, memberDev, memberElena, memberFarid];
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `INSERT INTO memberships (id, group_id, user_id, role, status)
         VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE')`,
        [memberIds[i], testGroupId, userIds[i]]
      );
    }
    await pool.query(
      `INSERT INTO memberships (id, group_id, user_id, role, status)
       VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE')`,
      [memberNonContributor, testGroupId, userIds[6]]
    );

    // 4. Seed Active Policy ($480 budget, $200 hard cap, $150 unanimity)
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

    // 5. Seed Vendor
    await pool.query(
      `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
       VALUES ($1, 'Projector Shop', 'vendor@sandbox.quorum.app', 'equipment', true, 'CATALOG')`,
      [testVendorId]
    );

    // 6. Seed Funding Round & 6 Captured Contributions ($480 total)
    await pool.query(
      `INSERT INTO funding_rounds (id, group_id, status, per_member_cents, min_contributors, authorization_deadline)
       VALUES ($1, $2, 'FUNDED', 8000, 6, '2026-11-04T12:00:00Z')`,
      [testRoundId, testGroupId]
    );

    for (const mId of memberIds) {
      await pool.query(
        `INSERT INTO contributions (round_id, member_id, amount_cents, status)
         VALUES ($1, $2, 8000, 'CAPTURED')`,
        [testRoundId, mId]
      );
      await pool.query(
        `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents)
         VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', $2, 8000)`,
        [testGroupId, mId]
      );
    }

    // 7. Seed Proposal ($145.00 Projector, EXECUTABLE, 4 votes required)
    await pool.query(
      `INSERT INTO proposals (
        id, group_id, type, status, created_by_kind, policy_version,
        vendor_id, category, amount_cents, payload, veto_ends_at
       ) VALUES (
        $1, $2, 'PURCHASE', 'EXECUTABLE', 'AGENT', 1,
        $3, 'equipment', 14500, '{}', '2026-11-05T12:00:00Z'
       )`,
      [testProposalId, testGroupId, testVendorId]
    );

    // 8. Seed 4 Approvals (reaching Tier 2 threshold)
    for (const mId of [memberAsha, memberBen, memberChloe, memberDev]) {
      await pool.query(
        `INSERT INTO votes (proposal_id, member_id, kind, choice)
         VALUES ($1, $2, 'VOTE', 'APPROVE')`,
        [testProposalId, mId]
      );
    }
  });

  it('Happy Path: Re-runs Guard in EXECUTION phase, reserves funds, commits, calls adapter, marks EXECUTED and logs FUNDS_RELEASED', async () => {
    const result = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('PAYMENT_SUCCEEDED');
    expect(result.senderBatchId).toBe(`q_${testProposalId}_1`);
    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastParams?.amountCents).toBe(14500);
    expect(mockAdapter.lastParams?.vendorEmail).toBe('vendor@sandbox.quorum.app');

    // Verify DB state
    const paymentRows = await pool.query(`SELECT * FROM payments WHERE proposal_id = $1`, [testProposalId]);
    expect(paymentRows.rows).toHaveLength(1);
    expect(paymentRows.rows[0].status).toBe('SUCCEEDED');
    expect(paymentRows.rows[0].sender_batch_id).toBe(`q_${testProposalId}_1`);

    // Verify Ledger events: Must contain FUNDS_RESERVED, PAYOUT_SUCCEEDED, and FUNDS_RELEASED
    const ledgerRows = await pool.query(
      `SELECT type, amount_cents FROM ledger_events WHERE group_id = $1 ORDER BY id ASC`,
      [testGroupId]
    );
    const types = ledgerRows.rows.map((r) => r.type);
    expect(types).toContain('FUNDS_RESERVED');
    expect(types).toContain('PAYOUT_SUCCEEDED');
    expect(types).toContain('FUNDS_RELEASED');

    // Verify Proposal status
    const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(propRes.rows[0].status).toBe('EXECUTED');

    // Verify Guard Decision Audit Row
    const auditRes = await pool.query(`SELECT phase, decision FROM guard_decisions WHERE proposal_id = $1`, [testProposalId]);
    expect(auditRes.rows).toHaveLength(1);
    expect(auditRes.rows[0].phase).toBe('EXECUTION');
    expect(auditRes.rows[0].decision).toBe('APPROVED');
  });

  it('Double-Deduction Balance Invariant: Sequential purchases subtract exactly purchased amounts', async () => {
    // Helper to query available cents from ledger
    const getAvailableCents = async () => {
      const ledgerRes = await pool.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
           COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_REFUNDED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
           COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
           COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
           COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
         FROM ledger_events WHERE group_id = $1`,
        [testGroupId]
      );
      const l = ledgerRes.rows[0];
      const netReserved = Math.max(0, parseInt(l.reserved, 10) - parseInt(l.released, 10));
      return parseInt(l.captured, 10) - parseInt(l.refunded, 10) - parseInt(l.paid, 10) - netReserved;
    };

    // Initial balance: $480.00
    expect(await getAvailableCents()).toBe(48000);

    // Purchase 1: $145.00
    const res1 = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(res1.success).toBe(true);

    // After Purchase 1: Available balance must be EXACTLY $335.00 ($480 - $145), NOT $190.00!
    expect(await getAvailableCents()).toBe(33500);

    // Purchase 2: Create second proposal for $100.00
    const proposal2Id = '33333333-3333-3333-3333-333333333334';
    await pool.query(
      `INSERT INTO proposals (
        id, group_id, type, status, created_by_kind, policy_version,
        vendor_id, category, amount_cents, payload, veto_ends_at
       ) VALUES (
        $1, $2, 'PURCHASE', 'EXECUTABLE', 'AGENT', 1,
        $3, 'equipment', 10000, '{}', '2026-11-05T12:00:00Z'
       )`,
      [proposal2Id, testGroupId, testVendorId]
    );

    // Seed 4 Approvals for proposal 2
    for (const mId of [memberAsha, memberBen, memberChloe, memberDev]) {
      await pool.query(
        `INSERT INTO votes (proposal_id, member_id, kind, choice)
         VALUES ($1, $2, 'VOTE', 'APPROVE')`,
        [proposal2Id, mId]
      );
    }

    const res2 = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: proposal2Id,
      executorMemberId: memberBen,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:06:00Z',
    });
    expect(res2.success).toBe(true);

    // After Purchase 2: Available balance must be EXACTLY $235.00 ($335 - $100)
    expect(await getAvailableCents()).toBe(23500);
  });

  it('Ambiguous Failure: Leaves payment CREATED and funds reserved; recovery retries with SAME sender_batch_id', async () => {
    mockAdapter.failureType = 'AMBIGUOUS';

    const result = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });

    // Ambiguous failure returns PAYMENT_PENDING_RECOVERY
    expect(result.success).toBe(false);
    expect(result.phase).toBe('PAYMENT_PENDING_RECOVERY');

    // Payment remains in CREATED status
    const paymentRes = await pool.query(`SELECT status, sender_batch_id FROM payments WHERE id = $1`, [result.paymentId]);
    expect(paymentRes.rows[0].status).toBe('CREATED');
    const firstSenderBatchId = paymentRes.rows[0].sender_batch_id;
    expect(firstSenderBatchId).toBe(`q_${testProposalId}_1`);

    // Proposal remains in EXECUTING status (not EXECUTION_FAILED)
    const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(propRes.rows[0].status).toBe('EXECUTING');

    // Ledger DOES NOT release funds (funds stay reserved during ambiguity)
    const releaseRes = await pool.query(
      `SELECT * FROM ledger_events WHERE group_id = $1 AND type = 'FUNDS_RELEASED'`,
      [testGroupId]
    );
    expect(releaseRes.rows).toHaveLength(0);

    // Now simulate crash recovery: network recovers and returns SUCCEEDED
    mockAdapter.failureType = 'NONE';
    const recovered = await resumeCreatedPayments({
      groupId: testGroupId,
      pool,
      adapter: mockAdapter,
      olderThanSeconds: 0,
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0].success).toBe(true);
    expect(recovered[0].phase).toBe('PAYMENT_SUCCEEDED');
    // Must reuse the exact same sender_batch_id!
    expect(recovered[0].senderBatchId).toBe(firstSenderBatchId);

    // DB state is now SUCCEEDED
    const finalPayment = await pool.query(`SELECT status FROM payments WHERE id = $1`, [result.paymentId]);
    expect(finalPayment.rows[0].status).toBe('SUCCEEDED');

    // Proposal is now EXECUTED
    const finalProp = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(finalProp.rows[0].status).toBe('EXECUTED');
  });

  it('Definite Failure: Marks payment FAILED, releases funds, and marks proposal EXECUTION_FAILED', async () => {
    mockAdapter.failureType = 'DEFINITE';

    const result = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });

    expect(result.success).toBe(false);
    expect(result.phase).toBe('PAYMENT_FAILED');

    // Payment marked FAILED
    const paymentRes = await pool.query(`SELECT status, error_code FROM payments WHERE id = $1`, [result.paymentId]);
    expect(paymentRes.rows[0].status).toBe('FAILED');
    expect(paymentRes.rows[0].error_code).toContain('BUSINESS_ERROR');

    // Ledger has FUNDS_RELEASED
    const releaseRes = await pool.query(
      `SELECT * FROM ledger_events WHERE group_id = $1 AND type = 'FUNDS_RELEASED'`,
      [testGroupId]
    );
    expect(releaseRes.rows).toHaveLength(1);
    expect(releaseRes.rows[0].amount_cents).toBe(14500);

    // Proposal marked EXECUTION_FAILED
    const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(propRes.rows[0].status).toBe('EXECUTION_FAILED');

    // Retry allowed on EXECUTION_FAILED proposal: creates attempt 2 with q_<propId>_2
    mockAdapter.failureType = 'NONE';
    const retryResult = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:10:00Z',
    });

    expect(retryResult.error).toBeUndefined();
    expect(retryResult.success).toBe(true);
    expect(retryResult.phase).toBe('PAYMENT_SUCCEEDED');
    expect(retryResult.senderBatchId).toBe(`q_${testProposalId}_2`);
  });

  it('Executor Validation (I7): Rejects non-contributing member, inactive member, or missing executor', async () => {
    // 1. Non-contributing member (memberNonContributor)
    const res1 = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberNonContributor,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(res1.success).toBe(false);
    expect(res1.phase).toBe('GUARD_BLOCKED');
    expect(res1.error).toContain('not an active captured contributor');

    // 2. Inactive member
    await pool.query(`UPDATE memberships SET status = 'LEFT' WHERE id = $1`, [memberFarid]);
    const res2 = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberFarid,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(res2.success).toBe(false);
    expect(res2.phase).toBe('GUARD_BLOCKED');
    expect(res2.error).toContain('is not ACTIVE');

    // 3. Missing executor ID
    const res3 = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: '',
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(res3.success).toBe(false);
    expect(res3.phase).toBe('GUARD_BLOCKED');
    expect(res3.error).toContain('mandatory');
  });

  it('Proposal Status Validation: Blocks non-executable proposals (DRAFT, OPEN, EXPIRED, VETO_WINDOW)', async () => {
    // Change proposal to OPEN
    await pool.query(`UPDATE proposals SET status = 'OPEN' WHERE id = $1`, [testProposalId]);

    const resOpen = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(resOpen.success).toBe(false);
    expect(resOpen.phase).toBe('GUARD_BLOCKED');
    expect(resOpen.error).toContain('is not executable');

    // Change proposal to EXPIRED
    await pool.query(`UPDATE proposals SET status = 'EXPIRED' WHERE id = $1`, [testProposalId]);

    const resExpired = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(resExpired.success).toBe(false);
    expect(resExpired.phase).toBe('GUARD_BLOCKED');
    expect(resExpired.error).toContain('is not executable');

    // VETO_WINDOW still active (deadline in future)
    await pool.query(
      `UPDATE proposals SET status = 'VETO_WINDOW', veto_ends_at = '2026-11-05T13:00:00Z' WHERE id = $1`,
      [testProposalId]
    );

    const resVetoActive = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z', // Before 13:00:00Z
    });
    expect(resVetoActive.success).toBe(false);
    expect(resVetoActive.phase).toBe('GUARD_BLOCKED');
    expect(resVetoActive.error).toContain('is not executable');
  });

  it('Guard Rejection in EXECUTION phase: Blocks payment if available funds are insufficient, reserves nothing', async () => {
    // Add reservation eating up all available funds
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, amount_cents)
       VALUES ($1, 'FUNDS_RESERVED', 'SYSTEM', 45000)`,
      [testGroupId]
    );

    const result = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberAsha,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });

    expect(result.success).toBe(false);
    expect(result.phase).toBe('GUARD_BLOCKED');
    expect(result.guardResult?.decision).toBe('BLOCKED');
    expect(result.guardResult?.reasonCodes).toContain('BUDGET_EXCEEDED');

    // Adapter must NOT have been called
    expect(mockAdapter.callCount).toBe(0);

    // No payment record created
    const payments = await pool.query(`SELECT * FROM payments WHERE proposal_id = $1`, [testProposalId]);
    expect(payments.rows).toHaveLength(0);

    // Proposal remains in EXECUTABLE status
    const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(propRes.rows[0].status).toBe('EXECUTABLE');
  });

  it('Concurrency Invariant: Two simultaneous Execute clicks produce exactly ONE payment and ONE block', async () => {
    // Simulate simultaneous Execute clicks from two browser tabs / members
    const [result1, result2] = await Promise.all([
      executeProposalPayment({
        groupId: testGroupId,
        proposalId: testProposalId,
        executorMemberId: memberAsha,
        pool,
        adapter: mockAdapter,
        now: '2026-11-05T12:05:00Z',
      }),
      executeProposalPayment({
        groupId: testGroupId,
        proposalId: testProposalId,
        executorMemberId: memberBen,
        pool,
        adapter: mockAdapter,
        now: '2026-11-05T12:05:00Z',
      }),
    ]);

    // Exactly one must succeed
    const successes = [result1, result2].filter((r) => r.success);
    const failures = [result1, result2].filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    expect(successes[0].phase).toBe('PAYMENT_SUCCEEDED');
    expect(failures[0].phase).toBe('GUARD_BLOCKED');
    if (failures[0].guardResult) {
      expect(failures[0].guardResult.decision).toBe('BLOCKED');
      expect(failures[0].guardResult.reasonCodes).toContain('DUPLICATE_EXECUTION');
    } else {
      expect(failures[0].error).toMatch(/one_live_payment_per_proposal|is not executable/);
    }

    // Sequential second click after payment: Quorum Guard directly blocks with DUPLICATE_EXECUTION or non-executable
    const thirdResult = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      executorMemberId: memberChloe,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });
    expect(thirdResult.success).toBe(false);
    expect(thirdResult.phase).toBe('GUARD_BLOCKED');

    // Exactly 1 payment in DB
    const payments = await pool.query(`SELECT * FROM payments WHERE proposal_id = $1`, [testProposalId]);
    expect(payments.rows).toHaveLength(1);

    // Exactly 1 PayPal API call made
    expect(mockAdapter.callCount).toBe(1);

    // Exactly 1 FUNDS_RESERVED in ledger
    const reservations = await pool.query(
      `SELECT * FROM ledger_events WHERE group_id = $1 AND type = 'FUNDS_RESERVED'`,
      [testGroupId]
    );
    expect(reservations.rows).toHaveLength(1);
  });
});
