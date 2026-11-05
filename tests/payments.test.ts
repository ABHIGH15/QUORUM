/**
 * Quorum Payment Execution Transaction & Concurrency Tests
 * 
 * Verifies:
 * - Direct PostgreSQL interactive row-lock transaction
 * - Guard re-evaluation in EXECUTION phase inside the lock
 * - Post-commit PayPal API invocation
 * - Concurrency guarantee: Two simultaneous Execute clicks produce exactly ONE payment
 * - one_live_payment_per_proposal constraint as backstop
 * - Crash recovery: Resuming payments stuck in CREATED status
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import { createTestDb } from '../lib/db/test-db';
import { executeProposalPayment, resumeCreatedPayments } from '../lib/payments/transaction';
import { VendorPaymentAdapter, PaymentExecutionParams, PaymentExecutionOutcome } from '../lib/payments/types';

class MockPayoutAdapter implements VendorPaymentAdapter {
  public callCount = 0;
  public lastParams: PaymentExecutionParams | null = null;
  public shouldFail = false;
  public returnStatus: 'PENDING' | 'SUCCEEDED' = 'SUCCEEDED';
  public duplicateOnAttempt2 = false;

  async executePayment(params: PaymentExecutionParams): Promise<PaymentExecutionOutcome> {
    this.callCount++;
    this.lastParams = params;

    if (this.shouldFail) {
      throw new Error('Simulated PayPal API network error');
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
  const testVendorId = 'v_projector_shop';

  const userIds = [
    '11111111-1111-1111-1111-111111111101',
    '11111111-1111-1111-1111-111111111102',
    '11111111-1111-1111-1111-111111111103',
    '11111111-1111-1111-1111-111111111104',
    '11111111-1111-1111-1111-111111111105',
    '11111111-1111-1111-1111-111111111106',
  ];

  const memberAsha = '44444444-4444-4444-4444-444444444401';
  const memberBen = '44444444-4444-4444-4444-444444444402';
  const memberChloe = '44444444-4444-4444-4444-444444444403';
  const memberDev = '44444444-4444-4444-4444-444444444404';
  const memberElena = '44444444-4444-4444-4444-444444444405';
  const memberFarid = '44444444-4444-4444-4444-444444444406';

  beforeEach(async () => {
    const testDb = createTestDb();
    pool = testDb.pool;
    mockAdapter = new MockPayoutAdapter();

    // 1. Seed Users (6 users)
    const names = ['Asha Patel', 'Ben Miller', 'Chloe Chen', 'Dev Sharma', 'Elena Rostova', 'Farid Al-Mansoor'];
    for (let i = 0; i < 6; i++) {
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

    // 3. Seed Memberships (6 members)
    const memberIds = [memberAsha, memberBen, memberChloe, memberDev, memberElena, memberFarid];
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `INSERT INTO memberships (id, group_id, user_id, role, status)
         VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE')`,
        [memberIds[i], testGroupId, userIds[i]]
      );
    }

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

    // 6. Seed Ledger Funds ($480.00 captured contributions)
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, amount_cents)
       VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', 48000)`,
      [testGroupId]
    );

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

  it('Happy Path: Re-runs Guard in EXECUTION phase, reserves funds, commits, calls adapter, marks EXECUTED', async () => {
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

    // Verify Ledger events
    const ledgerRows = await pool.query(
      `SELECT type, amount_cents FROM ledger_events WHERE group_id = $1 ORDER BY id ASC`,
      [testGroupId]
    );
    const types = ledgerRows.rows.map((r) => r.type);
    expect(types).toContain('FUNDS_RESERVED');
    expect(types).toContain('PAYOUT_SUCCEEDED');

    // Verify Proposal status
    const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
    expect(propRes.rows[0].status).toBe('EXECUTED');

    // Verify Guard Decision Audit Row
    const auditRes = await pool.query(`SELECT phase, decision FROM guard_decisions WHERE proposal_id = $1`, [testProposalId]);
    expect(auditRes.rows).toHaveLength(1);
    expect(auditRes.rows[0].phase).toBe('EXECUTION');
    expect(auditRes.rows[0].decision).toBe('APPROVED');
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
      expect(failures[0].error).toContain('one_live_payment_per_proposal');
    }

    // Sequential second click after payment: Quorum Guard directly blocks with DUPLICATE_EXECUTION
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
    expect(thirdResult.guardResult?.decision).toBe('BLOCKED');
    expect(thirdResult.guardResult?.reasonCodes).toContain('DUPLICATE_EXECUTION');

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

  it('Payment API Failure: Releases reserved funds, marks payment FAILED and proposal EXECUTION_FAILED', async () => {
    mockAdapter.shouldFail = true;

    const result = await executeProposalPayment({
      groupId: testGroupId,
      proposalId: testProposalId,
      pool,
      adapter: mockAdapter,
      now: '2026-11-05T12:05:00Z',
    });

    // Payment marked FAILED
    const paymentRes = await pool.query(`SELECT status, error_code FROM payments WHERE id = $1`, [result.paymentId]);
    expect(paymentRes.rows[0].status).toBe('FAILED');
    expect(paymentRes.rows[0].error_code).toContain('Simulated PayPal API network error');

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
  });

  it('Crash Recovery: Resumes payments stuck in CREATED status using identical deterministic sender_batch_id', async () => {
    // Manually insert a payment stuck in CREATED (simulating crash after commit, before PayPal call)
    const stuckBatchId = `q_${testProposalId}_1`;
    await pool.query(
      `INSERT INTO payments (group_id, proposal_id, kind, status, amount_cents, sender_batch_id)
       VALUES ($1, $2, 'PAYOUT', 'CREATED', 14500, $3)`,
      [testGroupId, testProposalId, stuckBatchId]
    );

    const recovered = await resumeCreatedPayments({
      groupId: testGroupId,
      pool,
      adapter: mockAdapter,
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0].success).toBe(true);
    expect(recovered[0].senderBatchId).toBe(stuckBatchId);
    expect(mockAdapter.callCount).toBe(1);
    expect(mockAdapter.lastParams?.senderBatchId).toBe(stuckBatchId);

    // DB record updated to SUCCEEDED
    const payment = await pool.query(`SELECT status FROM payments WHERE sender_batch_id = $1`, [stuckBatchId]);
    expect(payment.rows[0].status).toBe('SUCCEEDED');
  });
});
