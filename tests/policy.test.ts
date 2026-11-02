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

describe('Policy Deterministic Validator (§5.2)', () => {
  it('passes on valid demo policy', () => {
    const res = validatePolicy(validPolicy, knownVendors);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('fails Rule 1 when budget does not match per_member * contributors', () => {
    const invalid = { ...validPolicy, budget_cents: 50000 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 1'))).toBe(true);
  });

  it('fails Rule 2 when hard_cap > budget or unanimous > hard_cap', () => {
    const invalid = { ...validPolicy, hard_cap_cents: 60000 };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 2'))).toBe(true);
  });

  it('fails Rule 3 when tiers are unsorted or highest tier != hard_cap', () => {
    const invalid = {
      ...validPolicy,
      approval_tiers: [
        { max_cents: 10000, votes_required: 2 },
        { max_cents: 5000, votes_required: 4 },
      ],
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('Rule 3'))).toBe(true);
  });

  it('fails Rule 6 when authorization window > 48 hours', () => {
    const invalid = {
      ...validPolicy,
      funding: { ...validPolicy.funding, authorization_window_hours: 72 },
    };
    const res = validatePolicy(invalid, knownVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('authorization_window_hours'))).toBe(true);
  });

  it('fails Rule 8 when allowlisted vendor is unverified or unknown', () => {
    const unverifiedVendors: Vendor[] = [
      { ...knownVendors[0], verified: false },
      knownVendors[1],
    ];
    const res = validatePolicy(validPolicy, unverifiedVendors);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('not verified'))).toBe(true);
  });
});
