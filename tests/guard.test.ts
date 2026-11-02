/**
 * Quorum Guard Test Suite
 * 
 * Exhaustive table-driven and property-based test cases covering:
 * - All 16 check codes
 * - Strict decision precedence (BLOCKED > VETOED > REJECTED_BY_VOTE > NEEDS_VOTES > VETO_WINDOW_OPEN > APPROVED)
 * - Exact tier boundaries ($59, $60, $61, $149, $150, $151, $199, $200, $201, $350)
 * - Exact budget limit ($480.00 exact vs $480.01)
 * - Exact veto window timing (now < veto_ends_at vs now == veto_ends_at)
 * - Voter eligibility (owner, agent, removed member, strangers must NOT count)
 * - Vote semantics (deduplication, vote updates, proposer vote)
 * - Property-based fuzz test with fast-check:
 *   Guaranteed that no single voter can EVER authorize an expenditure alone when votes_required >= 2.
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

describe('Quorum Guard - Voter Eligibility & Core Promise', () => {
  it('21. Discards votes from non-eligible participants (strangers, removed members)', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 }, // needs 2 votes
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_stranger_1', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_removed_member', kind: 'VOTE', choice: 'APPROVE' },
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(0);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('22. Discards votes from AI Agent or non-contributing Organizer/Owner (I7)', () => {
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

  it('23. Non-eligible vetoes are discarded', () => {
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
  it('24. Deduplication: Duplicate votes from same member count exactly once', () => {
    const input = createBaseInput({
      proposal: { ...createBaseInput().proposal, amount_cents: 5000 }, // needs 2 votes
      votes: [
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' },
        { proposal_id: 'prop_1', member_id: 'm_asha', kind: 'VOTE', choice: 'APPROVE' }, // Duplicate!
      ],
    });
    const result = evaluate(input);
    expect(result.numbers.approvals).toBe(1);
    expect(result.decision).toBe('NEEDS_VOTES');
  });

  it('25. Vote Updates: A member who changes their vote reflects their latest choice', () => {
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
    expect(result1.numbers.approvals).toBe(1); // Only Ben
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

  it("26. Proposer's own approval counts exactly once", () => {
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
  it('27. Boundary $59.00: Tier 1, requires 2 votes, passes with 2', () => {
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

  it('28. Boundary $60.00: Tier 1 limit, requires 2 votes, passes with 2', () => {
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

  it('29. Boundary $61.00: Tier 2 transition, requires 4 votes (2 approvals = NEEDS_VOTES)', () => {
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

  it('30. Boundary $149.00: Tier 2 upper range, requires 4 votes, passes with 4', () => {
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

  it('31. Boundary $150.00: Unanimity line ceiling, requires 4 votes, passes with 4', () => {
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

  it('32. Boundary $151.00: Unanimity line crossed! Requires ALL 6 votes; 5 approvals = NEEDS_VOTES', () => {
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

  it('33. Boundary $199.00: Under hard cap ($200.00), requires all 6 votes, passes with 6', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 19900 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    const result = evaluate(input);
    expect(result.decision).toBe('APPROVED');
  });

  it('34. Boundary $200.00: Exactly at hard cap, passes with 6 votes', () => {
    const input = createBaseInput({
      now: '2026-11-02T12:03:00.000Z',
      proposal: { ...createBaseInput().proposal, amount_cents: 20000 },
      votes: eligibleMembers.map(m => ({ proposal_id: 'prop_1', member_id: m, kind: 'VOTE', choice: 'APPROVE' })),
    });
    const result = evaluate(input);
    expect(result.decision).toBe('APPROVED');
  });

  it('35. Boundary $200.01 / $201.00: Exceeds hard cap by 1 cent or $1 -> BLOCKED', () => {
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

  it('36. Exact budget spending: Spending exactly available budget ($480.00) passes; $480.01 fails', () => {
    // Policy allowing up to $480.00 cap for this budget test
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

  it('37. Veto timing edge: now < veto_ends_at is open; now == veto_ends_at is closed', () => {
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
  it('38. Invariant: executionAllowed is TRUE ONLY in EXECUTION phase when APPROVED', () => {
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

  it('39. Invariant: Purity / Determinism - 20 identical calls yield identical results', () => {
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

  it('40. Explanation generator: produces clean human-readable template for Why? modal', () => {
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
  it('41. Core Promise: No single voter can EVER authorize an expenditure alone when votes_required >= 2', () => {
    const validChoices: ('APPROVE' | 'REJECT')[] = ['APPROVE', 'REJECT'];

    fc.assert(
      fc.property(
        // Pick any single voter from eligible members
        fc.constantFrom(...eligibleMembers),
        // Pick random number of duplicate votes by that voter (1 to 10 duplicate vote entries)
        fc.integer({ min: 1, max: 10 }),
        // Pick vote choice (APPROVE or REJECT)
        fc.constantFrom(...validChoices),
        // Pick an arbitrary amount from $1.00 to $200.00
        fc.integer({ min: 100, max: 20000 }),
        (singleVoterId, voteCount, choice, amountCents) => {
          // Construct vote list where ONLY this single voter voted
          const votesList: Vote[] = Array.from({ length: voteCount }, () => ({
            proposal_id: 'prop_test',
            member_id: singleVoterId,
            kind: 'VOTE',
            choice,
          }));

          const input = createBaseInput({
            now: '2026-11-02T12:05:00.000Z', // Veto window ended
            proposal: {
              ...createBaseInput().proposal,
              amount_cents: amountCents,
            },
            votes: votesList,
            eligibleVoters: [...eligibleMembers], // 6 eligible voters
          });

          const result = evaluate(input);

          // All tiers in demo policy require at least 2 votes
          // Therefore, a single voter must NEVER result in APPROVED or executionAllowed!
          expect(result.decision).not.toBe('APPROVED');
          expect(result.executionAllowed).toBe(false);
          expect(['NEEDS_VOTES', 'REJECTED_BY_VOTE', 'BLOCKED']).toContain(result.decision);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('42. Core Promise: Random vote sets with strictly fewer approvals than votesRequired NEVER approve', () => {
    fc.assert(
      fc.property(
        // Random subset of eligible voters who approve (0 to 3 voters for a tier requiring 4)
        fc.subarray(eligibleMembers, { minLength: 0, maxLength: 3 }),
        (approvingVoters) => {
          const votesList: Vote[] = approvingVoters.map(id => ({
            proposal_id: 'prop_test',
            member_id: id,
            kind: 'VOTE',
            choice: 'APPROVE',
          }));

          const input = createBaseInput({
            now: '2026-11-02T12:05:00.000Z',
            proposal: {
              ...createBaseInput().proposal,
              amount_cents: 14500, // Tier 2: requires 4 votes
            },
            votes: votesList,
            eligibleVoters: [...eligibleMembers],
          });

          const result = evaluate(input);
          expect(result.decision).not.toBe('APPROVED');
          expect(result.executionAllowed).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
