/**
 * Quorum Lazy State Synchronization Engine: tick(groupId)
 * 
 * Strict Invariant: Pure time-dependent transition engine.
 * Computes deterministic status transitions lazily without requiring a persistent cron daemon:
 * 1. Closes expired veto windows (VETO_WINDOW -> EXECUTABLE or VETOED)
 * 2. Marks expired proposals (OPEN -> EXPIRED)
 * 3. Advances funding round lifecycles (OPEN -> CAPTURING/CANCELLED, CAPTURING -> FUNDED/PARTIAL_FAILURE, AWAITING_GROUP_DECISION -> UNWINDING)
 * 4. Schedules eligible capture retries (CAPTURE_FAILED -> CAPTURE_PENDING)
 */

import { FundingRound, Contribution, FundingPolicySnapshot } from './types';
import { evaluateRoundStatus } from './state-machine';
import { shouldRetryCapture } from './retry';
import { ProposalSnapshot, Policy } from '../guard/types';
import { evaluate } from '../guard/evaluate';

export interface TickInput {
  groupId: string;
  now: string; // ISO timestamp
  policy: Policy;
  group: { id: string; mode: 'POOLED' | 'PURCHASER'; status: string };
  fundingRound?: FundingRound;
  contributions?: Contribution[];
  proposals: ProposalSnapshot[];
  funds: { availableCents: number; reservedCents: number; fundingReady: boolean };
}

export interface ProposalTransitionAction {
  proposalId: string;
  fromStatus: string;
  toStatus: string;
  reason: string;
}

export interface ContributionRetryAction {
  contributionId: string;
  attempt: number;
  reason: string;
}

export interface TickResult {
  groupId: string;
  evaluatedAt: string;
  proposalTransitions: ProposalTransitionAction[];
  roundTransition?: {
    fromStatus: string;
    toStatus: string;
    reason: string;
  };
  contributionRetries: ContributionRetryAction[];
  generateS4Proposals: boolean;
}

export function tickGroup(input: TickInput): TickResult {
  const { groupId, now, policy, group, fundingRound, contributions = [], proposals, funds } = input;
  const nowMs = new Date(now).getTime();

  const proposalTransitions: ProposalTransitionAction[] = [];
  const contributionRetries: ContributionRetryAction[] = [];
  let roundTransition: TickResult['roundTransition'] = undefined;
  let generateS4Proposals = false;

  // 1. Evaluate Proposals: Expiration and Veto Window Completion
  for (const proposal of proposals) {
    if (proposal.status === 'OPEN') {
      // Check voting deadline expiration
      if (proposal.voting_deadline && nowMs > new Date(proposal.voting_deadline).getTime()) {
        proposalTransitions.push({
          proposalId: proposal.id,
          fromStatus: 'OPEN',
          toStatus: 'EXPIRED',
          reason: `Voting deadline (${proposal.voting_deadline}) passed at ${now}.`,
        });
      }
    } else if (proposal.status === 'VETO_WINDOW') {
      // Check veto window closure
      if (proposal.veto_ends_at && nowMs >= new Date(proposal.veto_ends_at).getTime()) {
        // Run Guard to check whether a veto landed or approvals hold
        const guardResult = evaluate({
          phase: 'VOTING',
          now,
          policy,
          group: { id: group.id, mode: group.mode, status: group.status },
          fundingRound: fundingRound ? { id: fundingRound.id, status: fundingRound.status } : undefined,
          proposal,
          votes: [],
          eligibleVoters: [],
          funds,
          existingLivePayment: false,
        });

        if (guardResult.decision === 'VETOED') {
          proposalTransitions.push({
            proposalId: proposal.id,
            fromStatus: 'VETO_WINDOW',
            toStatus: 'VETOED',
            reason: 'Veto window concluded with active member veto.',
          });
        } else {
          proposalTransitions.push({
            proposalId: proposal.id,
            fromStatus: 'VETO_WINDOW',
            toStatus: 'EXECUTABLE',
            reason: `Veto window concluded at ${proposal.veto_ends_at}; ready for member execution.`,
          });
        }
      }
    }
  }

  // 2. Evaluate Funding Round Lifecycle
  if (fundingRound) {
    const fundingPolicy: FundingPolicySnapshot = policy.funding;
    const roundEval = evaluateRoundStatus(fundingRound, contributions, fundingPolicy, now);

    if (roundEval.changed) {
      roundTransition = {
        fromStatus: fundingRound.status,
        toStatus: roundEval.status,
        reason: roundEval.reason,
      };

      if (roundEval.status === 'PARTIAL_FAILURE') {
        generateS4Proposals = true;
      }
    }

    // 3. Evaluate Capture Retries in CAPTURING status
    if (fundingRound.status === 'CAPTURING') {
      const maxAttempts = fundingPolicy.capture_retry_attempts + 1;
      for (const contribution of contributions) {
        if (shouldRetryCapture(contribution, maxAttempts, now)) {
          contributionRetries.push({
            contributionId: contribution.id,
            attempt: contribution.capture_attempts + 1,
            reason: `Retry countdown reached at ${now} (attempt ${contribution.capture_attempts + 1}/${maxAttempts}).`,
          });
        }
      }
    }
  }

  return {
    groupId,
    evaluatedAt: now,
    proposalTransitions,
    roundTransition,
    contributionRetries,
    generateS4Proposals,
  };
}
