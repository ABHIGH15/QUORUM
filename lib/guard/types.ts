/**
 * Quorum Guard Types
 * 
 * Invariants:
 * - Pure TypeScript types
 * - No network, disk, or external dependencies
 * - Money is strictly integer cents
 */

export type GuardPhase = 'PROPOSAL' | 'VOTING' | 'EXECUTION';

export type GuardDecision =
  | 'APPROVED'
  | 'VETO_WINDOW_OPEN'
  | 'NEEDS_VOTES'
  | 'REJECTED_BY_VOTE'
  | 'VETOED'
  | 'BLOCKED';

export interface ApprovalTier {
  max_cents: number;
  votes_required: number;
}

export interface PolicyFunding {
  per_member_cents: number;
  min_contributors: number;
  authorization_window_hours: number;
  capture_retry_attempts: number;
  capture_retry_interval_minutes: number;
  partial_failure_decision: string;
  partial_failure_default: string;
  reduced_budget_votes_required: string;
}

export interface PolicyVendors {
  mode: 'ALLOWLIST_ONLY' | 'OPEN';
  allowlist_vendor_ids: string[];
}

export interface Policy {
  id?: string;
  version: number;
  currency: 'USD';
  budget_cents: number;
  hard_cap_cents: number;
  unanimous_above_cents: number;
  approval_tiers: ApprovalTier[];
  veto_window_minutes: number;
  proposal_expiry_hours: number;
  vendors: PolicyVendors;
  categories_allowed: string[];
  funding: PolicyFunding;
  amendment_votes_required: number;
  close?: { refund: string };
}

export interface GroupSnapshot {
  id: string;
  mode: 'POOLED' | 'PURCHASER';
  status: 'DRAFT' | 'FUNDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | (string & {});
}

export interface FundingRoundSnapshot {
  id: string;
  status:
    | 'OPEN'
    | 'CAPTURING'
    | 'FUNDED'
    | 'PARTIAL_FAILURE'
    | 'AWAITING_GROUP_DECISION'
    | 'FUNDED_REDUCED'
    | 'UNWINDING'
    | 'UNWOUND'
    | 'CANCELLED'
    | (string & {});
}

export interface ProposalSnapshot {
  id: string;
  group_id: string;
  type: 'PURCHASE' | 'POLICY_AMENDMENT' | 'ACCEPT_REDUCED_BUDGET' | 'UNWIND_FUNDING' | (string & {});
  status: string;
  created_by_kind: 'AGENT' | 'MEMBER' | 'SYSTEM';
  created_by?: string;
  policy_version: number;
  vendor_id?: string;
  category?: string;
  amount_cents?: number;
  currency?: string;
  payload: Record<string, any>;
  voting_deadline?: string;
  veto_ends_at?: string;
}

export interface Vote {
  id?: string;
  proposal_id: string;
  member_id: string;
  kind: 'VOTE' | 'VETO';
  choice: 'APPROVE' | 'REJECT' | 'VETO';
  created_at?: string;
  sequence_num?: number;
}

export interface Vendor {
  id: string;
  name: string;
  paypal_email: string;
  category: string;
  verified: boolean;
  source: 'CATALOG' | 'AGENT_FOUND';
}

export interface FundsSnapshot {
  availableCents: number;
  reservedCents: number;
  fundingReady: boolean;
}

export interface GuardInput {
  phase: GuardPhase;
  now: string; // Injected ISO timestamp for deterministic evaluation
  policy: Policy;
  group: GroupSnapshot;
  fundingRound?: FundingRoundSnapshot;
  proposal: ProposalSnapshot;
  votes: Vote[];
  eligibleVoters: string[];
  vendor?: Vendor;
  funds: FundsSnapshot;
  existingLivePayment: boolean;
}

export interface CheckDetail {
  code: string;
  pass: boolean;
  detail: string;
}

export interface GuardNumbers {
  amountCents: number;
  hardCapCents: number;
  unanimousAboveCents: number;
  availableCents: number;
  remainingAfterCents: number;
  votesRequired: number;
  approvals: number;
  eligibleVoters: number;
  vetoActive: boolean;
}

export interface GuardSuggestions {
  maxAllowedAmountCents: number;
}

export interface GuardResult {
  decision: GuardDecision;
  executionAllowed: boolean;
  reasonCodes: string[];
  checks: CheckDetail[];
  numbers: GuardNumbers;
  suggestions: GuardSuggestions;
}
