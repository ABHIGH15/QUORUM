/**
 * Quorum Guard Test Suite
 * 
 * Exhaustive table-driven and property-based test cases covering:
 * - All structural, policy, and fail-closed checks
 * - Strict decision precedence (BLOCKED > VETOED > REJECTED_BY_VOTE > NEEDS_VOTES > VETO_WINDOW_OPEN > APPROVED)
 * - Exact tier boundaries ($59, $60, $61, $149, $150, $151, $199, $200, $201, $350)
 * - Exact budget limit ($480.00 exact vs $480.01)
 * - Exact veto window timing (now < veto_ends_at vs now == veto_ends_at)
 * - Veto window enforcement when veto_ends_at is missing/null
 * - Voter eligibility (owner, agent, removed member, strangers must NOT count)
 * - Proposal ID filtering (votes for other proposals are discarded)
 * - S4 funding failure scenarios (ACCEPT_REDUCED_BUDGET, UNWIND_FUNDING)
 * - Degenerate input blocking: 0 voters, 1 voter, negative/float amounts, unknown types
 * - Property-based fuzz test with fast-check asserting that APPROVED strictly implies
 *   at least 2 distinct approvers and valid financial bounds.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluate, explainDecision } from '../lib/guard';
import { GuardInput, Policy, Vendor, Vote } from '../lib/guard/types';

// Standard demo policy snapshot (§5.1)
const basePolicy: Policy = {
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
    allowlist_vendor_ids: ['v_projector_shop', 'v_cafe_supplies', 'v_print_hub'],
  },
  categories_allowed: ['equipment', 'food', 'printing'],
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

const baseVendor: Vendor = {
  id: 'v_projector_shop',
  name: 'Projector Shop',
  paypal_email: 'vendor-projector@sandbox.quorum.app',
  category: 'equipment',
  verified: true,
  source: 'CATALOG',
};

const eligibleMembers = ['m_asha', 'm_ben', 'm_chloe', 'm_dev', 'm_elena', 'm_farid'];

function createBaseInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    phase: 'PROPOSAL',
    now: '2026-11-02T12:00:00.000Z',
    policy: { ...basePolicy },
    group: {
      id: 'grp_demo',
      mode: 'POOLED',
      status: 'ACTIVE',
    },
    proposal: {
      id: 'prop_1',
      group_id: 'grp_demo',
      type: 'PURCHASE',
      status: 'OPEN',
      created_by_kind: 'AGENT',
      policy_version: 1,
      vendor_id: 'v_projector_shop',
      category: 'equipment',
      amount_cents: 5000, // $50.00, Tier 1 (needs 2 votes)
      currency: 'USD',
      payload: { item: 'Mini Projector' },
      voting_deadline: '2026-11-05T12:00:00.000Z',
      veto_ends_at: '2026-11-02T12:02:00.000Z',
    },
    votes: [],
    eligibleVoters: [...eligibleMembers],
    vendor: { ...baseVendor },
    funds: {
      availableCents: 48000,
      reservedCents: 0,
      fundingReady: true,
    },
    existingLivePayment: false,
    ...overrides,
  };
}

describe('Quorum Guard - Individual Check Codes', () => {
  it('1. GROUP_NOT_ACTIVE: blocks when group status is DRAFT or FUNDING', () => {
    const input = createBaseInput({
      group: { id: 'grp_demo', mode: 'POOLED', status: 'FUNDING' },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('GROUP_NOT_ACTIVE');
  });

  it('2. PROPOSAL_EXPIRED: blocks when now is after voting_deadline', () => {
    const input = createBaseInput({
      now: '2026-11-06T00:00:00.000Z',
      proposal: {
        ...createBaseInput().proposal,
        voting_deadline: '2026-11-05T12:00:00.000Z',
        status: 'OPEN',
      },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PROPOSAL_EXPIRED');
  });

  it('3. POLICY_VERSION_CHANGED: blocks when proposal was created under older policy version', () => {
    const input = createBaseInput({
      policy: { ...basePolicy, version: 2 },
      proposal: { ...createBaseInput().proposal, policy_version: 1 },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('POLICY_VERSION_CHANGED');
  });

  it('4. PROPOSER_NOT_ALLOWED: blocks when member is not an active eligible contributor', () => {
    const input = createBaseInput({
      proposal: {
        ...createBaseInput().proposal,
        created_by_kind: 'MEMBER',
        created_by: 'm_stranger_danger',
      },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PROPOSER_NOT_ALLOWED');
  });

  it('5. CURRENCY_MISMATCH: blocks non-USD proposals', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, currency: 'EUR' },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('6. VENDOR_NOT_ALLOWED: blocks vendors not on policy allowlist', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, vendor_id: 'v_shady_gadgets' },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('VENDOR_NOT_ALLOWED');
  });

  it('7. VENDOR_UNVERIFIED: blocks unverified vendors', () => {
    const input = createBaseInput({
      vendor: { ...baseVendor, verified: false },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('VENDOR_UNVERIFIED');
  });

  it('8. CATEGORY_NOT_ALLOWED: blocks unauthorized product categories', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, category: 'cryptocurrency' },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('CATEGORY_NOT_ALLOWED');
  });

  it('9. HARD_CAP_EXCEEDED: blocks proposals above hard cap ($200.00)', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 35000 }, // $350.00 (Scenario S1)
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('HARD_CAP_EXCEEDED');
    expect(result.suggestions.maxAllowedAmountCents).toBe(20000);
  });

  it('10. BUDGET_EXCEEDED: blocks when proposal exceeds available funds', () => {
    const input = createBaseInput({
      funds: { availableCents: 10000, reservedCents: 0, fundingReady: true },
      proposal: { ...createBaseInput().proposal, amount_cents: 15000 },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('BUDGET_EXCEEDED');
    expect(result.suggestions.maxAllowedAmountCents).toBe(10000);
  });

  it('11. FUNDING_NOT_READY: blocks in Pooled mode when pool is not ready', () => {
    const input = createBaseInput({
      funds: { availableCents: 48000, reservedCents: 0, fundingReady: false },
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('FUNDING_NOT_READY');
  });

  it('12. DUPLICATE_EXECUTION: blocks when a live payment already exists', () => {
    const input = createBaseInput({
      existingLivePayment: true,
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('DUPLICATE_EXECUTION');
  });

  it('13. NEEDS_VOTES: returns NEEDS_VOTES when approvals are insufficient', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 }, // needs 2 votes
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('NEEDS_VOTES');
    expect(result.numbers.approvals).toBe(1);
    expect(result.numbers.votesRequired).toBe(2);
  });

  it('14. REJECTED_BY_VOTE: triggers when mathematically impossible to reach quota', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 }, // Tier 2 (needs 4)
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'REJECT' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('REJECTED_BY_VOTE');
  });

  it('15. VETOED: veto by an eligible voter halts the proposal permanently', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' }, // Scenario S2
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('VETOED');
    expect(result.reasonCodes).toContain('VETOED');
    expect(result.executionAllowed).toBe(false);
  });

  it('16. VETO_WINDOW_OPEN: sufficient approvals but veto window is still ticking', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:01:00.000Z',
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 5000,
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('VETO_WINDOW_OPEN');
    expect(result.executionAllowed).toBe(false);
  });
});

describe('Quorum Guard - Fail-Closed Degenerate & Edge Protections', () => {
  it('17. Bug Fix 1: INSUFFICIENT_ELIGIBLE_VOTERS blocks purchases with 0 or 1 eligible voter', () => {
    // 0 eligible voters: must NEVER approve
    const zeroVotersInput = createBaseInput({
      eligibleVoters: [],
      proposal: { ...createBaseInput().proposal, amount_cents: 18000 }, // >$150 unanimity
      votes: [],
    });
    const zeroResult = evaluate(zeroVotersInput);
    expect(zeroResult.decision).toBe('BLOCKED');
    expect(zeroResult.reasonCodes).toContain('INSUFFICIENT_ELIGIBLE_VOTERS');
    expect(zeroResult.executionAllowed).toBe(false);

    // 1 eligible voter: must NEVER allow a single voter to authorize alone
    const oneVoterInput = createBaseInput({
      eligibleVoters: ['m_lonely'],
      now: '2026-11-02T12:05:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_lonely', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const oneResult = evaluate(oneVoterInput);
    expect(oneResult.decision).toBe('BLOCKED');
    expect(oneResult.reasonCodes).toContain('INSUFFICIENT_ELIGIBLE_VOTERS');
    expect(oneResult.executionAllowed).toBe(false);
  });

  it('18. Bug Fix 2: S4 Funding Proposals (ACCEPT_REDUCED_BUDGET & UNWIND_FUNDING) succeed during partial failure', () => {
    // In production, during partial failure the group is in 'FUNDING' and fundingRound is in 'AWAITING_GROUP_DECISION'
    const s4Input = createBaseInput({
      now: '2026-11-02T12:05:00.000Z',
      group: { id: 'grp_demo', mode: 'POOLED', status: 'FUNDING' },
      fundingRound: { id: 'round_1', status: 'AWAITING_GROUP_DECISION' },
      funds: { availableCents: 40000, reservedCents: 0, fundingReady: false },
      proposal: {
        id: 'prop_s4_reduced',
        group_id: 'grp_demo',
        type: 'ACCEPT_REDUCED_BUDGET',
        status: 'OPEN',
        created_by_kind: 'SYSTEM',
        policy_version: 1,
        payload: { new_budget_cents: 40000 },
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      eligibleVoters: ['m_asha', 'm_ben', 'm_chloe', 'm_dev', 'm_elena'], // 5 captured contributors
      votes: [
        { proposal_id: 'prop_s4_reduced', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_s4_reduced', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_s4_reduced', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' }, // Majority (3/5)
      ],
    });

    const s4Result = evaluate(s4Input);
    expect(s4Result.reasonCodes).not.toContain('GROUP_NOT_ACTIVE');
    expect(s4Result.reasonCodes).not.toContain('ROUND_NOT_AWAITING_DECISION');
    expect(s4Result.reasonCodes).not.toContain('FUNDING_NOT_READY');
    expect(s4Result.decision).toBe('APPROVED');

    // UNWIND_FUNDING during AWAITING_GROUP_DECISION
    const unwindInput = createBaseInput({
      now: '2026-11-02T12:05:00.000Z',
      group: { id: 'grp_demo', mode: 'POOLED', status: 'FUNDING' },
      fundingRound: { id: 'round_1', status: 'AWAITING_GROUP_DECISION' },
      funds: { availableCents: 40000, reservedCents: 0, fundingReady: false },
      proposal: {
        id: 'prop_unwind',
        group_id: 'grp_demo',
        type: 'UNWIND_FUNDING',
        status: 'OPEN',
        created_by_kind: 'SYSTEM',
        policy_version: 1,
        payload: { reason: 'partial failure unwind' },
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      eligibleVoters: ['m_asha', 'm_ben', 'm_chloe', 'm_dev', 'm_elena'],
      votes: [
        { proposal_id: 'prop_unwind', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_unwind', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_unwind', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const unwindResult = evaluate(unwindInput);
    expect(unwindResult.decision).toBe('APPROVED');

    // Negative 1: ACCEPT_REDUCED_BUDGET when group is ACTIVE is strictly BLOCKED
    // (Budget changes in ACTIVE status must go through POLICY_AMENDMENT)
    const activeGroupInput = createBaseInput({
      ...s4Input,
      group: { id: 'grp_demo', mode: 'POOLED', status: 'ACTIVE' },
    });
    const activeGroupResult = evaluate(activeGroupInput);
    expect(activeGroupResult.decision).toBe('BLOCKED');
    expect(activeGroupResult.reasonCodes).toContain('GROUP_NOT_ACTIVE');

    // Negative 2: ACCEPT_REDUCED_BUDGET when group is CLOSING is strictly BLOCKED
    const closingGroupInput = createBaseInput({
      ...s4Input,
      group: { id: 'grp_demo', mode: 'POOLED', status: 'CLOSING' },
    });
    const closingGroupResult = evaluate(closingGroupInput);
    expect(closingGroupResult.decision).toBe('BLOCKED');
    expect(closingGroupResult.reasonCodes).toContain('GROUP_NOT_ACTIVE');

    // Negative 3: S4 proposal when round is not in AWAITING_GROUP_DECISION (e.g. CAPTURING)
    const capturingRoundInput = createBaseInput({
      ...s4Input,
      fundingRound: { id: 'round_1', status: 'CAPTURING' },
    });
    const capturingRoundResult = evaluate(capturingRoundInput);
    expect(capturingRoundResult.decision).toBe('BLOCKED');
    expect(capturingRoundResult.reasonCodes).toContain('ROUND_NOT_AWAITING_DECISION');

    // Negative 4: S4 proposal when fundingRound snapshot is omitted
    const missingRoundInput = createBaseInput({
      ...s4Input,
      fundingRound: undefined,
    });
    const missingRoundResult = evaluate(missingRoundInput);
    expect(missingRoundResult.decision).toBe('BLOCKED');
    expect(missingRoundResult.reasonCodes).toContain('ROUND_NOT_AWAITING_DECISION');
  });

  it('18b. Bug Fix: POLICY_AMENDMENT requires >= 2 votes, >= 2 eligible voters, and ACTIVE group status', () => {
    // Negative 1: Single voter cannot amend policy alone (requires >= 2 eligible members)
    const singleVoterAmendment = createBaseInput({
      now: '2026-11-02T12:05:00.000Z',
      proposal: {
        id: 'prop_amend_1',
        group_id: 'grp_demo',
        type: 'POLICY_AMENDMENT',
        status: 'OPEN',
        created_by_kind: 'MEMBER',
        created_by: 'm_asha',
        policy_version: 1,
        payload: { hard_cap_cents: 30000 },
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      eligibleVoters: ['m_asha'],
      votes: [
        { proposal_id: 'prop_amend_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const singleVoterResult = evaluate(singleVoterAmendment);
    expect(singleVoterResult.decision).toBe('BLOCKED');
    expect(singleVoterResult.reasonCodes).toContain('INSUFFICIENT_ELIGIBLE_VOTERS');

    // Negative 2: Vote floor of >= 2 enforced even if policy specifies amendment_votes_required: 1
    const floorAmendment = createBaseInput({
      now: '2026-11-02T12:05:00.000Z',
      policy: { ...basePolicy, amendment_votes_required: 1 },
      proposal: {
        id: 'prop_amend_2',
        group_id: 'grp_demo',
        type: 'POLICY_AMENDMENT',
        status: 'OPEN',
        created_by_kind: 'MEMBER',
        created_by: 'm_asha',
        policy_version: 1,
        payload: { hard_cap_cents: 30000 },
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      eligibleVoters: ['m_asha', 'm_ben', 'm_chloe'],
      votes: [
        { proposal_id: 'prop_amend_2', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const floorResult = evaluate(floorAmendment);
    expect(floorResult.decision).toBe('NEEDS_VOTES');
    expect(floorResult.numbers.votesRequired).toBe(2);

    // Negative 3: Policy amendment in FUNDING or CLOSING is BLOCKED with GROUP_NOT_ACTIVE
    const fundingAmendment = createBaseInput({
      ...floorAmendment,
      group: { id: 'grp_demo', mode: 'POOLED', status: 'FUNDING' },
    });
    const fundingAmendResult = evaluate(fundingAmendment);
    expect(fundingAmendResult.decision).toBe('BLOCKED');
    expect(fundingAmendResult.reasonCodes).toContain('GROUP_NOT_ACTIVE');

    // Positive: 2 approvals with 3 eligible voters passes
    const passAmendment = createBaseInput({
      ...floorAmendment,
      votes: [
        { proposal_id: 'prop_amend_2', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_amend_2', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const passResult = evaluate(passAmendment);
    expect(passResult.decision).toBe('APPROVED');
  });

  it('19. Bug Fix 3: INVALID_AMOUNT blocks null, 0, negative, and fractional cents', () => {
    const invalidAmounts = [null, undefined, 0, -500, 145.5, NaN, Infinity];

    for (const amt of invalidAmounts) {
      const input = createBaseInput({
        proposal: { ...createBaseInput().proposal, amount_cents: amt as any },
      });
      const result = evaluate(input);
      expect(result.decision).toBe('BLOCKED');
      expect(result.reasonCodes).toContain('INVALID_AMOUNT');
    }
  });

  it('20. Bug Fix 4: Missing veto_ends_at never skips the veto window', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:05:00.000Z',
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 5000,
        veto_ends_at: undefined, // Missing veto_ends_at!
      },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    // Because veto_window_minutes is 2, a missing timestamp must NOT approve
    expect(result.decision).toBe('VETO_WINDOW_OPEN');
    expect(result.executionAllowed).toBe(false);
  });

  it('21. Bug Fix 5: Discards votes for other proposals', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, id: 'prop_target', amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_other', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_other', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(0);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('22. Bug Fix 6: Blocks unknown proposal types and un-tiered amounts fall back to unanimity', () => {
    // Unknown proposal type
    const unknownInput = createBaseInput({
      proposal: { ...createBaseInput().proposal, type: 'MALICIOUS_DRAIN' as any },
    });
    const unknownResult = evaluate(unknownInput);
    expect(unknownResult.decision).toBe('BLOCKED');
    expect(unknownResult.reasonCodes).toContain('PROPOSAL_TYPE_INVALID');

    // Policy with no tier covering $100 (e.g. only tier up to $60)
    const brokenTiersPolicy: Policy = {
      ...basePolicy,
      approval_tiers: [{ max_cents: 6000, votes_required: 2 }],
      hard_cap_cents: 20000,
    };
    const untieredInput = createBaseInput({
      policy: brokenTiersPolicy,
      proposal: { ...createBaseInput().proposal, amount_cents: 10000 },
    });
    const untieredResult = evaluate(untieredInput);
    // Must fall back to all eligible voters (6)
    expect(untieredResult.numbers.votesRequired).toBe(6);
  });
});

describe('Quorum Guard - Decision Precedence', () => {
  it('23. BLOCKED takes precedence over VETOED', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 35000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' },
      ],
    });
    expect(evaluate(input).decision).toBe('BLOCKED');
  });

  it('24. VETOED takes precedence over REJECTED_BY_VOTE', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' },
      ],
    });
    expect(evaluate(input).decision).toBe('VETOED');
  });

  it('25. REJECTED_BY_VOTE takes precedence over NEEDS_VOTES', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'REJECT' },
      ],
    });
    expect(evaluate(input).decision).toBe('REJECTED_BY_VOTE');
  });

  it('26. NEEDS_VOTES takes precedence over VETO_WINDOW_OPEN', () => {
    const input = createBaseInput({
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 14500,
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      now: '2026-11-02T12:01:00.000Z',
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    expect(evaluate(input).decision).toBe('NEEDS_VOTES');
  });
});

describe('Quorum Guard - Voter Eligibility & Core Promise', () => {
  it('27. Discards votes from non-eligible participants (strangers, removed members)', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_stranger_1', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_removed_member', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(0);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('28. Discards votes from AI Agent or non-contributing Organizer/Owner (I7)', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'agent_quorum', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'owner_unfunded', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(0);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('29. Non-eligible vetoes are discarded', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_unauthorized_intruder', kind: 'VETO', choice: 'VETO' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('APPROVED');
  });
});

describe('Quorum Guard - Vote Semantics & Deduplication', () => {
  it('30. Deduplication: Duplicate votes from same member count exactly once', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(1);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('31. Vote Updates: A member who changes their vote reflects their latest choice', () => {
    // Asha originally approved, then changed her vote to REJECT
    const input1 = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE', created_at: '2026-11-02T12:00:00Z' },
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'REJECT', created_at: '2026-11-02T12:01:00Z' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE', created_at: '2026-11-02T12:00:00Z' },
      ],
    });
    const result1 = evaluate(input1);
    expect(result1.numbers.approvals).toBe(1);
    expect(result1.decision).toBe('NEEDS_VOTES');

    // Asha originally rejected, then changed to APPROVE
    const input2 = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'REJECT', created_at: '2026-11-02T12:00:00Z' },
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE', created_at: '2026-11-02T12:01:00Z' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE', created_at: '2026-11-02T12:00:00Z' },
      ],
    });
    const result2 = evaluate(input2);
    expect(result2.numbers.approvals).toBe(2);
    expect(result2.decision).toBe('APPROVED');
  });

  it("32. Proposer's own approval counts exactly once", () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: {
        ...createBaseInput().proposal,
        created_by_kind: 'MEMBER',
        created_by: 'm_asha',
        amount_cents: 5000,
      },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(2);
    expect(result.decision).toBe('APPROVED');
  });
});

describe('Quorum Guard - Tier Boundaries & Mathematical Edges', () => {
  it('33. Boundary $59.00: Tier 1, requires 2 votes, passes with 2', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 5900 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(2);
    expect(result.decision).toBe('APPROVED');
  });

  it('34. Boundary $60.00: Tier 1 limit, requires 2 votes, passes with 2', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 6000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(2);
    expect(result.decision).toBe('APPROVED');
  });

  it('35. Boundary $61.00: Tier 2 transition, requires 4 votes (2 approvals = NEEDS_VOTES)', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 6100 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(4);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('36. Boundary $149.00: Tier 2 upper range, requires 4 votes, passes with 4', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 14900 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(4);
    expect(result.decision).toBe('APPROVED');
  });

  it('37. Boundary $150.00: Unanimity line ceiling, requires 4 votes, passes with 4', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 15000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(4);
    expect(result.decision).toBe('APPROVED');
  });

  it('38. Boundary $151.00: Unanimity line crossed! Requires ALL 6 votes; 5 approvals = NEEDS_VOTES', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 15100 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(6);
    expect(result.numbers.approvals).toBe(5);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('39. Boundary $199.00: Under hard cap ($200.00), requires all 6 votes, passes with 6', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 19900 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    const result = evaluate(input);
    expect(result.decision).toBe('APPROVED');
  });

  it('40. Boundary $200.00: Exactly at hard cap, passes with 6 votes', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 20000 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    const result = evaluate(input);
    expect(result.decision).toBe('APPROVED');
  });

  it('41. Boundary $200.01 / $201.00: Exceeds hard cap by 1 cent or $1 -> BLOCKED', () => {
    const input1 = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 20001 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    expect(evaluate(input1).decision).toBe('BLOCKED');
    expect(evaluate(input1).reasonCodes).toContain('HARD_CAP_EXCEEDED');

    const input2 = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 20100 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    expect(evaluate(input2).decision).toBe('BLOCKED');
    expect(evaluate(input2).reasonCodes).toContain('HARD_CAP_EXCEEDED');
  });

  it('42. Exact budget spending: Spending exactly available budget ($480.00) passes; $480.01 fails', () => {
    const highCapPolicy: Policy = {
      ...basePolicy,
      hard_cap_cents: 48000,
      unanimous_above_cents: 30000,
      approval_tiers: [{ max_cents: 48000, votes_required: 4 }],
    };

    const exactInput = createBaseInput({
      policy: highCapPolicy,
      funds: { availableCents: 48000, reservedCents: 0, fundingReady: true },
      proposal: { ...createBaseInput().proposal, amount_cents: 48000 },
    });
    expect(evaluate(exactInput).checks.find(c => c.code === 'BUDGET_EXCEEDED')?.pass).toBe(true);

    const overInput = createBaseInput({
      policy: highCapPolicy,
      funds: { availableCents: 48000, reservedCents: 0, fundingReady: true },
      proposal: { ...createBaseInput().proposal, amount_cents: 48001 },
    });
    const overResult = evaluate(overInput);
    expect(overResult.decision).toBe('BLOCKED');
    expect(overResult.reasonCodes).toContain('BUDGET_EXCEEDED');
  });

  it('43. Veto timing edge: now < veto_ends_at is open; now == veto_ends_at is closed', () => {
    const baseWindowInput = createBaseInput({
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 5000,
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });

    // 1 millisecond before: window is OPEN
    const beforeResult = evaluate({
      ...baseWindowInput,
      now: '2026-11-02T12:01:59.999Z',
    });
    expect(beforeResult.decision).toBe('VETO_WINDOW_OPEN');

    // Exactly at veto_ends_at: window is CLOSED -> APPROVED
    const exactResult = evaluate({
      ...baseWindowInput,
      now: '2026-11-02T12:02:00.000Z',
    });
    expect(exactResult.decision).toBe('APPROVED');

    // After veto_ends_at: window is CLOSED -> APPROVED
    const afterResult = evaluate({
      ...baseWindowInput,
      now: '2026-11-02T12:02:00.001Z',
    });
    expect(afterResult.decision).toBe('APPROVED');
  });
});

describe('Quorum Guard - Phase & Invariant Properties', () => {
  it('44. Invariant: executionAllowed is TRUE ONLY in EXECUTION phase when APPROVED', () => {
    const baseApprovedInput = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });

    expect(evaluate({ ...baseApprovedInput, phase: 'PROPOSAL' }).executionAllowed).toBe(false);
    expect(evaluate({ ...baseApprovedInput, phase: 'VOTING' }).executionAllowed).toBe(false);
    expect(evaluate({ ...baseApprovedInput, phase: 'EXECUTION' }).executionAllowed).toBe(true);
  });

  it('45. Invariant: Purity / Determinism - 20 identical calls yield identical results', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });

    const initial = evaluate(input);
    for (let i = 0; i < 20; i++) {
      const current = evaluate(input);
      expect(current).toEqual(initial);
    }
  });

  it('46. Explanation generator: produces clean human-readable template for Why? modal', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 35000 },
    });
    const result = evaluate(input);
    const explanation = explainDecision(result);
    expect(explanation).toContain('### 🚫 Blocked by Quorum Guard');
    expect(explanation).toContain('HARD_CAP_EXCEEDED');
    expect(explanation).toContain('$350.00');
    expect(explanation).toContain('Maximum allowed spending under current policy and available budget');
  });
});

describe('Quorum Guard - Property-Based Fuzz Testing (fast-check)', () => {
  it('47. Core Promise Fuzz: Across 0 to 6 eligible voters and arbitrary choices, no single voter ever authorizes alone', () => {
    const validChoices: ('APPROVE' | 'REJECT')[] = ['APPROVE', 'REJECT'];

    fc.assert(
      fc.property(
        // Random subset of eligible members (0 to 6 voters)
        fc.subarray(eligibleMembers),
        // Pick an arbitrary voter ID (could be in eligible subset or a stranger)
        fc.constantFrom(...eligibleMembers, 'stranger_x', 'agent_ai'),
        // Random duplicate vote counts (1 to 5)
        fc.integer({ min: 1, max: 5 }),
        // Vote choice
        fc.constantFrom(...validChoices),
        // Arbitrary amount: negative, zero, fractional, safe, or huge
        fc.oneof(
          fc.integer({ min: -500, max: 0 }),
          fc.integer({ min: 1, max: 35000 })
        ),
        (currentEligibleVoters, voterId, voteCount, choice, amountCents) => {
          // Exactly 1 unique member voted
          const votesList: Vote[] = Array.from({ length: voteCount }, () => ({
            proposal_id: 'prop_1', // Matches proposal.id!
            member_id: voterId,
            kind: 'VOTE',
            choice,
          }));

          const input = createBaseInput({
            now: '2026-11-02T12:05:00.000Z',
            proposal: {
              ...createBaseInput().proposal,
              id: 'prop_1',
              amount_cents: amountCents,
            },
            votes: votesList,
            eligibleVoters: currentEligibleVoters,
          });

          const result = evaluate(input);

          // Under NO condition can a single voter authorize a purchase alone!
          expect(result.decision).not.toBe('APPROVED');
          expect(result.executionAllowed).toBe(false);
          expect(['NEEDS_VOTES', 'REJECTED_BY_VOTE', 'BLOCKED']).toContain(result.decision);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('48. Universal Invariant: APPROVED strictly implies >= 2 distinct approvers and valid financial & lifecycle bounds', () => {
    const validGroupStatuses: ('DRAFT' | 'FUNDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED')[] = [
      'DRAFT',
      'FUNDING',
      'ACTIVE',
      'CLOSING',
      'CLOSED',
    ];
    const proposalTypes = [
      'PURCHASE',
      'POLICY_AMENDMENT',
      'ACCEPT_REDUCED_BUDGET',
      'UNWIND_FUNDING',
      'MALICIOUS_CUSTOM_TYPE',
    ];

    fc.assert(
      fc.property(
        // Random eligible voters (0 to 6)
        fc.subarray(eligibleMembers),
        // Random approvals list
        fc.subarray(eligibleMembers),
        // Random rejections list
        fc.subarray(eligibleMembers),
        // Random vetoes list
        fc.subarray(eligibleMembers),
        // Random amount
        fc.integer({ min: -100, max: 30000 }),
        // Random available budget
        fc.integer({ min: 0, max: 50000 }),
        // Proposal type
        fc.constantFrom(...proposalTypes),
        // Real group status enum
        fc.constantFrom(...validGroupStatuses),
        // Veto window minutes
        fc.integer({ min: 0, max: 10 }),
        // Live payment flag
        fc.boolean(),
        // Number of extraneous votes for other proposals
        fc.integer({ min: 0, max: 3 }),
        (
          voters,
          approvers,
          rejecters,
          vetoers,
          amount,
          available,
          propType,
          grpStatus,
          vetoMins,
          hasLivePayment,
          foreignVotesCount
        ) => {
          // Explicit timestamp sequencing so vote precedence is mathematically unambiguous:
          // Approvals @ 12:01:10, Rejections @ 12:01:30 (overrides approval), Vetoes @ 12:01:50
          const votesList: Vote[] = [
            ...approvers.map((id, idx) => ({
              proposal_id: 'prop_1',
              member_id: id,
              kind: 'VOTE' as const,
              choice: 'APPROVE' as const,
              created_at: `2026-11-02T12:01:${String(10 + (idx % 15)).padStart(2, '0')}Z`,
            })),
            ...rejecters.map((id, idx) => ({
              proposal_id: 'prop_1',
              member_id: id,
              kind: 'VOTE' as const,
              choice: 'REJECT' as const,
              created_at: `2026-11-02T12:01:${String(30 + (idx % 15)).padStart(2, '0')}Z`,
            })),
            ...vetoers.map(id => ({
              proposal_id: 'prop_1',
              member_id: id,
              kind: 'VETO' as const,
              choice: 'VETO' as const,
              created_at: '2026-11-02T12:01:50Z',
            })),
            // Extraneous foreign votes that must be ignored
            ...Array.from({ length: foreignVotesCount }, (_, i) => ({
              proposal_id: `foreign_prop_${i}`,
              member_id: eligibleMembers[i % eligibleMembers.length],
              kind: 'VOTE' as const,
              choice: 'APPROVE' as const,
              created_at: '2026-11-02T12:01:10Z',
            })),
          ];

          const input = createBaseInput({
            now: '2026-11-02T12:05:00.000Z',
            policy: {
              ...basePolicy,
              veto_window_minutes: vetoMins,
            },
            group: {
              id: 'grp_demo',
              mode: 'POOLED',
              status: grpStatus,
            },
            fundingRound: {
              id: 'round_1',
              status: 'AWAITING_GROUP_DECISION',
            },
            proposal: {
              ...createBaseInput().proposal,
              id: 'prop_1',
              type: propType as any,
              amount_cents: amount,
              veto_ends_at: '2026-11-02T12:02:00.000Z',
            },
            funds: {
              availableCents: available,
              reservedCents: 0,
              fundingReady: true,
            },
            existingLivePayment: hasLivePayment,
            votes: votesList,
            eligibleVoters: voters,
          });

          const result = evaluate(input);

          if (result.decision === 'APPROVED') {
            // Independent Oracle: directly computed from raw test input vectors, NOT from result.numbers!
            const eligibleSet = new Set(voters);
            const eligibleVetoers = vetoers.filter(id => eligibleSet.has(id));
            const eligibleRejecters = new Set(rejecters.filter(id => eligibleSet.has(id)));
            const oracleApprovers = approvers.filter(
              id => eligibleSet.has(id) && !eligibleRejecters.has(id) && !eligibleVetoers.includes(id)
            );
            const distinctOracleApprovals = new Set(oracleApprovers).size;

            // Invariant 1: No eligible member cast an active veto
            expect(eligibleVetoers.length).toBe(0);

            // Invariant 2: Cannot have an existing live payment
            expect(hasLivePayment).toBe(false);

            // Invariant 3: Proposal type must be a valid system type (never unknown)
            expect(['PURCHASE', 'POLICY_AMENDMENT', 'ACCEPT_REDUCED_BUDGET', 'UNWIND_FUNDING']).toContain(propType);

            if (propType === 'PURCHASE') {
              // Purchase invariant: at least 2 distinct eligible approvals
              expect(distinctOracleApprovals).toBeGreaterThanOrEqual(2);
              // Purchase invariant: group must be ACTIVE
              expect(grpStatus).toBe('ACTIVE');
              // Purchase invariant: raw amount is strictly positive and within cap & available budget
              expect(amount).toBeGreaterThanOrEqual(1);
              expect(amount).toBeLessThanOrEqual(basePolicy.hard_cap_cents);
              expect(amount).toBeLessThanOrEqual(available);
              // Purchase invariant: at least 2 eligible voters
              expect(voters.length).toBeGreaterThanOrEqual(2);
            } else if (propType === 'POLICY_AMENDMENT') {
              // Amendment invariant: at least 2 distinct eligible approvals
              expect(distinctOracleApprovals).toBeGreaterThanOrEqual(2);
              // Amendment invariant: group must be ACTIVE
              expect(grpStatus).toBe('ACTIVE');
              // Amendment invariant: at least 2 eligible voters
              expect(voters.length).toBeGreaterThanOrEqual(2);
            } else {
              // Funding decision invariant: group must be in FUNDING
              expect(grpStatus).toBe('FUNDING');
              // At least 1 eligible contributor approval
              expect(distinctOracleApprovals).toBeGreaterThanOrEqual(1);
            }
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});
