import { describe, it, expect } from 'vitest';
import { validatePolicy } from '../lib/policy/validator';
import { Policy, Vendor } from '../lib/guard/types';

const validPolicy: Policy = {
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
    allowlist_vendor_ids: ['v_projector_shop', 'v_cafe_supplies'],
  },
  categories_allowed: ['equipment', 'food'],
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

const knownVendors: Vendor[] = [
  {
    id: 'v_projector_shop',
    name: 'Projector Shop',
    paypal_email: 'vendor-p@sandbox.com',
    category: 'equipment',
    verified: true,
    source: 'CATALOG',
  },
  {
    id: 'v_cafe_supplies',
    name: 'Cafe Supplies',
    paypal_email: 'vendor-c@sandbox.com',
    category: 'food',
    verified: true,
    source: 'CATALOG',
  },
];

describe('Policy Deterministic Validator - All 9 Rules Tested (§5.2)', () => {
  it('0. Baseline: Passes on valid demo policy', () => {
    const res = validatePolicy(validPolicy, knownVendors);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('Rule 1: Fails when budget_cents != per_member_cents * min_contributors', () => {
    const invalid = { ...validPolicy, budget_cents: 50000 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 1'))).toBe(true);
  });

  it('Rule 2A: Fails when hard_cap_cents > budget_cents', () => {
    const invalid = { ...validPolicy, hard_cap_cents: 60000 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 2'))).toBe(true);
  });

  it('Rule 2B: Fails when unanimous_above_cents > hard_cap_cents', () => {
    const invalid = { ...validPolicy, unanimous_above_cents: 25000 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 2'))).toBe(true);
  });

  it('Rule 3A: Fails when approval_tiers are unsorted', () => {
    const invalid = {
      ...validPolicy,
      approval_tiers: [
        { max_cents: 10000, votes_required: 2 },
        { max_cents: 5000, votes_required: 4 },
      ],
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 3') && e.includes('sorted'))).toBe(true);
  });

  it('Rule 3B: Fails when highest tier max_cents != hard_cap_cents', () => {
    const invalid = {
      ...validPolicy,
      approval_tiers: [
        { max_cents: 6000, votes_required: 2 },
        { max_cents: 18000, votes_required: 4 }, // != hard_cap_cents 20000
      ],
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 3') && e.includes('Highest tier'))).toBe(true);
  });

  it('Rule 4: Fails when votes_required is outside 1..min_contributors range', () => {
    const invalid = {
      ...validPolicy,
      approval_tiers: [
        { max_cents: 6000, votes_required: 0 }, // Below 1
        { max_cents: 20000, votes_required: 7 }, // Above min_contributors (6)
      ],
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 4'))).toBe(true);
  });

  it('Rule 5A: Fails when veto_window_minutes < 1', () => {
    const invalid = { ...validPolicy, veto_window_minutes: 0 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 5') && e.includes('veto_window_minutes'))).toBe(true);
  });

  it('Rule 5B: Fails when capture_retry_attempts > 3', () => {
    const invalid = {
      ...validPolicy,
      funding: { ...validPolicy.funding, capture_retry_attempts: 5 },
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 5') && e.includes('capture_retry_attempts'))).toBe(true);
  });

  it('Rule 6: Fails when authorization_window_hours > 48 (PayPal honor ceiling)', () => {
    const invalid = {
      ...validPolicy,
      funding: { ...validPolicy.funding, authorization_window_hours: 72 },
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 6') && e.includes('authorization_window_hours'))).toBe(true);
  });

  it('Rule 7: Fails when partial_failure_default is not UNWIND', () => {
    const invalid = {
      ...validPolicy,
      funding: { ...validPolicy.funding, partial_failure_default: 'KEEP_FUNDS' as any },
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 7') || e.includes('UNWIND'))).toBe(true);
  });

  it('Rule 8A: Fails when allowlisted vendor does not exist in known vendors', () => {
    const invalid = {
      ...validPolicy,
      vendors: {
        mode: 'ALLOWLIST_ONLY' as const,
        allowlist_vendor_ids: ['v_unknown_vendor'],
      },
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 8') && e.includes('does not exist'))).toBe(true);
  });

  it('Rule 8B: Fails when allowlisted vendor exists but verified is false', () => {
    const unverifiedVendors: Vendor[] = [
      { ...knownVendors[0], verified: false },
      knownVendors[1],
    ];
    const res = validatePolicy(validPolicy, unverifiedVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 8') && e.includes('not verified'))).toBe(true);
  });
});
