/**
 * Quorum Funding Round State Machine
 * 
 * Strict Pure State Machine:
 * - Deterministic status transitions
 * - Disallows illegal state jumps
 * - Directly handles partial funding failures (S4)
 */

import {
  FundingRound,
  FundingRoundStatus,
  Contribution,
  ContributionStatus,
  FundingPolicySnapshot,
} from './types';

const ALLOWED_ROUND_TRANSITIONS: Record<FundingRoundStatus, FundingRoundStatus[]> = {
  OPEN: ['CAPTURING', 'CANCELLED'],
  CAPTURING: ['FUNDED', 'PARTIAL_FAILURE'],
  PARTIAL_FAILURE: ['AWAITING_GROUP_DECISION'],
  AWAITING_GROUP_DECISION: ['FUNDED_REDUCED', 'UNWINDING'],
  FUNDED: [],
  FUNDED_REDUCED: [],
  UNWINDING: ['UNWOUND'],
  UNWOUND: [],
  CANCELLED: [],
};

const ALLOWED_CONTRIBUTION_TRANSITIONS: Record<ContributionStatus, ContributionStatus[]> = {
  PENDING_APPROVAL: ['AUTHORIZED', 'VOIDED'],
  AUTHORIZED: ['CAPTURE_PENDING', 'VOIDED'],
  CAPTURE_PENDING: ['CAPTURED', 'CAPTURE_FAILED'],
  CAPTURE_FAILED: ['CAPTURE_PENDING', 'VOIDED'],
  CAPTURED: ['REFUNDED'],
  VOIDED: [],
  REFUNDED: [],
};

export class IllegalTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Illegal ${entity} transition from '${from}' to '${to}'`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Validates whether a funding round status transition is permitted.
 */
export function canRoundTransition(from: FundingRoundStatus, to: FundingRoundStatus): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_ROUND_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a funding round transition is valid, throwing IllegalTransitionError if not.
 */
export function assertRoundTransition(from: FundingRoundStatus, to: FundingRoundStatus): void {
  if (!canRoundTransition(from, to)) {
    throw new IllegalTransitionError('FundingRound', from, to);
  }
}

/**
 * Validates whether a contribution status transition is permitted.
 */
export function canContributionTransition(from: ContributionStatus, to: ContributionStatus): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_CONTRIBUTION_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a contribution transition is valid, throwing IllegalTransitionError if not.
 */
export function assertContributionTransition(from: ContributionStatus, to: ContributionStatus): void {
  if (!canContributionTransition(from, to)) {
    throw new IllegalTransitionError('Contribution', from, to);
  }
}

export interface RoundEvaluation {
  status: FundingRoundStatus;
  changed: boolean;
  reason: string;
  totalCapturedCents: number;
  capturedContributorsCount: number;
  failedContributorsCount: number;
}

/**
 * Evaluates the deterministic state of a funding round based on its contributions,
 * policy configuration, and the injected current timestamp (`now`).
 */
export function evaluateRoundStatus(
  round: FundingRound,
  contributions: Contribution[],
  policy: FundingPolicySnapshot,
  now: string
): RoundEvaluation {
  const currentStatus = round.status;
  const nowMs = new Date(now).getTime();
  const maxAttempts = policy.capture_retry_attempts + 1; // initial attempt + retries

  const captured = contributions.filter((c) => c.status === 'CAPTURED');
  const totalCapturedCents = captured.reduce((sum, c) => sum + c.amount_cents, 0);
  const authorized = contributions.filter((c) => c.status === 'AUTHORIZED');

  const permanentlyFailed = contributions.filter(
    (c) => c.status === 'CAPTURE_FAILED' && c.capture_attempts >= maxAttempts
  );

  let nextStatus: FundingRoundStatus = currentStatus;
  let reason = `Round status remains '${currentStatus}'`;

  switch (currentStatus) {
    case 'OPEN': {
      // 1. If authorized count meets or exceeds minimum contributors, start capturing
      if (authorized.length >= round.min_contributors) {
        nextStatus = 'CAPTURING';
        reason = `Threshold met (${authorized.length}/${round.min_contributors} authorized). Commencing capture phase.`;
      } else if (nowMs > new Date(round.authorization_deadline).getTime()) {
        // 2. Authorization deadline passed underfunded -> CANCELLED
        nextStatus = 'CANCELLED';
        reason = `Authorization deadline passed with only ${authorized.length}/${round.min_contributors} contributors authorized.`;
      }
      break;
    }

    case 'CAPTURING': {
      const allResolved = contributions.every(
        (c) => c.status === 'CAPTURED' || (c.status === 'CAPTURE_FAILED' && c.capture_attempts >= maxAttempts)
      );

      if (captured.length === contributions.length && contributions.length >= round.min_contributors) {
        nextStatus = 'FUNDED';
        reason = `All ${captured.length} member contributions successfully captured. Group is fully funded!`;
      } else if (permanentlyFailed.length > 0 && allResolved) {
        nextStatus = 'PARTIAL_FAILURE';
        reason = `Capture phase concluded with ${permanentlyFailed.length} failure(s) after ${maxAttempts} attempts.`;
      }
      break;
    }

    case 'PARTIAL_FAILURE': {
      // Automatic immediate transition to awaiting group decision
      nextStatus = 'AWAITING_GROUP_DECISION';
      reason = 'Governance proposals generated for partial failure resolution.';
      break;
    }

    case 'AWAITING_GROUP_DECISION': {
      // Default unwind if decision deadline expires without resolution
      if (round.decision_deadline && nowMs >= new Date(round.decision_deadline).getTime()) {
        nextStatus = 'UNWINDING';
        reason = 'Decision deadline expired without group resolution; executing default safe unwind.';
      }
      break;
    }

    case 'UNWINDING': {
      // All contributions must be refunded or voided
      const allUnwound = contributions.every(
        (c) => c.status === 'REFUNDED' || c.status === 'VOIDED'
      );
      if (allUnwound && contributions.length > 0) {
        nextStatus = 'UNWOUND';
        reason = 'All member funds refunded and authorizations voided. Unwind complete.';
      }
      break;
    }

    case 'FUNDED':
    case 'FUNDED_REDUCED':
    case 'UNWOUND':
    case 'CANCELLED':
      // Terminal states
      break;
  }

  return {
    status: nextStatus,
    changed: nextStatus !== currentStatus,
    reason,
    totalCapturedCents,
    capturedContributorsCount: captured.length,
    failedContributorsCount: permanentlyFailed.length,
  };
}
