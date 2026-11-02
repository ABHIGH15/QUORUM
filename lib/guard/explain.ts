/**
 * Quorum Guard Explanation Generator
 * 
 * Generates deterministic, human-readable explanations directly from GuardResult
 * without requiring any LLM call. Powers the UI "Why?" modal.
 */

import { GuardResult } from './types';

export function explainDecision(result: GuardResult): string {
  const { decision, executionAllowed, checks, numbers, suggestions } = result;
  const lines: string[] = [];

  // 1. Header Banner
  switch (decision) {
    case 'APPROVED':
      lines.push(
        executionAllowed
          ? '### ✅ Proposal Approved for Execution'
          : '### ✅ Proposal Approved by Group'
      );
      lines.push('All policy criteria, vendor approvals, and voting thresholds have been met.');
      break;
    case 'VETO_WINDOW_OPEN':
      lines.push('### ⏳ Veto Window Open');
      lines.push(
        `Approval threshold reached (${numbers.approvals}/${numbers.votesRequired} required). Members may cast a veto until the window concludes.`
      );
      break;
    case 'NEEDS_VOTES':
      lines.push('### 🗳️ Awaiting Required Votes');
      lines.push(
        `Current approvals: ${numbers.approvals} of ${numbers.votesRequired} required. (${numbers.eligibleVoters} eligible voters total).`
      );
      break;
    case 'REJECTED_BY_VOTE':
      lines.push('### ❌ Rejected by Member Vote');
      lines.push(
        `Mathematically impossible to reach the required ${numbers.votesRequired} approvals with remaining eligible voters.`
      );
      break;
    case 'VETOED':
      lines.push('### ⛔ Proposal Vetoed');
      lines.push('An eligible member exercised their veto right during the veto window. Proposal is permanently blocked.');
      break;
    case 'BLOCKED':
      lines.push('### 🚫 Blocked by Quorum Guard');
      lines.push('This proposal violates one or more immutable group policy rules or financial constraints.');
      break;
  }

  lines.push('');

  // 2. Financial Summary
  lines.push('**Financial Snapshot:**');
  lines.push(`• Proposed Amount: $${(numbers.amountCents / 100).toFixed(2)} USD`);
  lines.push(`• Group Hard Cap: $${(numbers.hardCapCents / 100).toFixed(2)} USD`);
  lines.push(`• Available Budget: $${(numbers.availableCents / 100).toFixed(2)} USD`);
  if (numbers.amountCents > numbers.unanimousAboveCents) {
    lines.push(`• Unanimity Rule: Amount exceeds $${(numbers.unanimousAboveCents / 100).toFixed(2)} and requires all ${numbers.eligibleVoters} votes.`);
  }
  lines.push('');

  // 3. Failed Checks (if any)
  const failedChecks = checks.filter(c => !c.pass);
  if (failedChecks.length > 0) {
    lines.push('**Failed Policy Checks:**');
    for (const check of failedChecks) {
      lines.push(`- ❌ **${check.code}**: ${check.detail}`);
    }
    lines.push('');
  }

  // 4. Passed Checks
  const passedChecks = checks.filter(c => c.pass);
  if (passedChecks.length > 0) {
    lines.push('**Passed Checks:**');
    for (const check of passedChecks) {
      lines.push(`- ✓ **${check.code}**: ${check.detail}`);
    }
    lines.push('');
  }

  // 5. Suggestions for the Agent / Proposer
  if (decision === 'BLOCKED') {
    lines.push('**Recommended Adjustment:**');
    lines.push(
      `Maximum allowed spending under current policy and available budget is **$${(suggestions.maxAllowedAmountCents / 100).toFixed(2)} USD**.`
    );
  }

  return lines.join('\n');
}
