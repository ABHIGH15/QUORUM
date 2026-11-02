/**
 * Quorum Funding State Machine Types
 * 
 * Invariants:
 * - Pure TypeScript types
 * - Money strictly in integer cents (USD)
 * - Zero external I/O or network dependencies
 */

export type FundingRoundStatus =
  | 'OPEN'
  | 'CAPTURING'
  | 'FUNDED'
  | 'PARTIAL_FAILURE'
  | 'AWAITING_GROUP_DECISION'
  | 'FUNDED_REDUCED'
  | 'UNWINDING'
  | 'UNWOUND'
  | 'CANCELLED';

export type ContributionStatus =
  | 'PENDING_APPROVAL'
  | 'AUTHORIZED'
  | 'CAPTURE_PENDING'
  | 'CAPTURED'
  | 'CAPTURE_FAILED'
  | 'VOIDED'
  | 'REFUNDED';

export interface Contribution {
  id: string;
  round_id: string;
  member_id: string;
  amount_cents: number;
  status: ContributionStatus;
  paypal_order_id?: string;
  authorization_id?: string;
  capture_id?: string;
  authorized_at?: string;
  honor_expires_at?: string;       // authorized_at + 3 days
  authorization_expires_at?: string; // authorized_at + 29 days
  capture_attempts: number;
  next_retry_at?: string;
  last_error?: string;
}

export interface FundingRound {
  id: string;
  group_id: string;
  status: FundingRoundStatus;
  per_member_cents: number;
  min_contributors: number;
  authorization_deadline: string;
  decision_deadline?: string;
  created_at: string;
}

export interface FundingPolicySnapshot {
  per_member_cents: number;
  min_contributors: number;
  authorization_window_hours: number;
  capture_retry_attempts: number;
  capture_retry_interval_minutes: number;
  partial_failure_decision: string;
  partial_failure_default: string;
  reduced_budget_votes_required: string;
}
