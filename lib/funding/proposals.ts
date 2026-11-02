/**
 * Quorum Funding Decision Proposal Factory
 * 
 * Automatically generates the two S4 governance proposals during a partial failure:
 * 1. ACCEPT_REDUCED_BUDGET: Group continues with available captured pool; uncaptured members become inactive
 * 2. UNWIND_FUNDING: Default safe path, refunds all captured contributions and voids authorizations
 * 
 * Invariants:
 * - Only members with CAPTURED status are eligible voters
 * - Uncaptured members cannot vote on the captured pool's future
 */

import { FundingRound, Contribution } from './types';
import { ProposalSnapshot } from '../guard/types';

export interface S4GovernanceProposals {
  acceptReducedProposal: ProposalSnapshot;
  unwindProposal: ProposalSnapshot;
  eligibleVoterMemberIds: string[];
}

export function createPartialFailureProposals(
  round: FundingRound,
  contributions: Contribution[],
  now: string,
  votingHours: number = 24
): S4GovernanceProposals {
  const captured = contributions.filter((c) => c.status === 'CAPTURED');
  const uncaptured = contributions.filter((c) => c.status !== 'CAPTURED');

  const totalCapturedCents = captured.reduce((sum, c) => sum + c.amount_cents, 0);
  const eligibleVoterMemberIds = captured.map((c) => c.member_id);

  const nowMs = new Date(now).getTime();
  const votingDeadline = new Date(nowMs + votingHours * 60 * 60 * 1000).toISOString();
  // Veto ends at the same time as deadline (or 2 mins after quorum)
  const vetoEndsAt = new Date(nowMs + 2 * 60 * 1000).toISOString();

  const acceptReducedProposal: ProposalSnapshot = {
    id: `prop_accept_reduced_${round.id.slice(0, 8)}`,
    group_id: round.group_id,
    type: 'ACCEPT_REDUCED_BUDGET',
    status: 'OPEN',
    created_by_kind: 'SYSTEM',
    policy_version: 1,
    amount_cents: 0,
    payload: {
      new_budget_cents: totalCapturedCents,
      original_goal_cents: round.per_member_cents * round.min_contributors,
      captured_member_ids: eligibleVoterMemberIds,
      uncaptured_member_ids: uncaptured.map((c) => c.member_id),
      reason: `Partial failure: ${captured.length} of ${round.min_contributors} captures succeeded ($${(totalCapturedCents / 100).toFixed(2)} USD).`,
    },
    voting_deadline: votingDeadline,
    veto_ends_at: vetoEndsAt,
  };

  const unwindProposal: ProposalSnapshot = {
    id: `prop_unwind_funding_${round.id.slice(0, 8)}`,
    group_id: round.group_id,
    type: 'UNWIND_FUNDING',
    status: 'OPEN',
    created_by_kind: 'SYSTEM',
    policy_version: 1,
    amount_cents: 0,
    payload: {
      reason: 'Partial failure: group decided to unwind funds, refund captured contributions, and void pending authorizations.',
      captured_amount_cents: totalCapturedCents,
      refund_count: captured.length,
    },
    voting_deadline: votingDeadline,
    veto_ends_at: vetoEndsAt,
  };

  return {
    acceptReducedProposal,
    unwindProposal,
    eligibleVoterMemberIds,
  };
}
