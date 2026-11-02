/**
 * Quorum Funding State Machine Test Suite
 * 
 * Verifies:
 * - Deterministic idempotency keys (cap_<id>_<att>, reauth_<id>_<att>, void_<id>, ref_<id>)
 * - 3-day honor window and reauthorization logic
 * - Capture retry intervals and attempt clamping
 * - Funding round lifecycle: OPEN -> CAPTURING -> FUNDED | PARTIAL_FAILURE
 * - Illegal state transition guards
 * - S4 partial failure proposal generation and Quorum Guard integration
 */

import { describe, it, expect } from 'vitest';
import {
  FundingRound,
  Contribution,
  FundingPolicySnapshot,
  canRoundTransition,
  assertRoundTransition,
  IllegalTransitionError,
  canContributionTransition,
  assertContributionTransition,
  evaluateRoundStatus,
  getCaptureRequestId,
  getReauthRequestId,
  getVoidRequestId,
  getRefundRequestId,
  calculateHonorWindow,
  calculateAuthExpiration,
  needsReauthorization,
  isAuthorizationExpired,
  shouldRetryCapture,
  createPartialFailureProposals,
} from '../lib/funding';
import { evaluate } from '../lib/guard';
import { Policy } from '../lib/guard/types';

const baseFundingPolicy: FundingPolicySnapshot = {
  per_member_cents: 8000,
  min_contributors: 6,
  authorization_window_hours: 48,
  capture_retry_attempts: 2,
  capture_retry_interval_minutes: 2,
  partial_failure_decision: 'GROUP_VOTE',
  partial_failure_default: 'UNWIND',
  reduced_budget_votes_required: 'MAJORITY_OF_CONTRIBUTORS',
};

const baseGuardPolicy: Policy = {
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
    allowlist_vendor_ids: ['v_projector_shop'],
  },
  categories_allowed: ['equipment'],
  funding: { ...baseFundingPolicy },
  amendment_votes_required: 4,
};

function createMockRound(overrides: Partial<FundingRound> = {}): FundingRound {
  return {
    id: 'round_test_1',
    group_id: 'grp_test',
    status: 'OPEN',
    per_member_cents: 8000,
    min_contributors: 6,
    authorization_deadline: '2026-11-04T12:00:00.000Z',
    decision_deadline: '2026-11-05T12:00:00.000Z',
    created_at: '2026-11-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('Funding - Deterministic Request IDs & Invariants', () => {
  it('generates exact deterministic idempotency keys compliant with SPEC §8.2', () => {
    expect(getCaptureRequestId('c_asha_1', 1)).toBe('cap_c_asha_1_1');
    expect(getCaptureRequestId('c_asha_1', 2)).toBe('cap_c_asha_1_2');
    expect(getReauthRequestId('c_asha_1', 1)).toBe('reauth_c_asha_1_1');
    expect(getVoidRequestId('c_asha_1')).toBe('void_c_asha_1');
    expect(getRefundRequestId('c_asha_1')).toBe('ref_c_asha_1');
  });

  it('calculates 3-day honor window and 29-day authorization expiration', () => {
    const authAt = '2026-11-02T12:00:00.000Z';
    const honorExp = calculateHonorWindow(authAt);
    const authExp = calculateAuthExpiration(authAt);

    expect(honorExp).toBe('2026-11-05T12:00:00.000Z'); // Exactly 3 days (72 hours)
    expect(authExp).toBe('2026-12-01T12:00:00.000Z');  // Exactly 29 days
  });

  it('detects when reauthorization is needed (now > honor_expires_at)', () => {
    const contribution: Contribution = {
      id: 'c_1',
      round_id: 'round_1',
      member_id: 'm_asha',
      amount_cents: 8000,
      status: 'AUTHORIZED',
      authorized_at: '2026-11-02T12:00:00.000Z',
      honor_expires_at: '2026-11-05T12:00:00.000Z',
      authorization_expires_at: '2026-12-01T12:00:00.000Z',
      capture_attempts: 0,
    };

    // Day 2 (within honor window): No reauth needed
    expect(needsReauthorization(contribution, '2026-11-04T12:00:00.000Z')).toBe(false);

    // Day 4 (past honor window): Reauth required!
    expect(needsReauthorization(contribution, '2026-11-06T12:00:00.000Z')).toBe(true);

    // Day 30 (past authorization expiration): Fully expired
    expect(isAuthorizationExpired(contribution, '2026-12-02T12:00:00.000Z')).toBe(true);
  });

  it('controls retry countdown and max attempts clamping', () => {
    const contribution: Contribution = {
      id: 'c_retry',
      round_id: 'round_1',
      member_id: 'm_farid',
      amount_cents: 8000,
      status: 'CAPTURE_FAILED',
      capture_attempts: 1,
      next_retry_at: '2026-11-02T12:05:00.000Z',
    };

    // Before next_retry_at -> wait
    expect(shouldRetryCapture(contribution, 3, '2026-11-02T12:04:00.000Z')).toBe(false);

    // At or after next_retry_at -> retry
    expect(shouldRetryCapture(contribution, 3, '2026-11-02T12:05:00.000Z')).toBe(true);
    expect(shouldRetryCapture(contribution, 3, '2026-11-02T12:06:00.000Z')).toBe(true);

    // When max attempts (e.g. 3) exhausted -> no retry
    const exhausted: Contribution = { ...contribution, capture_attempts: 3 };
    expect(shouldRetryCapture(exhausted, 3, '2026-11-02T12:10:00.000Z')).toBe(false);
  });
});

describe('Funding - State Machine Transitions & Invariants', () => {
  it('enforces legal round transitions and blocks illegal state jumps', () => {
    expect(canRoundTransition('OPEN', 'CAPTURING')).toBe(true);
    expect(canRoundTransition('OPEN', 'CANCELLED')).toBe(true);
    expect(canRoundTransition('CAPTURING', 'FUNDED')).toBe(true);
    expect(canRoundTransition('CAPTURING', 'PARTIAL_FAILURE')).toBe(true);
    expect(canRoundTransition('PARTIAL_FAILURE', 'AWAITING_GROUP_DECISION')).toBe(true);
    expect(canRoundTransition('AWAITING_GROUP_DECISION', 'FUNDED_REDUCED')).toBe(true);
    expect(canRoundTransition('AWAITING_GROUP_DECISION', 'UNWINDING')).toBe(true);
    expect(canRoundTransition('UNWINDING', 'UNWOUND')).toBe(true);

    // Illegal jumps
    expect(canRoundTransition('OPEN', 'FUNDED')).toBe(false);
    expect(canRoundTransition('OPEN', 'UNWOUND')).toBe(false);
    expect(canRoundTransition('FUNDED', 'OPEN')).toBe(false);
    expect(canRoundTransition('CANCELLED', 'CAPTURING')).toBe(false);

    expect(() => assertRoundTransition('OPEN', 'FUNDED')).toThrow(IllegalTransitionError);
  });

  it('enforces legal contribution transitions', () => {
    expect(canContributionTransition('PENDING_APPROVAL', 'AUTHORIZED')).toBe(true);
    expect(canContributionTransition('AUTHORIZED', 'CAPTURE_PENDING')).toBe(true);
    expect(canContributionTransition('CAPTURE_PENDING', 'CAPTURED')).toBe(true);
    expect(canContributionTransition('CAPTURE_PENDING', 'CAPTURE_FAILED')).toBe(true);
    expect(canContributionTransition('CAPTURE_FAILED', 'CAPTURE_PENDING')).toBe(true); // retry
    expect(canContributionTransition('CAPTURED', 'REFUNDED')).toBe(true);

    // Illegal jump: cannot capture directly from pending approval
    expect(canContributionTransition('PENDING_APPROVAL', 'CAPTURED')).toBe(false);
    expect(() => assertContributionTransition('PENDING_APPROVAL', 'CAPTURED')).toThrow(IllegalTransitionError);
  });

  it('OPEN -> CAPTURING when min_contributors authorized', () => {
    const round = createMockRound({ min_contributors: 3 });
    const members = ['m_1', 'm_2', 'm_3'];
    const contributions: Contribution[] = members.map((id) => ({
      id: `c_${id}`,
      round_id: round.id,
      member_id: id,
      amount_cents: 8000,
      status: 'AUTHORIZED',
      capture_attempts: 0,
    }));

    const result = evaluateRoundStatus(round, contributions, baseFundingPolicy, '2026-11-02T12:00:00Z');
    expect(result.status).toBe('CAPTURING');
    expect(result.changed).toBe(true);
  });

  it('OPEN -> CANCELLED when authorization deadline expires underfunded', () => {
    const round = createMockRound({
      min_contributors: 6,
      authorization_deadline: '2026-11-04T12:00:00.000Z',
    });
    // Only 2 authorized
    const contributions: Contribution[] = [
      { id: 'c_1', round_id: round.id, member_id: 'm_1', amount_cents: 8000, status: 'AUTHORIZED', capture_attempts: 0 },
      { id: 'c_2', round_id: round.id, member_id: 'm_2', amount_cents: 8000, status: 'AUTHORIZED', capture_attempts: 0 },
    ];

    const result = evaluateRoundStatus(round, contributions, baseFundingPolicy, '2026-11-04T12:05:00.000Z');
    expect(result.status).toBe('CANCELLED');
    expect(result.changed).toBe(true);
  });

  it('CAPTURING -> FUNDED when all member contributions are successfully captured', () => {
    const round = createMockRound({ status: 'CAPTURING', min_contributors: 3 });
    const contributions: Contribution[] = [
      { id: 'c_1', round_id: round.id, member_id: 'm_1', amount_cents: 8000, status: 'CAPTURED', capture_attempts: 1 },
      { id: 'c_2', round_id: round.id, member_id: 'm_2', amount_cents: 8000, status: 'CAPTURED', capture_attempts: 1 },
      { id: 'c_3', round_id: round.id, member_id: 'm_3', amount_cents: 8000, status: 'CAPTURED', capture_attempts: 1 },
    ];

    const result = evaluateRoundStatus(round, contributions, baseFundingPolicy, '2026-11-02T12:00:00Z');
    expect(result.status).toBe('FUNDED');
    expect(result.totalCapturedCents).toBe(24000);
    expect(result.capturedContributorsCount).toBe(3);
  });

  it('CAPTURING -> PARTIAL_FAILURE when captures fail after max retries (Scenario S4)', () => {
    const round = createMockRound({ status: 'CAPTURING', min_contributors: 6 });
    // 5 captured, 1 failed after 3 attempts (initial + 2 retries)
    const members = ['m_asha', 'm_ben', 'm_chloe', 'm_dev', 'm_elena'];
    const contributions: Contribution[] = [
      ...members.map((id) => ({
        id: `c_${id}`,
        round_id: round.id,
        member_id: id,
        amount_cents: 8000,
        status: 'CAPTURED' as const,
        capture_attempts: 1,
      })),
      {
        id: 'c_farid',
        round_id: round.id,
        member_id: 'm_farid',
        amount_cents: 8000,
        status: 'CAPTURE_FAILED',
        capture_attempts: 3, // Exhausted all retries!
      },
    ];

    const result = evaluateRoundStatus(round, contributions, baseFundingPolicy, '2026-11-02T12:00:00Z');
    expect(result.status).toBe('PARTIAL_FAILURE');
    expect(result.totalCapturedCents).toBe(40000); // 5 * $80 = $400.00
    expect(result.capturedContributorsCount).toBe(5);
    expect(result.failedContributorsCount).toBe(1);
  });
});

describe('Funding - S4 Partial Failure Proposals & Quorum Guard Integration', () => {
  it('generates the two governance proposals and passes Quorum Guard evaluation', () => {
    const round = createMockRound({
      status: 'AWAITING_GROUP_DECISION',
      min_contributors: 6,
      per_member_cents: 8000,
    });

    const members = ['m_asha', 'm_ben', 'm_chloe', 'm_dev', 'm_elena'];
    const contributions: Contribution[] = [
      ...members.map((id) => ({
        id: `c_${id}`,
        round_id: round.id,
        member_id: id,
        amount_cents: 8000,
        status: 'CAPTURED' as const,
        capture_attempts: 1,
      })),
      {
        id: 'c_farid',
        round_id: round.id,
        member_id: 'm_farid',
        amount_cents: 8000,
        status: 'CAPTURE_FAILED',
        capture_attempts: 3,
      },
    ];

    const { acceptReducedProposal, unwindProposal, eligibleVoterMemberIds } =
      createPartialFailureProposals(round, contributions, '2026-11-02T12:00:00.000Z');

    // 1. Check generated proposal properties
    expect(acceptReducedProposal.type).toBe('ACCEPT_REDUCED_BUDGET');
    expect(acceptReducedProposal.payload.new_budget_cents).toBe(40000); // $400.00
    expect(acceptReducedProposal.payload.uncaptured_member_ids).toContain('m_farid');

    expect(unwindProposal.type).toBe('UNWIND_FUNDING');
    expect(unwindProposal.payload.captured_amount_cents).toBe(40000);

    // Only the 5 captured members are eligible to vote
    expect(eligibleVoterMemberIds).toHaveLength(5);
    expect(eligibleVoterMemberIds).not.toContain('m_farid');

    // 2. Feed ACCEPT_REDUCED_BUDGET directly into Quorum Guard with real schema statuses
    // In production during partial failure: group.status === 'FUNDING', fundingRound.status === 'AWAITING_GROUP_DECISION'
    const votes = [
      { proposal_id: acceptReducedProposal.id, member_id: 'm_asha', kind: 'VOTE' as const, choice: 'APPROVE' as const },
      { proposal_id: acceptReducedProposal.id, member_id: 'm_ben', kind: 'VOTE' as const, choice: 'APPROVE' as const },
      { proposal_id: acceptReducedProposal.id, member_id: 'm_chloe', kind: 'VOTE' as const, choice: 'APPROVE' as const }, // 3 of 5 is majority
    ];

    const guardResult = evaluate({
      phase: 'PROPOSAL',
      now: '2026-11-02T12:05:00.000Z',
      policy: baseGuardPolicy,
      group: {
        id: round.group_id,
        mode: 'POOLED',
        status: 'FUNDING', // Real schema status!
      },
      fundingRound: {
        id: round.id,
        status: 'AWAITING_GROUP_DECISION', // Real round status!
      },
      proposal: acceptReducedProposal,
      votes,
      eligibleVoters: eligibleVoterMemberIds,
      funds: {
        availableCents: 40000,
        reservedCents: 0,
        fundingReady: false,
      },
      existingLivePayment: false,
    });

    // Guard should cleanly approve the funding decision!
    expect(guardResult.decision).toBe('APPROVED');
    expect(guardResult.reasonCodes).not.toContain('GROUP_NOT_ACTIVE');
    expect(guardResult.reasonCodes).not.toContain('ROUND_NOT_AWAITING_DECISION');
    expect(guardResult.reasonCodes).not.toContain('FUNDING_NOT_READY');
  });
});
