/**
 * Quorum Guard Core Evaluator
 * 
 * Strict Pure Function:
 * - No I/O, no network, no database calls, no LLM
 * - Injected clock (`input.now`) ensures 100% deterministic testing
 * - Single source of truth for spending authorization
 * - Guaranteed: No single voter can authorize an expenditure alone
 * - Fail-closed by default: degenerate inputs (0 voters, null amounts, bad types, unparseable now) are strictly BLOCKED
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

const VALID_PROPOSAL_TYPES = [
  'PURCHASE',
  'POLICY_AMENDMENT',
  'ACCEPT_REDUCED_BUDGET',
  'UNWIND_FUNDING',
];

export function evaluate(input: GuardInput): GuardResult {
  const {
    phase,
    now,
    policy,
    group,
    fundingRound,
    proposal,
    votes,
    eligibleVoters,
    vendor,
    funds,
    existingLivePayment,
  } = input;

  const checks: CheckDetail[] = [];
  const reasonCodes: string[] = [];

  const rawAmount = proposal.amount_cents;
  const isPurchase = proposal.type === 'PURCHASE';
  const isAmendment = proposal.type === 'POLICY_AMENDMENT';
  const isFundingDecision = proposal.type === 'ACCEPT_REDUCED_BUDGET' || proposal.type === 'UNWIND_FUNDING';

  const hardCapCents = policy.hard_cap_cents;
  const unanimousAboveCents = policy.unanimous_above_cents;
  const availableCents = funds.availableCents;
  const eligibleVotersCount = eligibleVoters.length;

  // ---------------------------------------------------------------------------
  // 1. Structural & Fail-Closed Integrity Checks (can cause BLOCKED)
  // ---------------------------------------------------------------------------

  // INVALID_TIMESTAMP (now must be a valid parseable ISO timestamp)
  const nowMs = new Date(now).getTime();
  const isNowValid = !Number.isNaN(nowMs);
  checks.push({
    code: 'INVALID_TIMESTAMP',
    pass: isNowValid,
    detail: isNowValid
      ? `Evaluation timestamp '${now}' is valid`
      : `Unparseable or invalid timestamp '${now}'`,
  });
  if (!isNowValid) reasonCodes.push('INVALID_TIMESTAMP');

  // PROPOSAL_TYPE_INVALID
  const isTypeValid = VALID_PROPOSAL_TYPES.includes(proposal.type);
  checks.push({
    code: 'PROPOSAL_TYPE_INVALID',
    pass: isTypeValid,
    detail: isTypeValid
      ? `Proposal type '${proposal.type}' is valid`
      : `Unknown proposal type '${proposal.type}'; allowed types: [${VALID_PROPOSAL_TYPES.join(', ')}]`,
  });
  if (!isTypeValid) reasonCodes.push('PROPOSAL_TYPE_INVALID');

  // INSUFFICIENT_ELIGIBLE_VOTERS
  // Central Promise: No individual member can authorize alone.
  // Both PURCHASE and POLICY_AMENDMENT require at least 2 eligible voters and >= votes_required.
  let eligibleVotersPass = true;
  let eligibleVotersDetail = `Eligible voters count: ${eligibleVotersCount}`;
  if (isPurchase) {
    eligibleVotersPass = eligibleVotersCount >= 2;
    eligibleVotersDetail = eligibleVotersPass
      ? `Eligible voters count (${eligibleVotersCount}) satisfies purchase minimum (>= 2)`
      : `Insufficient eligible voters (${eligibleVotersCount}). Purchases mandate at least 2 eligible members to prevent unilateral spend`;
  } else if (isAmendment) {
    const minRequiredForAmendment = Math.max(2, policy.amendment_votes_required);
    eligibleVotersPass = eligibleVotersCount >= minRequiredForAmendment;
    eligibleVotersDetail = eligibleVotersPass
      ? `Eligible voters count (${eligibleVotersCount}) satisfies amendment minimum (>= ${minRequiredForAmendment})`
      : `Insufficient eligible voters (${eligibleVotersCount}). Amendments mandate at least ${minRequiredForAmendment} eligible members to prevent unilateral rule rewrite`;
  } else {
    // Funding decision (majority of captured contributors)
    eligibleVotersPass = eligibleVotersCount >= 1;
  }
  checks.push({
    code: 'INSUFFICIENT_ELIGIBLE_VOTERS',
    pass: eligibleVotersPass,
    detail: eligibleVotersDetail,
  });
  if (!eligibleVotersPass) reasonCodes.push('INSUFFICIENT_ELIGIBLE_VOTERS');

  // INVALID_AMOUNT
  let amountValid = true;
  let amountDetail = 'Amount validation not applicable';
  let amountCents = 0;
  if (isPurchase) {
    const isSafePosInt =
      typeof rawAmount === 'number' &&
      Number.isSafeInteger(rawAmount) &&
      rawAmount > 0;
    amountValid = isSafePosInt;
    amountCents = isSafePosInt ? rawAmount : 0;
    amountDetail = isSafePosInt
      ? `Amount $${(amountCents / 100).toFixed(2)} USD is a valid positive integer cents amount`
      : `Invalid purchase amount: ${rawAmount} (must be a positive integer in cents)`;
  } else {
    amountCents = typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) ? rawAmount : 0;
  }
  checks.push({
    code: 'INVALID_AMOUNT',
    pass: amountValid,
    detail: amountDetail,
  });
  if (!amountValid) reasonCodes.push('INVALID_AMOUNT');

  const remainingAfterCents = availableCents - amountCents;

  // GROUP_NOT_ACTIVE
  // Enforces valid lifecycle status from groups.status ('DRAFT','FUNDING','ACTIVE','CLOSING','CLOSED')
  let groupActivePass = false;
  let groupActiveDetail = '';
  if (isFundingDecision) {
    // In production, during partial failure the group is in 'FUNDING'.
    // If group is 'ACTIVE', budget changes MUST go through POLICY_AMENDMENT, not funding unwinds!
    if (group.status === 'ACTIVE') {
      groupActivePass = false;
      groupActiveDetail = 'Funding proposals are forbidden in ACTIVE group status (budget changes require a POLICY_AMENDMENT proposal)';
    } else if (group.status === 'CLOSING' || group.status === 'CLOSED') {
      groupActivePass = false;
      groupActiveDetail = `Group status is '${group.status}'; funding decisions cannot be processed in closing/closed groups`;
    } else {
      groupActivePass = group.status === 'FUNDING';
      groupActiveDetail = groupActivePass
        ? `Group status '${group.status}' permits funding governance proposals`
        : `Group status '${group.status}' cannot process funding decisions (expected: FUNDING)`;
    }
  } else if (isPurchase) {
    groupActivePass = group.status === 'ACTIVE' && (group.mode !== 'POOLED' || funds.fundingReady);
    groupActiveDetail = groupActivePass
      ? `Group ${group.id} is ACTIVE and funding pool is verified`
      : `Group status is '${group.status}' (fundingReady: ${funds.fundingReady})`;
  } else {
    // Policy amendment
    groupActivePass = group.status === 'ACTIVE';
    groupActiveDetail = groupActivePass
      ? `Group ${group.id} is ACTIVE`
      : `Group status is '${group.status}'; amendments require ACTIVE group status`;
  }
  checks.push({
    code: 'GROUP_NOT_ACTIVE',
    pass: groupActivePass,
    detail: groupActiveDetail,
  });
  if (!groupActivePass) reasonCodes.push('GROUP_NOT_ACTIVE');

  // ROUND_NOT_AWAITING_DECISION (Specific to S4 funding decision proposals)
  let roundStatusPass = true;
  let roundStatusDetail = 'Round status check not applicable';
  if (isFundingDecision) {
    roundStatusPass = fundingRound?.status === 'AWAITING_GROUP_DECISION';
    roundStatusDetail = roundStatusPass
      ? `Funding round is in 'AWAITING_GROUP_DECISION'`
      : `Funding round status is '${fundingRound?.status ?? 'none'}'; expected 'AWAITING_GROUP_DECISION'`;
  }
  checks.push({
    code: 'ROUND_NOT_AWAITING_DECISION',
    pass: roundStatusPass,
    detail: roundStatusDetail,
  });
  if (!roundStatusPass) reasonCodes.push('ROUND_NOT_AWAITING_DECISION');

  // PROPOSAL_EXPIRED
  const isExpired = Boolean(
    isNowValid &&
    proposal.voting_deadline &&
    nowMs > new Date(proposal.voting_deadline).getTime() &&
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
  if (isPurchase) {
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
  if (isPurchase) {
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
  if (isPurchase) {
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
  if (isPurchase) {
    hardCapPass = amountValid && amountCents <= hardCapCents;
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
  if (isPurchase) {
    budgetPass = amountValid && amountCents <= availableCents;
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
  let fundingReadyDetail = 'Funding ready check not applicable';
  if (isPurchase && group.mode === 'POOLED') {
    fundingReadyPass = funds.fundingReady === true;
    fundingReadyDetail = fundingReadyPass
      ? `Funding pool ready status: ${funds.fundingReady}`
      : `Pooled mode purchases require funded pool; current status is not ready`;
  }
  checks.push({
    code: 'FUNDING_NOT_READY',
    pass: fundingReadyPass,
    detail: fundingReadyDetail,
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
  // 2. Voting Threshold & Vote Processing
  // ---------------------------------------------------------------------------

  let votesRequired: number;
  if (isPurchase) {
    if (!amountValid || amountCents <= 0) {
      votesRequired = Math.max(2, eligibleVotersCount);
    } else if (amountCents > unanimousAboveCents) {
      // Unanimity override: mandates all eligible voters (at least 2)
      votesRequired = Math.max(2, eligibleVotersCount);
    } else {
      // Tier lookup: find first tier whose max_cents >= amountCents
      const matchingTier = policy.approval_tiers.find(t => amountCents <= t.max_cents);
      if (matchingTier) {
        votesRequired = Math.max(2, matchingTier.votes_required);
      } else {
        // Fallback: If amount fits no tier, fail safe to requiring all eligible voters
        votesRequired = Math.max(2, eligibleVotersCount);
      }
    }
  } else if (isAmendment) {
    // Amendments rewrite group policy: floor of at least 2 votes to prevent unilateral change
    votesRequired = Math.max(2, policy.amendment_votes_required);
  } else if (isFundingDecision) {
    // Majority of eligible contributors
    votesRequired = Math.max(1, Math.floor(eligibleVotersCount / 2) + 1);
  } else {
    // Unknown proposal type: mandate all eligible voters (blocked anyway)
    votesRequired = Math.max(2, eligibleVotersCount);
  }

  // ---------------------------------------------------------------------------
  // Vote Deduplication & Strict Proposal Filtering
  // Invariants:
  // - Votes must belong to this specific proposal (`vote.proposal_id === proposal.id`).
  // - Only voters in `eligibleVoters` are recognized.
  // - Duplicates from same member are deduplicated (deterministic latest vote).
  // - Veto is tracked as a separate act, also restricted to eligibleVoters.
  // ---------------------------------------------------------------------------

  const memberVotesMap = new Map<string, Vote>();
  const memberVetoesMap = new Map<string, Vote>();

  // Deterministic sorting comparator: created_at -> sequence_num -> deterministic tie-break
  const sortedVotes = [...votes].sort((a, b) => {
    const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    const seqA = a.sequence_num ?? 0;
    const seqB = b.sequence_num ?? 0;
    if (seqA !== seqB) return seqA - seqB;
    const idA = a.id ?? `${a.proposal_id}_${a.member_id}_${a.kind}_${a.choice}`;
    const idB = b.id ?? `${b.proposal_id}_${b.member_id}_${b.kind}_${b.choice}`;
    return idA.localeCompare(idB);
  });

  for (const vote of sortedVotes) {
    if (vote.proposal_id !== proposal.id) {
      continue;
    }

    if (!eligibleVoters.includes(vote.member_id)) {
      continue;
    }

    if (vote.kind === 'VETO' || vote.choice === 'VETO') {
      memberVetoesMap.set(vote.member_id, vote);
    } else if (vote.kind === 'VOTE') {
      memberVotesMap.set(vote.member_id, vote);
    }
  }

  const latestVotes = Array.from(memberVotesMap.values());
  const approvals = latestVotes.filter(v => v.choice === 'APPROVE').length;
  const rejections = latestVotes.filter(v => v.choice === 'REJECT').length;
  const votesCast = latestVotes.length;
  const unvotedEligible = Math.max(0, eligibleVotersCount - votesCast);

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
    if (policy.veto_window_minutes > 0) {
      if (!proposal.veto_ends_at) {
        vetoWindowEnded = false;
        vetoWindowDetail = `Veto window is required (${policy.veto_window_minutes}m) but proposal.veto_ends_at has not been set`;
      } else if (!isNowValid) {
        vetoWindowEnded = false;
        vetoWindowDetail = 'Cannot compute veto window: evaluation timestamp is invalid';
      } else {
        const vetoEndMs = new Date(proposal.veto_ends_at).getTime();
        vetoWindowEnded = nowMs >= vetoEndMs;
        vetoWindowDetail = vetoWindowEnded
          ? `Veto window closed at ${proposal.veto_ends_at} (current time: ${now})`
          : `Veto window is open until ${proposal.veto_ends_at} (current time: ${now})`;
      }
    } else {
      vetoWindowEnded = true;
      vetoWindowDetail = 'Policy veto window is 0 minutes';
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
    'INVALID_TIMESTAMP',
    'PROPOSAL_TYPE_INVALID',
    'INSUFFICIENT_ELIGIBLE_VOTERS',
    'INVALID_AMOUNT',
    'GROUP_NOT_ACTIVE',
    'ROUND_NOT_AWAITING_DECISION',
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
