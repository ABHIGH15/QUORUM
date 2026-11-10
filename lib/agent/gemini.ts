/**
 * Quorum AI Agent - Gemini API Integration (§9.1, §9.4)
 * 
 * Implements real Gemini tool calling using Google Generative Language API
 * with model gemini-3.8-flash (or gemini-flash-latest).
 * 
 * Adheres strictly to:
 * - Deterministic low temperature (0.1)
 * - Structured function calling (tools whitelist)
 * - Quorum Guard PROPOSAL phase enforcement on create_proposal
 * - Logging of all tool calls to agent_runs audit table
 */

import pg from 'pg';
import { AGENT_SYSTEM_PROMPT } from './prompts';
import {
  getGroupState,
  searchOptions,
  compareOptions,
  checkProposal,
  createProposal,
  explainDecision,
  GroupStateResult,
  CreateProposalResult,
} from './tools';
import { CURATED_CATALOG } from './catalog';
import { AgentExecutionStep, AgentRunResult } from './agent';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

export const CANDIDATE_MODELS: string[] = Array.from(
  new Set([
    process.env.GEMINI_MODEL,
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
  ].filter(Boolean) as string[])
);

export class GeminiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiRateLimitError';
  }
}

// Gemini Function Declarations Schema (§9.1)
export const GEMINI_TOOL_DECLARATIONS = [
  {
    name: 'get_group_state',
    description: 'Retrieves the current governance state of the group: active policy rules (budget, hard cap, category restrictions, unanimity threshold), current pool funds, and open proposals.',
    parameters: {
      type: 'OBJECT',
      properties: {
        groupId: { type: 'STRING', description: 'The unique UUID of the group.' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'search_options',
    description: 'Searches the curated catalog of vendor items for a query, category, and optional price ceiling in cents.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: "Search keyword (e.g. 'projector', 'screen', 'speaker')." },
        category: { type: 'STRING', description: "Optional category filter (e.g. 'Electronics', 'Entertainment')." },
        maxPriceCents: { type: 'INTEGER', description: 'Optional maximum price in cents (e.g. 20000 for $200.00).' },
      },
    },
  },
  {
    name: 'compare_options',
    description: 'Compares catalog items against active policy limits, calculating required vote tiers, unanimity requirements, and compliance.',
    parameters: {
      type: 'OBJECT',
      properties: {
        itemIds: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of catalog item IDs to compare.',
        },
      },
      required: ['itemIds'],
    },
  },
  {
    name: 'check_proposal',
    description: 'Dry-runs Quorum Guard on an item without writing to the database. Returns whether Guard will ALLOW or BLOCK, reason codes, required votes, and whether unanimity is needed. Always run before create_proposal.',
    parameters: {
      type: 'OBJECT',
      properties: {
        groupId: { type: 'STRING', description: 'The unique UUID of the group.' },
        itemId: { type: 'STRING', description: "The catalog item ID to check (e.g. 'prod_proj_hd_standard')." },
        rationale: { type: 'STRING', description: 'Optional selection rationale.' },
      },
      required: ['groupId', 'itemId'],
    },
  },
  {
    name: 'create_proposal',
    description: 'Drafts a purchase proposal and immediately runs Quorum Guard in PROPOSAL phase. If Quorum Guard BLOCKS the item, it returns the blocking reason codes and the maximum allowed amount for adaptation. If approved, creates an OPEN proposal for member voting.',
    parameters: {
      type: 'OBJECT',
      properties: {
        groupId: { type: 'STRING', description: 'The unique UUID of the group.' },
        itemId: { type: 'STRING', description: "The catalog item ID (e.g. 'item_lumina_4k_pro' or 'item_optiview_hd')." },
        rationale: { type: 'STRING', description: 'Clear rationale explaining why this item was selected.' },
      },
      required: ['groupId', 'itemId', 'rationale'],
    },
  },
  {
    name: 'explain_decision',
    description: 'Explains a Quorum Guard decision audit record for a given proposal ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        proposalId: { type: 'STRING', description: 'The UUID of the proposal to explain.' },
      },
      required: ['proposalId'],
    },
  },
];

export interface GeminiAgentRunParams {
  pool: pg.Pool;
  groupId: string;
  query: string;
  apiKey: string;
  now?: string;
  model?: string;
}

/**
 * Executes a single Gemini session with real function calling over the REST API
 */
async function executeGeminiSession(params: GeminiAgentRunParams & { model: string }): Promise<AgentRunResult> {
  const { pool, groupId, query, apiKey, now, model } = params;
  const steps: AgentExecutionStep[] = [];
  const loggedToolCalls: any[] = [];
  let stepCount = 0;
  let adaptationOccurred = false;
  let lastBlockedItem: any = null;
  let finalProposedItem: any = null;
  let createdProposalId: string | undefined;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Multi-turn conversation state for Gemini
  const contents: any[] = [
    {
      role: 'user',
      parts: [
        {
          text: `<system_context>\n${AGENT_SYSTEM_PROMPT}\n</system_context>\n\n` +
                `<group_context>\nActive Group ID: "${groupId}"\n</group_context>\n\n` +
                `<user_query>\n${query}\n</user_query>\n\n` +
                `Please research options, check the group policy with get_group_state, compare candidates, and submit a purchase proposal. Remember the Adapt Loop: if Quorum Guard blocks your top choice, check the maxAllowedAmountCents returned by Quorum Guard and search for a compliant alternative.`
        },
      ],
    },
  ];

  const maxTurns = 6;
  let turn = 0;
  let finalMessage = '';

  while (turn < maxTurns) {
    turn++;

    const requestBody = {
      contents,
      tools: [
        {
          function_declarations: GEMINI_TOOL_DECLARATIONS,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429 || errText.includes('RESOURCE_EXHAUSTED')) {
        throw new GeminiRateLimitError(`Gemini free-tier rate limit reached: ${errText}`);
      }
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content) {
      throw new Error('Gemini API returned no candidates or empty content');
    }

    // Add model candidate to conversation history
    contents.push(candidate.content);

    const parts = candidate.content.parts || [];
    const functionCalls = parts.filter((p: any) => p.functionCall);

    if (functionCalls.length === 0) {
      // Model produced text response without function calls
      const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
      finalMessage = textParts.join('\n');
      break;
    }

    // Process each function call in this turn
    const responseParts: any[] = [];

    for (const callPart of functionCalls) {
      const call = callPart.functionCall;
      const fnName = call.name;
      const fnArgs = call.args || {};
      let fnResult: any;

      stepCount++;
      loggedToolCalls.push({ name: fnName, args: fnArgs, timestamp: new Date().toISOString() });

      if (fnName === 'get_group_state') {
        const targetGroupId = fnArgs.groupId || groupId;
        fnResult = await getGroupState(pool, targetGroupId);
        steps.push({
          step: stepCount,
          action: 'EVALUATE',
          detail: `Retrieved group state: Budget $${((fnResult.policy?.budgetCents || 0) / 100).toFixed(2)}, Cap $${((fnResult.policy?.hardCapCents || 0) / 100).toFixed(2)}, Available $${(fnResult.funds.availableCents / 100).toFixed(2)}`,
          data: fnResult,
        });
      } else if (fnName === 'search_options') {
        fnResult = searchOptions({
          query: fnArgs.query,
          category: fnArgs.category,
          maxPriceCents: fnArgs.maxPriceCents,
        });
        const isAdaptation = fnArgs.maxPriceCents && lastBlockedItem;
        steps.push({
          step: stepCount,
          action: isAdaptation ? 'ADAPT' : 'SEARCH',
          detail: isAdaptation
            ? `Adapting to Quorum Guard: re-searching '${fnArgs.query || query}' with max_price = $${((fnArgs.maxPriceCents || 0) / 100).toFixed(2)}. Found ${fnResult.length} compliant items.`
            : `Searched catalog for '${fnArgs.query || query}'. Found ${fnResult.length} items.`,
          data: fnResult.map((i: any) => ({ id: i.id, name: i.name, price: `$${(i.priceCents / 100).toFixed(2)}` })),
        });
      } else if (fnName === 'compare_options') {
        const state = await getGroupState(pool, groupId);
        const items = CURATED_CATALOG.filter((i) => (fnArgs.itemIds || []).includes(i.id));
        if (state.policy) {
          fnResult = compareOptions(items, {
            hardCapCents: state.policy.hardCapCents,
            unanimousAboveCents: state.policy.unanimousAboveCents,
            approvalTiers: state.policy.approvalTiers,
            allowedCategories: state.policy.allowedCategories,
            allowedVendors: state.policy.allowedVendors,
            availableCents: state.funds.availableCents,
            totalEligibleVoters: state.activeMembersCount,
          });
        } else {
          fnResult = { error: 'No active policy found' };
        }
        steps.push({
          step: stepCount,
          action: 'EVALUATE',
          detail: `Compared ${items.length} items against policy rules and thresholds.`,
          data: fnResult,
        });
      } else if (fnName === 'check_proposal') {
        const targetGroupId = fnArgs.groupId || groupId;
        fnResult = await checkProposal({
          pool,
          groupId: targetGroupId,
          itemId: fnArgs.itemId,
          rationale: fnArgs.rationale,
          now,
        });
        steps.push({
          step: stepCount,
          action: 'EVALUATE',
          detail: `Quorum Guard dry-run for ${fnResult.itemName} (${fnResult.priceFormatted}): ${fnResult.guardDecision} (Votes required: ${fnResult.votesRequired}${fnResult.requiresUnanimity ? ' [UNANIMOUS 6/6]' : ' [STANDARD 4/6]'})`,
          data: fnResult,
        });
      } else if (fnName === 'create_proposal') {
        const targetGroupId = fnArgs.groupId || groupId;
        const item = CURATED_CATALOG.find((i) => i.id === fnArgs.itemId);
        fnResult = await createProposal({
          pool,
          groupId: targetGroupId,
          itemId: fnArgs.itemId,
          rationale: fnArgs.rationale,
          now,
        });

        if (!fnResult.success && fnResult.status === 'BLOCKED') {
          adaptationOccurred = true;
          lastBlockedItem = item;
          const alreadyReported = steps.some(
            (s) => s.action === 'PROPOSE_BLOCKED' && s.data?.blockedItemId === fnArgs.itemId
          );
          if (!alreadyReported) {
            steps.push({
              step: stepCount,
              action: 'PROPOSE_BLOCKED',
              detail: `Quorum Guard BLOCKED ${item?.name || fnArgs.itemId} ($${((item?.priceCents || 0) / 100).toFixed(2)}): ${fnResult.guardResult.reasonCodes.join(', ')}. Guard suggestion: max allowed amount is $${((fnResult.adaptationSuggested?.maxAllowedAmountCents || 0) / 100).toFixed(2)}.`,
              data: {
                blockedItemId: fnArgs.itemId,
                proposalId: fnResult.proposalId,
                reasonCodes: fnResult.guardResult.reasonCodes,
                maxAllowedAmountCents: fnResult.adaptationSuggested?.maxAllowedAmountCents,
              },
            });
          }
        } else if (fnResult.success) {
          finalProposedItem = item;
          createdProposalId = fnResult.proposalId;
          steps.push({
            step: stepCount,
            action: 'PROPOSE_SUCCESS',
            detail: `Proposal ${fnResult.proposalId} created successfully for ${item?.name || fnArgs.itemId} ($${((item?.priceCents || 0) / 100).toFixed(2)}). Status: OPEN. Submitted for member voting.`,
            data: {
              proposalId: fnResult.proposalId,
              itemId: fnArgs.itemId,
              amountCents: item?.priceCents,
            },
          });
        }
      } else if (fnName === 'explain_decision') {
        fnResult = await explainDecision(pool, fnArgs.proposalId);
        steps.push({
          step: stepCount,
          action: 'EVALUATE',
          detail: `Explained Quorum Guard decision for proposal ${fnArgs.proposalId}: ${fnResult.decision}`,
          data: fnResult,
        });
      } else {
        fnResult = { error: `Unknown tool: ${fnName}` };
      }

      responseParts.push({
        functionResponse: {
          name: fnName,
          response: { name: fnName, content: fnResult },
        },
      });
    }

    // Append tool execution responses back to conversation
    contents.push({
      role: 'user',
      parts: responseParts,
    });
  }

  // 4. Log agent run to agent_runs table (§14)
  try {
    await pool.query(
      `INSERT INTO agent_runs (group_id, proposal_id, model, tool_calls)
       VALUES ($1, $2, $3, $4)`,
      [groupId, createdProposalId || null, model, JSON.stringify(loggedToolCalls)]
    );
  } catch (err: any) {
    // Ignore logging error if table not yet migrated
  }

  return {
    success: !!createdProposalId,
    userQuery: query,
    finalMessage: finalMessage || (
      finalProposedItem
        ? `I have researched options and submitted a compliant proposal for **${finalProposedItem.name}** ($${(finalProposedItem.priceCents / 100).toFixed(2)}). It is now OPEN for member voting.`
        : `Agent completed analysis.`
    ),
    proposedItem: finalProposedItem && createdProposalId ? {
      id: finalProposedItem.id,
      name: finalProposedItem.name,
      priceCents: finalProposedItem.priceCents,
      proposalId: createdProposalId,
    } : undefined,
    steps,
    adaptationOccurred,
    engine: 'LIVE_GEMINI',
    model,
  };
}

/**
 * Runs the Gemini agent with candidate model fallback and exponential backoff.
 * Tries prioritized models: [GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']
 */
export async function runGeminiAgent(params: GeminiAgentRunParams): Promise<AgentRunResult> {
  const { pool, groupId, query, apiKey, now, model } = params;
  const modelsToTry = model
    ? [model, ...CANDIDATE_MODELS.filter((m) => m !== model)]
    : CANDIDATE_MODELS;

  let lastError: any = null;

  for (const candidateModel of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await executeGeminiSession({
          pool,
          groupId,
          query,
          apiKey,
          now,
          model: candidateModel,
        });
      } catch (err: any) {
        lastError = err;
        const msg = err.message || '';
        const isTransient =
          err.name === 'GeminiRateLimitError' ||
          msg.includes('503') ||
          msg.includes('high demand') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('fetch failed');

        if (isTransient && attempt === 1) {
          console.warn(`[Gemini] Model '${candidateModel}' transient issue (${msg.slice(0, 80)}). Retrying in 1s...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        console.warn(`[Gemini] Model '${candidateModel}' failed (attempt ${attempt}/2): ${msg.slice(0, 100)}. Falling to next candidate model.`);
        break;
      }
    }
  }

  throw lastError || new Error('All Gemini candidate models failed.');
}
