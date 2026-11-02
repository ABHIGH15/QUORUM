/**
 * Quorum Guard Core Evaluator
 * 
 * Strict Pure Function:
 * - No I/O, no network, no database calls, no LLM
 * - Injected clock (`input.now`) ensures 100% deterministic testing
 * - Single source of truth for spending authorization
 * - Guaranteed: No single voter can authorize an expenditure alone when votes_required >= 2
 */

import {
  GuardInput,
  GuardResult,
  GuardDecision,
  CheckDetail,
  GuardNumbers,
  GuardSuggestions,
  Vote,
} from './types';

export function evaluate(input: GuardInput): GuardResult {
  const {
    phase,
    now,
    policy,
    group,
    proposal,
    votes,
    eligibleVoters,
    vendor,
    funds,
    existingLivePayment,
  } = input;

  const checks: CheckDetail[] = [];
  const reasonCodes: string[] = [];

  const amountCents = proposal.amount_cents ?? 0;
  const hardCapCents = policy.hard_cap_cents;
  const unanimousAboveCents = policy.unanimous_above_cents;
  const availableCents = funds.availableCents;
  const remainingAfterCents = availableCents - amountCents;
  const eligibleVotersCount = eligibleVoters.length;

  // ---------------------------------------------------------------------------
  // 1. Structural & Policy Checks (can cause BLOCKED)
  // ---------------------------------------------------------------------------

  // GROUP_NOT_ACTIVE
  const isGroupActive = group.status === 'ACTIVE';
  const groupActivePass = isGroupActive && (group.mode !== 'POOLED' || funds.fundingReady);
  checks.push({
    code: 'GROUP_NOT_ACTIVE',
    pass: groupActivePass,
    detail: groupActivePass
      ? `Group ${group.id} is ACTIVE and funding is verified`
      : `Group status is '${group.status}' (fundingReady: ${funds.fundingReady})`,
  });
  if (!groupActivePass) reasonCodes.push('GROUP_NOT_ACTIVE');

  // PROPOSAL_EXPIRED
  const isExpired = Boolean(
    proposal.voting_deadline &&
    new Date(now).getTime() > new Date(proposal.voting_deadline).getTime() &&
    proposal.status === 'OPEN'
  );
  checks.push({
    code: 'PROPOSAL_EXPIRED',
    pass: !isExpired,
    detail: isExpired
      ? `Proposal expired at ${proposal.voting_deadline} (current time: ${now})`
      : `Proposal is within voting deadline (${proposal.voting_deadline ?? 'none'})`,
  });
  if (isExpired) reasonCodes.push('PROPOSAL_EXPIRED');

  // POLICY_VERSION_CHANGED
  const policyVersionMatch = proposal.policy_version === policy.version;
  checks.push({
    code: 'POLICY_VERSION_CHANGED',
    pass: policyVersionMatch,
    detail: policyVersionMatch
      ? `Proposal policy version ${proposal.policy_version} matches active version ${policy.version}`
      : `Proposal policy version ${proposal.policy_version} does not match active version ${policy.version}`,
  });
  if (!policyVersionMatch) reasonCodes.push('POLICY_VERSION_CHANGED');

  // PROPOSER_NOT_ALLOWED
  let proposerAllowed = false;
  if (proposal.created_by_kind === 'AGENT' || proposal.created_by_kind === 'SYSTEM') {
    proposerAllowed = true;
  } else if (proposal.created_by_kind === 'MEMBER') {
    proposerAllowed = Boolean(proposal.created_by && eligibleVoters.includes(proposal.created_by));
  }
  checks.push({
    code: 'PROPOSER_NOT_ALLOWED',
    pass: proposerAllowed,
    detail: proposerAllowed
      ? `Proposer ${proposal.created_by ?? proposal.created_by_kind} is authorized`
      : `Proposer ${proposal.created_by ?? 'unknown'} is not an eligible member of the group`,
  });
  if (!proposerAllowed) reasonCodes.push('PROPOSER_NOT_ALLOWED');

  // CURRENCY_MISMATCH
  const currencyMatch = (!proposal.currency || proposal.currency === 'USD') && policy.currency === 'USD';
  checks.push({
    code: 'CURRENCY_MISMATCH',
    pass: currencyMatch,
    detail: currencyMatch
      ? `Currency is USD`
      : `Currency mismatch: proposal (${proposal.currency ?? 'USD'}) vs policy (${policy.currency})`,
  });
  if (!currencyMatch) reasonCodes.push('CURRENCY_MISMATCH');

  // VENDOR_NOT_ALLOWED
  let vendorAllowed = true;
  let vendorAllowedDetail = 'Vendor check not required for this proposal type';
  if (proposal.type === 'PURCHASE') {
    if (policy.vendors.mode === 'ALLOWLIST_ONLY') {
      vendorAllowed = Boolean(
        proposal.vendor_id &&
        policy.vendors.allowlist_vendor_ids.includes(proposal.vendor_id)
      );
      vendorAllowedDetail = vendorAllowed
        ? `Vendor ${proposal.vendor_id} is on the approved allowlist`
        : `Vendor ${proposal.vendor_id ?? 'none'} is not in policy allowlist [${policy.vendors.allowlist_vendor_ids.join(', ')}]`;
    } else {
      vendorAllowedDetail = 'Vendor allowlist mode is OPEN';
    }
  }
  checks.push({
    code: 'VENDOR_NOT_ALLOWED',
    pass: vendorAllowed,
    detail: vendorAllowedDetail,
  });
  if (!vendorAllowed) reasonCodes.push('VENDOR_NOT_ALLOWED');

  // VENDOR_UNVERIFIED
  let vendorVerified = true;
  let vendorVerifiedDetail = 'Vendor verification not applicable';
  if (proposal.type === 'PURCHASE') {
    vendorVerified = Boolean(vendor && vendor.verified === true);
    vendorVerifiedDetail = vendorVerified
      ? `Vendor ${vendor?.id} is verified`
      : `Vendor ${proposal.vendor_id ?? 'none'} has verified = false or is missing`;
  }
  checks.push({
    code: 'VENDOR_UNVERIFIED',
    pass: vendorVerified,
    detail: vendorVerifiedDetail,
  });
  if (!vendorVerified) reasonCodes.push('VENDOR_UNVERIFIED');

  // CATEGORY_NOT_ALLOWED
  let categoryAllowed = true;
  let categoryDetail = 'Category check not applicable';
  if (proposal.type === 'PURCHASE') {
    categoryAllowed = Boolean(
      proposal.category &&
      policy.categories_allowed.includes(proposal.category)
    );
    categoryDetail = categoryAllowed
      ? `Category '${proposal.category}' is permitted in policy`
      : `Category '${proposal.category ?? 'none'}' not permitted in [${policy.categories_allowed.join(', ')}]`;
  }
  checks.push({
    code: 'CATEGORY_NOT_ALLOWED',
    pass: categoryAllowed,
    detail: categoryDetail,
  });
  if (!categoryAllowed) reasonCodes.push('CATEGORY_NOT_ALLOWED');

  // HARD_CAP_EXCEEDED
  let hardCapPass = true;
  let hardCapDetail = 'Hard cap not applicable';
  if (proposal.type === 'PURCHASE') {
    hardCapPass = amountCents <= hardCapCents;
    hardCapDetail = hardCapPass
      ? `Amount $${(amountCents / 100).toFixed(2)} <= hard cap $${(hardCapCents / 100).toFixed(2)}`
      : `Amount $${(amountCents / 100).toFixed(2)} exceeds hard cap $${(hardCapCents / 100).toFixed(2)}`;
  }
  checks.push({
    code: 'HARD_CAP_EXCEEDED',
    pass: hardCapPass,
    detail: hardCapDetail,
  });
  if (!hardCapPass) reasonCodes.push('HARD_CAP_EXCEEDED');

  // BUDGET_EXCEEDED
  let budgetPass = true;
  let budgetDetail = 'Budget check not applicable';
  if (proposal.type === 'PURCHASE') {
    budgetPass = amountCents <= availableCents;
    budgetDetail = budgetPass
      ? `Amount $${(amountCents / 100).toFixed(2)} <= available budget $${(availableCents / 100).toFixed(2)}`
      : `Amount $${(amountCents / 100).toFixed(2)} exceeds available budget $${(availableCents / 100).toFixed(2)}`;
  }
  checks.push({
    code: 'BUDGET_EXCEEDED',
    pass: budgetPass,
    detail: budgetDetail,
  });
  if (!budgetPass) reasonCodes.push('BUDGET_EXCEEDED');

  // FUNDING_NOT_READY
  let fundingReadyPass = true;
  if (group.mode === 'POOLED') {
    fundingReadyPass = funds.fundingReady === true;
  }
  checks.push({
    code: 'FUNDING_NOT_READY',
    pass: fundingReadyPass,
    detail: fundingReadyPass
      ? `Funding pool ready status: ${funds.fundingReady}`
      : `Pooled mode requires funded pool; current status is not ready`,
  });
  if (!fundingReadyPass) reasonCodes.push('FUNDING_NOT_READY');

  // DUPLICATE_EXECUTION
  const noDuplicatePayment = !existingLivePayment;
  checks.push({
    code: 'DUPLICATE_EXECUTION',
    pass: noDuplicatePayment,
    detail: noDuplicatePayment
      ? `No live payment currently exists for proposal ${proposal.id}`
      : `A live payment already exists for proposal ${proposal.id}`,
  });
  if (!noDuplicatePayment) reasonCodes.push('DUPLICATE_EXECUTION');

  // ---------------------------------------------------------------------------
  // 2. Voting & Veto Calculations
  // ---------------------------------------------------------------------------

  // Determine required votes
  let votesRequired: number;
  if (proposal.type === 'PURCHASE') {
    if (amountCents > unanimousAboveCents) {
      // Unanimity override: mandates all eligible voters
      votesRequired = eligibleVotersCount;
    } else {
      // Tier lookup: find first tier whose max_cents >= amountCents
      const matchingTier = policy.approval_tiers.find(t => amountCents <= t.max_cents);
      if (matchingTier) {
        votesRequired = matchingTier.votes_required;
      } else {
        // Fallback to highest tier
        const lastTier = policy.approval_tiers[policy.approval_tiers.length - 1];
        votesRequired = lastTier?.votes_required ?? eligibleVotersCount;
      }
    }
  } else if (proposal.type === 'POLICY_AMENDMENT') {
    votesRequired = policy.amendment_votes_required;
  } else if (proposal.type === 'ACCEPT_REDUCED_BUDGET') {
    votesRequired = Math.floor(eligibleVotersCount / 2) + 1;
  } else {
    // UNWIND_FUNDING or other
    votesRequired = Math.floor(eligibleVotersCount / 2) + 1;
  }

  // ---------------------------------------------------------------------------
  // Vote Deduplication & Voter Eligibility Enforcement
  // Invariants:
  // - Only voters in `eligibleVoters` are recognized.
  // - Agent, owner (if not an eligible voter), removed members, and strangers are ignored.
  // - If a member votes multiple times, deduplicate by member_id (latest vote wins).
  // - A member who changes their vote counts once, reflecting their latest choice.
  // - Veto is tracked as a separate act, also restricted to eligibleVoters.
  // ---------------------------------------------------------------------------

  const memberVotesMap = new Map<string, Vote>();
  const memberVetoesMap = new Map<string, Vote>();

  // Process votes in order (or sort chronologically if created_at provided)
  const sortedVotes = [...votes].sort((a, b) => {
    if (a.created_at && b.created_at) {
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }
    return 0;
  });

  for (const vote of sortedVotes) {
    // Discard any vote from non-eligible participants
    if (!eligibleVoters.includes(vote.member_id)) {
      continue;
    }

    if (vote.kind === 'VETO' || vote.choice === 'VETO') {
      memberVetoesMap.set(vote.member_id, vote);
    } else if (vote.kind === 'VOTE') {
      // Deduplicate: latest vote from this member overwrites earlier vote
      memberVotesMap.set(vote.member_id, vote);
    }
  }

  const latestVotes = Array.from(memberVotesMap.values());
  const approvals = latestVotes.filter(v => v.choice === 'APPROVE').length;
  const rejections = latestVotes.filter(v => v.choice === 'REJECT').length;
  const votesCast = latestVotes.length; // Distinct eligible members who voted
  const unvotedEligible = eligibleVotersCount - votesCast;

  const vetoActive = memberVetoesMap.size > 0;
  const vetoVoters = Array.from(memberVetoesMap.keys());

  // VETOED
  const vetoPass = !vetoActive;
  checks.push({
    code: 'VETOED',
    pass: vetoPass,
    detail: vetoPass
      ? `No veto cast against proposal ${proposal.id}`
      : `Veto cast by ${vetoVoters.join(', ')}`,
  });
  if (!vetoPass) reasonCodes.push('VETOED');

  // REJECTED_BY_VOTE (Mathematical impossibility of passing)
  const mathematicallyPossible = (approvals + unvotedEligible) >= votesRequired;
  checks.push({
    code: 'REJECTED_BY_VOTE',
    pass: mathematicallyPossible,
    detail: mathematicallyPossible
      ? `Proposal can still pass (${approvals} approvals + ${unvotedEligible} remaining >= ${votesRequired} required)`
      : `Mathematically rejected: ${approvals} approvals + ${unvotedEligible} unvoted cannot reach ${votesRequired} required (rejections: ${rejections})`,
  });
  if (!mathematicallyPossible) reasonCodes.push('REJECTED_BY_VOTE');

  // NEEDS_VOTES
  const hasEnoughApprovals = approvals >= votesRequired;
  checks.push({
    code: 'NEEDS_VOTES',
    pass: hasEnoughApprovals,
    detail: hasEnoughApprovals
      ? `${approvals} approvals meet or exceed required ${votesRequired} (eligible voters: ${eligibleVotersCount})`
      : `${approvals} approvals are below required ${votesRequired} (eligible voters: ${eligibleVotersCount})`,
  });
  if (!hasEnoughApprovals) reasonCodes.push('NEEDS_VOTES');

  // VETO_WINDOW_OPEN
  let vetoWindowEnded = true;
  let vetoWindowDetail = 'Veto window not applicable or ended';
  if (hasEnoughApprovals) {
    if (proposal.veto_ends_at) {
      const nowMs = new Date(now).getTime();
      const vetoEndMs = new Date(proposal.veto_ends_at).getTime();
      // now < veto_ends_at means window is still open.
      // At now >= veto_ends_at, window has closed.
      vetoWindowEnded = nowMs >= vetoEndMs;
      vetoWindowDetail = vetoWindowEnded
        ? `Veto window closed at ${proposal.veto_ends_at} (current time: ${now})`
        : `Veto window is open until ${proposal.veto_ends_at} (current time: ${now})`;
    } else {
      vetoWindowEnded = true;
      vetoWindowDetail = 'Veto ends timestamp not set';
    }
  }
  checks.push({
    code: 'VETO_WINDOW_OPEN',
    pass: vetoWindowEnded,
    detail: vetoWindowDetail,
  });
  if (!vetoWindowEnded) reasonCodes.push('VETO_WINDOW_OPEN');

  // ---------------------------------------------------------------------------
  // 3. Decision Precedence
  // Precedence: BLOCKED > VETOED > REJECTED_BY_VOTE > NEEDS_VOTES > VETO_WINDOW_OPEN > APPROVED
  // ---------------------------------------------------------------------------

  const blockingCodes = [
    'GROUP_NOT_ACTIVE',
    'PROPOSAL_EXPIRED',
    'POLICY_VERSION_CHANGED',
    'PROPOSER_NOT_ALLOWED',
    'CURRENCY_MISMATCH',
    'VENDOR_NOT_ALLOWED',
    'VENDOR_UNVERIFIED',
    'CATEGORY_NOT_ALLOWED',
    'HARD_CAP_EXCEEDED',
    'BUDGET_EXCEEDED',
    'FUNDING_NOT_READY',
    'DUPLICATE_EXECUTION',
  ];

  const hasBlockingFailure = checks.some(c => !c.pass && blockingCodes.includes(c.code));

  let decision: GuardDecision;
  if (hasBlockingFailure) {
    decision = 'BLOCKED';
  } else if (!vetoPass) {
    decision = 'VETOED';
  } else if (!mathematicallyPossible) {
    decision = 'REJECTED_BY_VOTE';
  } else if (!hasEnoughApprovals) {
    decision = 'NEEDS_VOTES';
  } else if (!vetoWindowEnded) {
    decision = 'VETO_WINDOW_OPEN';
  } else {
    decision = 'APPROVED';
  }

  // executionAllowed is true ONLY for APPROVED in EXECUTION phase
  const executionAllowed = decision === 'APPROVED' && phase === 'EXECUTION';

  // Suggestions for the agent upon failure
  const maxAllowedAmountCents = Math.min(hardCapCents, availableCents);

  const numbers: GuardNumbers = {
    amountCents,
    hardCapCents,
    unanimousAboveCents,
    availableCents,
    remainingAfterCents,
    votesRequired,
    approvals,
    eligibleVoters: eligibleVotersCount,
    vetoActive,
  };

  const suggestions: GuardSuggestions = {
    maxAllowedAmountCents: maxAllowedAmountCents > 0 ? maxAllowedAmountCents : 0,
  };

  return {
    decision,
    executionAllowed,
    reasonCodes,
    checks,
    numbers,
    suggestions,
  };
}
