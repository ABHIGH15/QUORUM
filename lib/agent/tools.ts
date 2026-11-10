/**
 * Quorum AI Agent Tools Whitelist (§9.1)
 * 
 * Invariants:
 * 1. Strict tool whitelist: Agent can only research and propose.
 * 2. Agent CANNOT vote, veto, activate policies, or execute payments (§3.2 I2).
 * 3. Adapt Loop: create_proposal immediately triggers Quorum Guard in PROPOSAL phase
 *    and returns Guard suggestions (e.g. maxAllowedAmountCents) to guide adaptation.
 */

import pg from 'pg';
import { CURATED_CATALOG, CatalogItem } from './catalog';
import { evaluate } from '../guard/evaluate';
import { GuardInput, GuardResult } from '../guard/types';
import { parseCharterToPolicy } from '../policy/validator';

export interface GroupStateResult {
  group: {
    id: string;
    name: string;
    mode: string;
    status: string;
  };
  policy?: {
    version: number;
    budgetCents: number;
    hardCapCents: number;
    unanimousAboveCents: number;
    approvalTiers: Array<{ max_cents: number; votes_required: number }>;
    vetoWindowMinutes: number;
    allowedCategories: string[];
    allowedVendors: string[];
  };
  funds: {
    availableCents: number;
    reservedCents: number;
  };
  activeMembersCount: number;
  activeProposals: Array<{
    id: string;
    type: string;
    status: string;
    amountCents: number;
    vendorId?: string;
  }>;
  vetoedCatalogItemIds: string[];
}

/**
 * Tool 1: get_group_state
 */
export async function getGroupState(pool: pg.Pool, groupId: string): Promise<GroupStateResult> {
  const groupRes = await pool.query(
    `SELECT id, name, mode, status FROM groups WHERE id = $1`,
    [groupId]
  );
  if (groupRes.rows.length === 0) {
    throw new Error(`Group '${groupId}' not found`);
  }
  const group = groupRes.rows[0];

  const policyRes = await pool.query(
    `SELECT policy, version FROM policies WHERE group_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
    [groupId]
  );
  let policy = undefined;
  if (policyRes.rows.length > 0) {
    const rawPolicy = policyRes.rows[0].policy;
    policy = {
      version: policyRes.rows[0].version,
      budgetCents: rawPolicy.budget_cents,
      hardCapCents: rawPolicy.hard_cap_cents,
      unanimousAboveCents: rawPolicy.unanimous_above_cents,
      approvalTiers: rawPolicy.approval_tiers,
      vetoWindowMinutes: rawPolicy.veto_window_minutes,
      allowedCategories: rawPolicy.categories_allowed,
      allowedVendors: rawPolicy.vendors?.allowlist_vendor_ids || [],
    };
  }

  const ledgerRes = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_REFUNDED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
       COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
     FROM ledger_events WHERE group_id = $1`,
    [groupId]
  );
  const l = ledgerRes.rows[0];
  const netReserved = Math.max(0, parseInt(l.reserved, 10) - parseInt(l.released, 10));
  const availableCents = parseInt(l.captured, 10) - parseInt(l.refunded, 10) - parseInt(l.paid, 10) - netReserved;

  const membersRes = await pool.query(
    `SELECT COUNT(*)::int as count FROM memberships WHERE group_id = $1 AND status = 'ACTIVE'`,
    [groupId]
  );
  const activeMembersCount = membersRes.rows[0]?.count || 0;

  const allProposalsRes = await pool.query(
    `SELECT id, type, status, amount_cents, vendor_id, payload FROM proposals 
     WHERE group_id = $1
     ORDER BY created_at DESC`,
    [groupId]
  );
  const activeProposals = allProposalsRes.rows
    .filter((r) => !['REJECTED', 'VETOED', 'BLOCKED', 'CANCELLED', 'EXPIRED'].includes(r.status))
    .map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      amountCents: r.amount_cents,
      vendorId: r.vendor_id,
    }));

  const vetoedProposals = allProposalsRes.rows.filter((r) => r.status === 'VETOED');
  const vetoedCatalogItemIds: string[] = vetoedProposals
    .map((r) => {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
      return p.catalog_item_id || p.itemId;
    })
    .filter(Boolean);

  return {
    group,
    policy,
    funds: {
      availableCents,
      reservedCents: netReserved,
    },
    activeMembersCount,
    activeProposals,
    vetoedCatalogItemIds,
  };
}

/**
 * Tool 2: parse_charter
 */
export function parseCharter(charterText: string) {
  return parseCharterToPolicy(charterText);
}

/**
 * Tool 3: search_options
 */
export function searchOptions(params: {
  query?: string;
  category?: string;
  maxPriceCents?: number;
}): CatalogItem[] {
  const { query, category, maxPriceCents } = params;
  let items = [...CURATED_CATALOG];

  if (query) {
    const q = query.toLowerCase();
    let matches = items.filter(
      (item) => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    );
    // If exact sentence not found, match significant product keywords
    if (matches.length === 0) {
      const stopWords = new Set([
        'i', 'want', 'to', 'buy', 'a', 'an', 'the', 'for', 'our', 'in', 'on',
        'at', 'we', 'need', 'get', 'purchasing', 'purchase', 'group', 'movie', 'nights', 'night'
      ]);
      const words = q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 2 && !stopWords.has(w));
      if (words.length > 0) {
        matches = items.filter((item) => {
          const itemText = (item.name + ' ' + item.description).toLowerCase();
          return words.some((word) => itemText.includes(word));
        });
      }
    }
    items = matches;
  }

  if (category) {
    items = items.filter((item) => item.category.toLowerCase() === category.toLowerCase());
  }

  if (typeof maxPriceCents === 'number' && maxPriceCents > 0) {
    items = items.filter((item) => item.priceCents <= maxPriceCents);
  }

  return items;
}

export interface OptionComparison {
  item: CatalogItem;
  compliantWithCap: boolean;
  compliantWithVendor: boolean;
  compliantWithCategory: boolean;
  requiredVotes: number;
  votesRequired: number; // §1a: explicitly exposed votesRequired
  requiresUnanimity: boolean;
  withinBudget: boolean;
  guardPrediction: 'LIKELY_APPROVED' | 'LIKELY_BLOCKED';
  notes: string[];
}

/**
 * Tool 4: compare_options
 */
export function compareOptions(
  items: CatalogItem[],
  policy: {
    hardCapCents: number;
    unanimousAboveCents: number;
    approvalTiers: Array<{ max_cents: number; votes_required: number }>;
    allowedCategories: string[];
    allowedVendors: string[];
    availableCents: number;
    totalEligibleVoters: number;
  }
): OptionComparison[] {
  return items.map((item) => {
    const notes: string[] = [];
    const compliantWithCap = item.priceCents <= policy.hardCapCents;
    if (!compliantWithCap) {
      notes.push(`Exceeds hard cap of $${(policy.hardCapCents / 100).toFixed(2)}`);
    }

    const compliantWithVendor = policy.allowedVendors.includes(item.vendorId);
    if (!compliantWithVendor) {
      notes.push(`Vendor '${item.vendorName}' is not in approved allowlist`);
    }

    const compliantWithCategory = policy.allowedCategories.includes(item.category);
    if (!compliantWithCategory) {
      notes.push(`Category '${item.category}' is not allowed by policy`);
    }

    const withinBudget = item.priceCents <= policy.availableCents;
    if (!withinBudget) {
      notes.push(`Exceeds available group balance of $${(policy.availableCents / 100).toFixed(2)}`);
    }

    let requiredVotes = policy.totalEligibleVoters;
    let requiresUnanimity = false;
    if (item.priceCents > policy.unanimousAboveCents) {
      requiredVotes = policy.totalEligibleVoters;
      requiresUnanimity = true;
      notes.push(`Above $${(policy.unanimousAboveCents / 100).toFixed(2)}: requires unanimous consent (${requiredVotes}/${policy.totalEligibleVoters} votes)`);
    } else {
      const tiers = policy.approvalTiers || (policy as any).approval_tiers || [];
      const tier = tiers.find((t: any) => item.priceCents <= t.max_cents);
      if (tier) {
        requiredVotes = tier.votes_required;
      }
      notes.push(`Standard tier: requires ${requiredVotes}/${policy.totalEligibleVoters} votes`);
    }

    const isCompliant = compliantWithCap && compliantWithVendor && compliantWithCategory && withinBudget;

    return {
      item,
      compliantWithCap,
      compliantWithVendor,
      compliantWithCategory,
      requiredVotes,
      votesRequired: requiredVotes,
      requiresUnanimity,
      withinBudget,
      guardPrediction: isCompliant ? 'LIKELY_APPROVED' : 'LIKELY_BLOCKED',
      notes,
    };
  });
}

export interface CheckProposalParams {
  pool: pg.Pool;
  groupId: string;
  itemId: string;
  rationale?: string;
  now?: string;
}

export interface CheckProposalResult {
  itemId: string;
  itemName: string;
  priceCents: number;
  priceFormatted: string;
  guardDecision: 'ALLOWED' | 'BLOCKED';
  votesRequired: number;
  requiresUnanimity: boolean;
  reasonCodes: string[];
  maxAllowedAmountCents?: number;
  notes: string[];
}

/**
 * Tool: check_proposal (§1a Dry-Run Guard Check)
 * Performs a dry-run check of an item against Quorum Guard WITHOUT writing to the database.
 */
export async function checkProposal(params: CheckProposalParams): Promise<CheckProposalResult> {
  const { pool, groupId, itemId, rationale = 'Dry run policy check', now } = params;
  const nowIso = now || new Date().toISOString();

  const item = CURATED_CATALOG.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`Catalog item '${itemId}' not found in curated catalog`);
  }

  const policyRes = await pool.query(
    `SELECT policy, version FROM policies WHERE group_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
    [groupId]
  );
  if (policyRes.rows.length === 0) {
    throw new Error(`Active policy not found for group '${groupId}'`);
  }
  const policyData = policyRes.rows[0].policy;
  const policyVersion = policyRes.rows[0].version;

  const groupRes = await pool.query(
    `SELECT id, mode, status FROM groups WHERE id = $1`,
    [groupId]
  );
  const groupRow = groupRes.rows[0];

  const ledgerRes = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_REFUNDED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
       COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
     FROM ledger_events WHERE group_id = $1`,
    [groupId]
  );
  const l = ledgerRes.rows[0];
  const netReserved = Math.max(0, parseInt(l.reserved, 10) - parseInt(l.released, 10));
  const availableCents = parseInt(l.captured, 10) - parseInt(l.refunded, 10) - parseInt(l.paid, 10) - netReserved;

  const membersRes = await pool.query(
    `SELECT DISTINCT m.id 
     FROM memberships m
     LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'CAPTURED'
     LEFT JOIN ledger_events le ON le.actor_id = m.id AND le.group_id = $1 AND le.type = 'CONTRIBUTION_CAPTURED'
     WHERE m.group_id = $1 AND m.status = 'ACTIVE' AND (c.id IS NOT NULL OR le.id IS NOT NULL)`,
    [groupId]
  );
  const eligibleVoters = membersRes.rows.map((r) => r.id);

  const vendorRes = await pool.query(
    `SELECT id, name, paypal_email, category, verified, source FROM vendors WHERE id = $1`,
    [item.vendorId]
  );
  const vendorData = vendorRes.rows[0];

  const guardInput: GuardInput = {
    phase: 'PROPOSAL',
    now: nowIso,
    policy: policyData,
    group: {
      id: groupRow.id,
      mode: groupRow.mode,
      status: groupRow.status,
    },
    proposal: {
      id: 'dry_run_check',
      group_id: groupId,
      type: 'PURCHASE',
      status: 'DRAFT',
      created_by_kind: 'AGENT',
      policy_version: policyVersion,
      vendor_id: item.vendorId,
      category: item.category,
      amount_cents: item.priceCents,
      payload: { catalog_item_id: item.id, item_name: item.name, rationale },
      voting_deadline: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    },
    votes: [],
    eligibleVoters,
    vendor: vendorData,
    funds: {
      availableCents,
      reservedCents: netReserved,
      fundingReady: groupRow.status === 'ACTIVE',
    },
    existingLivePayment: false,
  };

  const guardResult = evaluate(guardInput);

  const unanimousAbove = policyData.unanimous_above_cents ?? policyData.unanimousAboveCents ?? Infinity;
  const tiers = policyData.approval_tiers || policyData.approvalTiers || [];
  let votesRequired = eligibleVoters.length;
  let requiresUnanimity = false;
  const notes: string[] = [];

  if (item.priceCents > unanimousAbove) {
    requiresUnanimity = true;
    votesRequired = eligibleVoters.length;
    notes.push(`Mandates 100% unanimity (${votesRequired}/${eligibleVoters.length} active members)`);
  } else {
    const tier = tiers.find((t: any) => item.priceCents <= t.max_cents);
    if (tier) {
      votesRequired = tier.votes_required;
    }
    notes.push(`Standard approval tier: requires ${votesRequired}/${eligibleVoters.length} votes`);
  }

  if (guardResult.decision === 'BLOCKED') {
    notes.push(`Guard BLOCKS item: ${guardResult.reasonCodes.join(', ')}`);
  }

  return {
    itemId: item.id,
    itemName: item.name,
    priceCents: item.priceCents,
    priceFormatted: `$${(item.priceCents / 100).toFixed(2)}`,
    guardDecision: guardResult.decision === 'BLOCKED' ? 'BLOCKED' : 'ALLOWED',
    votesRequired,
    requiresUnanimity,
    reasonCodes: guardResult.reasonCodes,
    maxAllowedAmountCents: guardResult.suggestions?.maxAllowedAmountCents,
    notes,
  };
}

export interface CreateProposalParams {
  pool: pg.Pool;
  groupId: string;
  itemId: string;
  rationale: string;
  votingDeadlineHours?: number;
  now?: string;
}

export interface CreateProposalResult {
  success: boolean;
  proposalId: string;
  status: string;
  guardResult: GuardResult;
  adaptationSuggested?: {
    blocked: boolean;
    reasonCodes: string[];
    maxAllowedAmountCents?: number;
  };
}

/**
 * Tool 5: create_proposal
 * Submits proposal in DRAFT or OPEN status and evaluates Quorum Guard in PROPOSAL phase.
 * Feeds back Guard suggestions to drive the Adapt Loop.
 */
export async function createProposal(params: CreateProposalParams): Promise<CreateProposalResult> {
  const { pool, groupId, itemId, rationale, votingDeadlineHours = 72, now } = params;
  const nowIso = now || new Date().toISOString();

  // 1. Look up item from curated catalog
  const item = CURATED_CATALOG.find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`Catalog item '${itemId}' not found in curated catalog`);
  }

  // 2. Fetch Active Policy
  const policyRes = await pool.query(
    `SELECT policy, version FROM policies WHERE group_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
    [groupId]
  );
  if (policyRes.rows.length === 0) {
    throw new Error(`Active policy not found for group '${groupId}'`);
  }
  const policyData = policyRes.rows[0].policy;
  const policyVersion = policyRes.rows[0].version;

  // 3. Query Group
  const groupRes = await pool.query(
    `SELECT id, mode, status FROM groups WHERE id = $1`,
    [groupId]
  );
  const groupRow = groupRes.rows[0];

  // 4. Query Available Funds
  const ledgerRes = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_CAPTURED' THEN amount_cents ELSE 0 END), 0)::bigint as captured,
       COALESCE(SUM(CASE WHEN type = 'CONTRIBUTION_REFUNDED' THEN amount_cents ELSE 0 END), 0)::bigint as refunded,
       COALESCE(SUM(CASE WHEN type = 'PAYOUT_SUCCEEDED' THEN amount_cents ELSE 0 END), 0)::bigint as paid,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RESERVED' THEN amount_cents ELSE 0 END), 0)::bigint as reserved,
       COALESCE(SUM(CASE WHEN type = 'FUNDS_RELEASED' THEN amount_cents ELSE 0 END), 0)::bigint as released
     FROM ledger_events WHERE group_id = $1`,
    [groupId]
  );
  const l = ledgerRes.rows[0];
  const netReserved = Math.max(0, parseInt(l.reserved, 10) - parseInt(l.released, 10));
  const availableCents = parseInt(l.captured, 10) - parseInt(l.refunded, 10) - parseInt(l.paid, 10) - netReserved;

  // 5. Query Eligible Voters
  const membersRes = await pool.query(
    `SELECT DISTINCT m.id 
     FROM memberships m
     LEFT JOIN contributions c ON c.member_id = m.id AND c.status = 'CAPTURED'
     LEFT JOIN ledger_events le ON le.actor_id = m.id AND le.group_id = $1 AND le.type = 'CONTRIBUTION_CAPTURED'
     WHERE m.group_id = $1 AND m.status = 'ACTIVE' AND (c.id IS NOT NULL OR le.id IS NOT NULL)`,
    [groupId]
  );
  const eligibleVoters = membersRes.rows.map((r) => r.id);

  // 6. Query Vendor
  const vendorRes = await pool.query(
    `SELECT id, name, paypal_email, category, verified, source FROM vendors WHERE id = $1`,
    [item.vendorId]
  );
  const vendorData = vendorRes.rows[0];

  // 7. Compute Voting Deadline & Veto Window
  const votingDeadline = new Date(new Date(nowIso).getTime() + votingDeadlineHours * 3600 * 1000).toISOString();

  // 8. Run Quorum Guard in PROPOSAL Phase BEFORE inserting
  const guardInput: GuardInput = {
    phase: 'PROPOSAL',
    now: nowIso,
    policy: policyData,
    group: {
      id: groupRow.id,
      mode: groupRow.mode,
      status: groupRow.status,
    },
    proposal: {
      id: 'draft_preview',
      group_id: groupId,
      type: 'PURCHASE',
      status: 'DRAFT',
      created_by_kind: 'AGENT',
      policy_version: policyVersion,
      vendor_id: item.vendorId,
      category: item.category,
      amount_cents: item.priceCents,
      payload: { catalog_item_id: item.id, item_name: item.name, rationale },
      voting_deadline: votingDeadline,
    },
    votes: [],
    eligibleVoters,
    vendor: vendorData,
    funds: {
      availableCents,
      reservedCents: netReserved,
      fundingReady: groupRow.status === 'ACTIVE',
    },
    existingLivePayment: false,
  };

  const guardResult = evaluate(guardInput);

  // 9. If Guard BLOCKS proposal in PROPOSAL phase, record visible BLOCKED proposal & decision audit row
  if (guardResult.decision === 'BLOCKED') {
    // Deduplication (§1c): Check if this item has already been proposed and recorded as BLOCKED in this group
    const existingBlockedRes = await pool.query(
      `SELECT id FROM proposals 
       WHERE group_id = $1 AND status = 'BLOCKED' AND (
         payload::text LIKE $2 OR payload::text LIKE $3
       ) LIMIT 1`,
      [groupId, `%"catalog_item_id":"${item.id}"%`, `%"itemId":"${item.id}"%`]
    );

    let blockedProposalId: string;
    if (existingBlockedRes.rows.length > 0) {
      blockedProposalId = existingBlockedRes.rows[0].id;
    } else {
      const insertBlockedRes = await pool.query(
        `INSERT INTO proposals (
          group_id, type, status, created_by_kind, policy_version,
          vendor_id, category, amount_cents, payload, voting_deadline
         ) VALUES (
          $1, 'PURCHASE', 'BLOCKED', 'AGENT', $2,
          $3, $4, $5, $6, $7
         ) RETURNING id`,
        [
          groupId,
          policyVersion,
          item.vendorId,
          item.category,
          item.priceCents,
          JSON.stringify({ catalog_item_id: item.id, item_name: item.name, rationale }),
          votingDeadline,
        ]
      );
      blockedProposalId = insertBlockedRes.rows[0].id;

      await pool.query(
        `INSERT INTO guard_decisions (proposal_id, phase, policy_version, input_snapshot, result, decision)
         VALUES ($1, 'PROPOSAL', $2, $3, $4, $5)`,
        [blockedProposalId, policyVersion, JSON.stringify(guardInput), JSON.stringify(guardResult), guardResult.decision]
      );
    }

    return {
      success: false,
      proposalId: blockedProposalId,
      status: 'BLOCKED',
      guardResult,
      adaptationSuggested: {
        blocked: true,
        reasonCodes: guardResult.reasonCodes,
        maxAllowedAmountCents: guardResult.suggestions.maxAllowedAmountCents,
      },
    };
  }

  // 10. Guard allows proposal: Insert proposal into database as OPEN
  const insertPropRes = await pool.query(
    `INSERT INTO proposals (
      group_id, type, status, created_by_kind, policy_version,
      vendor_id, category, amount_cents, payload, voting_deadline
     ) VALUES (
      $1, 'PURCHASE', 'OPEN', 'AGENT', $2,
      $3, $4, $5, $6, $7
     ) RETURNING id`,
    [
      groupId,
      policyVersion,
      item.vendorId,
      item.category,
      item.priceCents,
      JSON.stringify({ catalog_item_id: item.id, item_name: item.name, rationale }),
      votingDeadline,
    ]
  );
  const newProposalId = insertPropRes.rows[0].id;

  // Insert Guard decision audit row
  await pool.query(
    `INSERT INTO guard_decisions (proposal_id, phase, policy_version, input_snapshot, result, decision)
     VALUES ($1, 'PROPOSAL', $2, $3, $4, $5)`,
    [newProposalId, policyVersion, JSON.stringify(guardInput), JSON.stringify(guardResult), guardResult.decision]
  );

  return {
    success: true,
    proposalId: newProposalId,
    status: 'OPEN',
    guardResult,
  };
}

/**
 * Tool 6: explain_decision
 */
export async function explainDecision(pool: pg.Pool, proposalId: string) {
  const decisionRes = await pool.query(
    `SELECT phase, policy_version, result, decision, created_at 
     FROM guard_decisions 
     WHERE proposal_id = $1 
     ORDER BY created_at DESC LIMIT 1`,
    [proposalId]
  );

  if (decisionRes.rows.length === 0) {
    return {
      proposalId,
      found: false,
      message: 'No Guard evaluation recorded yet for this proposal.',
    };
  }

  const latest = decisionRes.rows[0];
  const result: GuardResult = latest.result;

  return {
    proposalId,
    found: true,
    phase: latest.phase,
    decision: latest.decision,
    evaluatedAt: latest.created_at,
    reasonCodes: result.reasonCodes,
    checks: result.checks,
    numbers: result.numbers,
    suggestions: result.suggestions,
  };
}
