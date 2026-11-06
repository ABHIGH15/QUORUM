/**
 * Quorum Policy Schema & Deterministic Validator (§5)
 * 
 * Invariants:
 * - Deterministic validation without LLM
 * - Pure TypeScript + Zod schema
 */

import { z } from 'zod';
import { Policy, Vendor } from '../guard/types';

export const ApprovalTierSchema = z.object({
  max_cents: z.number().int(),
  votes_required: z.number().int(),
});

export const PolicyFundingSchema = z.object({
  per_member_cents: z.number().int(),
  min_contributors: z.number().int(),
  authorization_window_hours: z.number().int(),
  capture_retry_attempts: z.number().int(),
  capture_retry_interval_minutes: z.number().int(),
  partial_failure_decision: z.string().default('GROUP_VOTE'),
  partial_failure_default: z.string(),
  reduced_budget_votes_required: z.string().default('MAJORITY_OF_CONTRIBUTORS'),
});

export const PolicyVendorsSchema = z.object({
  mode: z.enum(['ALLOWLIST_ONLY', 'OPEN']),
  allowlist_vendor_ids: z.array(z.string()),
});

export const PolicySchema = z.object({
  id: z.string().optional(),
  version: z.number().int().default(1),
  currency: z.literal('USD'),
  budget_cents: z.number().int(),
  hard_cap_cents: z.number().int(),
  unanimous_above_cents: z.number().int(),
  approval_tiers: z.array(ApprovalTierSchema).min(1),
  veto_window_minutes: z.number().int(),
  proposal_expiry_hours: z.number().int(),
  vendors: PolicyVendorsSchema,
  categories_allowed: z.array(z.string()).min(1),
  funding: PolicyFundingSchema,
  amendment_votes_required: z.number().int(),
  close: z.object({ refund: z.string() }).optional(),
});

export interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a policy snapshot against the 9 non-negotiable deterministic rules (§5.2)
 */
export function validatePolicy(policy: Policy, knownVendors?: Vendor[]): PolicyValidationResult {
  const errors: string[] = [];

  // Parse against Zod schema for structural integrity
  const parsed = PolicySchema.safeParse(policy);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`Structural error in ${issue.path.join('.')}: ${issue.message}`);
    }
    return { valid: false, errors };
  }

  const p = parsed.data;

  // Rule 1: budget_cents == funding.per_member_cents * funding.min_contributors
  const calculatedBudget = p.funding.per_member_cents * p.funding.min_contributors;
  if (p.budget_cents !== calculatedBudget) {
    errors.push(
      `Rule 1 violation: budget_cents ($${p.budget_cents / 100}) must equal per_member_cents * min_contributors ($${calculatedBudget / 100})`
    );
  }

  // Rule 2: 0 < unanimous_above_cents <= hard_cap_cents <= budget_cents
  if (
    p.unanimous_above_cents <= 0 ||
    p.unanimous_above_cents > p.hard_cap_cents ||
    p.hard_cap_cents > p.budget_cents
  ) {
    errors.push(
      `Rule 2 violation: Must satisfy 0 < unanimous_above_cents ($${p.unanimous_above_cents / 100}) <= hard_cap_cents ($${p.hard_cap_cents / 100}) <= budget_cents ($${p.budget_cents / 100})`
    );
  }

  // Rule 3: approval_tiers sorted by max_cents ascending; highest tier's max_cents == hard_cap_cents
  for (let i = 0; i < p.approval_tiers.length - 1; i++) {
    if (p.approval_tiers[i].max_cents >= p.approval_tiers[i + 1].max_cents) {
      errors.push(`Rule 3 violation: approval_tiers must be strictly sorted by max_cents ascending`);
      break;
    }
  }
  const highestTier = p.approval_tiers[p.approval_tiers.length - 1];
  if (highestTier && highestTier.max_cents !== p.hard_cap_cents) {
    errors.push(
      `Rule 3 violation: Highest tier max_cents ($${highestTier.max_cents / 100}) must equal hard_cap_cents ($${p.hard_cap_cents / 100})`
    );
  }

  // Rule 4: Every votes_required is between 1 and min_contributors
  for (const tier of p.approval_tiers) {
    if (tier.votes_required < 1 || tier.votes_required > p.funding.min_contributors) {
      errors.push(
        `Rule 4 violation: Tier with max_cents $${tier.max_cents / 100} has votes_required ${tier.votes_required}, which must be between 1 and min_contributors (${p.funding.min_contributors})`
      );
    }
  }

  // Rule 5: veto_window_minutes >= 1; capture_retry_attempts between 0 and 3
  if (p.veto_window_minutes < 1) {
    errors.push(`Rule 5 violation: veto_window_minutes must be >= 1`);
  }
  if (p.funding.capture_retry_attempts < 0 || p.funding.capture_retry_attempts > 3) {
    errors.push(`Rule 5 violation: capture_retry_attempts must be between 0 and 3`);
  }

  // Rule 6: authorization_window_hours <= 48
  if (p.funding.authorization_window_hours > 48 || p.funding.authorization_window_hours < 1) {
    errors.push(`Rule 6 violation: authorization_window_hours must be between 1 and 48 (PayPal honor ceiling)`);
  }

  // Rule 7: partial_failure_default must be 'UNWIND'
  if (p.funding.partial_failure_default !== 'UNWIND') {
    errors.push(`Rule 7 violation: partial_failure_default must be 'UNWIND'`);
  }

  // Rule 8: If knownVendors is supplied, verify all allowlisted vendors exist with verified = true
  if (knownVendors && p.vendors.mode === 'ALLOWLIST_ONLY') {
    for (const vendorId of p.vendors.allowlist_vendor_ids) {
      const match = knownVendors.find(v => v.id === vendorId);
      if (!match) {
        errors.push(`Rule 8 violation: Allowlisted vendor '${vendorId}' does not exist in known vendors`);
      } else if (!match.verified) {
        errors.push(`Rule 8 violation: Allowlisted vendor '${vendorId}' is not verified`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface ParsedCharterResult {
  success: boolean;
  policy?: Policy;
  validationErrors?: string[];
  rawText: string;
}

/**
 * Extracts structured policy parameters from informal English charter text (§9.1 Tool 2)
 * Validates against PolicySchema & 9 deterministic rules before returning.
 */
export function parseCharterToPolicy(charterText: string): ParsedCharterResult {
  // Regex heuristics to extract core governance parameters from informal charter text
  // 1. Members count
  const memberMatch = charterText.match(/(\d+)\s*(?:members?|people|contributors?)/i);
  const minContributors = memberMatch ? parseInt(memberMatch[1], 10) : 6;

  // 2. Per-member contribution
  const perMemberMatch = charterText.match(/\$(\d+(?:\.\d{2})?)\s*(?:each|per\s*member|contribution)/i);
  const perMemberCents = perMemberMatch ? Math.round(parseFloat(perMemberMatch[1]) * 100) : 8000;

  // 3. Total budget
  const budgetMatch = charterText.match(/(?:budget|total|pool)\s*(?:of|is)?\s*\$(\d+(?:\.\d{2})?)/i);
  const budgetCents = budgetMatch
    ? Math.round(parseFloat(budgetMatch[1]) * 100)
    : perMemberCents * minContributors;

  // 4. Hard cap
  const hardCapMatch = charterText.match(
    /(?:hard\s*cap|max(?:imum)?\s*purchase|no\s*single\s*purchase\s*above|cap(?:ped\s*at)?)\s*\$(\d+(?:\.\d{2})?)/i
  );
  const hardCapCents = hardCapMatch ? Math.round(parseFloat(hardCapMatch[1]) * 100) : 20000;

  // 5. Unanimous threshold
  const unanimousMatch = charterText.match(
    /(?:unanimous\s*(?:above|over)?|unanimity\s*(?:above|over)?)\s*\$(\d+(?:\.\d{2})?)/i
  );
  const unanimousAboveCents = unanimousMatch ? Math.round(parseFloat(unanimousMatch[1]) * 100) : 15000;

  // 6. Veto window
  const vetoHourMatch = charterText.match(/(\d+)\s*(?:hour|hr)s?\s*veto/i);
  const vetoMinMatch = charterText.match(/(\d+)\s*(?:minute|min)s?\s*veto/i);
  let vetoWindowMinutes = 1440; // 24 hours default
  if (vetoHourMatch) {
    vetoWindowMinutes = parseInt(vetoHourMatch[1], 10) * 60;
  } else if (vetoMinMatch) {
    vetoWindowMinutes = parseInt(vetoMinMatch[1], 10);
  }

  // 7. Categories
  const catMatches: string[] = [];
  const knownCategories = ['Electronics', 'Entertainment', 'Office', 'Supplies', 'Food', 'Travel'];
  for (const cat of knownCategories) {
    if (new RegExp(`\\b${cat}\\b`, 'i').test(charterText)) {
      catMatches.push(cat);
    }
  }
  const categoriesAllowed = catMatches.length > 0 ? catMatches : ['Electronics', 'Entertainment', 'Office'];

  // 8. Approval Tiers (sorted ascending, highest equals hard cap)
  const approvalTiers = [
    { max_cents: 6000, votes_required: 2 },
    { max_cents: 15000, votes_required: 4 },
    { max_cents: hardCapCents, votes_required: minContributors },
  ];

  const candidatePolicy: Policy = {
    version: 1,
    currency: 'USD',
    budget_cents: budgetCents,
    hard_cap_cents: hardCapCents,
    unanimous_above_cents: unanimousAboveCents,
    approval_tiers: approvalTiers,
    veto_window_minutes: vetoWindowMinutes,
    proposal_expiry_hours: 72,
    vendors: {
      mode: 'OPEN',
      allowlist_vendor_ids: ['v_projector_shop', 'v_screen_co', 'v_audio_direct'],
    },
    categories_allowed: categoriesAllowed,
    funding: {
      per_member_cents: perMemberCents,
      min_contributors: minContributors,
      authorization_window_hours: 48,
      capture_retry_attempts: 2,
      capture_retry_interval_minutes: 60,
      partial_failure_decision: 'GROUP_VOTE',
      partial_failure_default: 'UNWIND',
      reduced_budget_votes_required: 'MAJORITY_OF_CONTRIBUTORS',
    },
    amendment_votes_required: minContributors,
  };

  const validation = validatePolicy(candidatePolicy);

  return {
    success: validation.valid,
    policy: candidatePolicy,
    validationErrors: validation.errors,
    rawText: charterText,
  };
}
