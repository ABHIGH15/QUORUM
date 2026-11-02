/**
 * Quorum Guard Test Suite
 * 
 * Exhaustive table-driven test cases covering:
 * - All 16 check codes
 * - Strict decision precedence (BLOCKED > VETOED > REJECTED_BY_VOTE > NEEDS_VOTES > VETO_WINDOW_OPEN > APPROVED)
 * - Exact tier boundaries ($60, $61, $150, $180, $200, $201, $350)
 * - Invariant: executionAllowed is ONLY true for APPROVED in EXECUTION phase
 * - Invariant: Pure function property (same input => same output)
 */

import { describe, it, expect } from 'vitest';
import { evaluate, explainDecision } from '../lib/guard';
import { GuardInput, Policy, Vendor, Vote } from '../lib/guard/types';

// Standard demo policy snapshot
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
    // 6 eligible voters, needs 4 votes (Tier 2). If 3 reject, max possible approvals is 3 < 4.
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
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 }, // Tier 2 (needs 4)
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' }, // Elena vetoes! (Scenario S2)
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('VETOED');
    expect(result.reasonCodes).toContain('VETOED');
    expect(result.executionAllowed).toBe(false);
  });

  it('16. VETO_WINDOW_OPEN: sufficient approvals but veto window is still ticking', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:01:00.000Z', // 1 min before veto window ends
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 5000, // needs 2 votes
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

describe('Quorum Guard - Decision Precedence', () => {
  it('17. BLOCKED takes precedence over VETOED', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 35000 }, // Hard cap exceeded (BLOCKED)
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' }, // VETO
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('BLOCKED');
  });

  it('18. VETOED takes precedence over REJECTED_BY_VOTE', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 }, // needs 4 votes
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_elena', kind: 'VETO', choice: 'VETO' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('VETOED');
  });

  it('19. REJECTED_BY_VOTE takes precedence over NEEDS_VOTES', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 14500 }, // needs 4
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'REJECT' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'REJECT' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('REJECTED_BY_VOTE');
  });

  it('20. NEEDS_VOTES takes precedence over VETO_WINDOW_OPEN', () => {
    const input = createBaseInput({
      proposal: {
        ...createBaseInput().proposal,
        amount_cents: 14500, // needs 4
        veto_ends_at: '2026-11-02T12:02:00.000Z',
      },
      now: '2026-11-02T12:01:00.000Z',
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.decision).toBe('NEEDS_VOTES');
  });
});

describe('Quorum Guard - Tier Boundaries & Unanimity Overrides', () => {
  it('21. Tier 1 boundary: $60.00 requires exactly 2 votes and passes with 2', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z', // Veto window ended
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

  it('22. Tier 2 boundary: $61.00 jumps to Tier 2 and requires 4 votes (2 approvals = NEEDS_VOTES)', () => {
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

  it('23. Tier 2 upper boundary: $150.00 requires 4 votes and passes with 4', () => {
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

  it('24. Unanimity Override (Scenario S10): $180.00 requires ALL 6 eligible votes; 4 approvals = NEEDS_VOTES', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 18000 }, // > $150.00 unanimity threshold
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_chloe', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_dev', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.votesRequired).toBe(6); // All 6 required!
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('25. Hard Cap limit: $200.00 is allowed; $200.01 is BLOCKED', () => {
    const passInput = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 20000 },
    });
    const passResult = evaluate(passInput);
    expect(passResult.checks.find(c => c.code === 'HARD_CAP_EXCEEDED')?.pass).toBe(true);

    const failInput = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 20001 },
    });
    const failResult = evaluate(failInput);
    expect(failResult.decision).toBe('BLOCKED');
    expect(failResult.reasonCodes).toContain('HARD_CAP_EXCEEDED');
  });
});

describe('Quorum Guard - Phase & Invariant Properties', () => {
  it('26. Invariant: executionAllowed is TRUE ONLY in EXECUTION phase when APPROVED', () => {
    const baseApprovedInput = createBaseInput({
      now: '2026-11-02T12:03:00.000Z', // Veto window closed
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 },
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_ben', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });

    // PROPOSAL phase
    const proposalResult = evaluate({ ...baseApprovedInput, phase: 'PROPOSAL' });
    expect(proposalResult.decision).toBe('APPROVED');
    expect(proposalResult.executionAllowed).toBe(false);

    // VOTING phase
    const votingResult = evaluate({ ...baseApprovedInput, phase: 'VOTING' });
    expect(votingResult.decision).toBe('APPROVED');
    expect(votingResult.executionAllowed).toBe(false);

    // EXECUTION phase (Scenario S3)
    const executionResult = evaluate({ ...baseApprovedInput, phase: 'EXECUTION' });
    expect(executionResult.decision).toBe('APPROVED');
    expect(executionResult.executionAllowed).toBe(true);
  });

  it('27. Invariant: Purity / Determinism - 20 identical calls yield identical results', () => {
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

  it('28. Explanation generator: produces clean human-readable template for Why? modal', () => {
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
