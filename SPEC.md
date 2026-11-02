# Quorum: Functional Specification

**Version 1.1 · Oct 31, 2026**  
**Target:** PayPal AI Hackathon, submission deadline Thu Nov 12, 2026, 12:00 pm PT.

> *AI researches and proposes. The group decides. Quorum Guard enforces. PayPal moves the money.*

---

## 0. How to use this document

- This file is the single source of truth for all planning, testing, and development. Restate the invariants in section 3.2 in every major execution prompt.
- Build strictly in the order of section 16. **Do not build UI polish before Quorum Guard, the funding state machine, and the payment adapter pass their automated tests.**
- Money is represented strictly as **integer cents, USD only**. Never use floating-point numbers for money.
- Items marked **VERIFY** must be confirmed against PayPal sandbox or platform docs.
- Everything runs against the **PayPal sandbox**. Never use live credentials.

---

## 1. Product

### 1.1 One-liner
A group purchasing agent governed by the group's own rules. The AI researches options within group policy, members vote and veto, a deterministic rules engine (Quorum Guard) decides whether a purchase may execute, and PayPal processes the payment.

### 1.2 The promise (use exactly this wording)
> **No individual member can independently authorize a purchase through Quorum. Every expenditure must satisfy the group's agreed policy and approval requirements.**

### 1.3 What we do NOT claim
- Not escrow, not legally segregated banking funds, not a jointly owned PayPal wallet, not "trustless" Web3.
- In Pooled mode, pooled funds sit in the PayPal sandbox business account that Quorum's integration controls. A production version would require a licensed custodian or a formal PayPal-held platform balance model. State this prominently in the README.
- **Geographic availability:** The demo runs on US sandbox accounts. PayPal Payouts availability depends on the sender business account's registered country. State this honestly in documentation.

### 1.4 Target Audience
Student organizations, hackathon teams, and small event committees (shared budget, multiple approvers, frequent purchase decisions).

### 1.5 Non-goals (cut list)
Multi-currency, recurring treasuries/subscriptions, multi-agent mesh architectures, native mobile app, real money/production KYC, member exit after contribution capture, agent-discovered unknown vendors (stretch only), physical shipment/inventory tracking.

---

## 2. Execution modes

`groups.mode` is set at group creation and is immutable after the first funding round begins. In UI copy and documentation, use **"Pooled mode"** and **"Direct mode"** (never "Mode A" / "Mode B").

| Dimension | **Pooled mode (Primary)** | **Direct mode (Fallback / Alternative)** |
|---|---|---|
| **Member Contributions** | Authorized, then captured into Quorum sandbox business account | Tracked as authorized commitments only; no pooled platform balance claimed |
| **Vendor Payment** | PayPal Payouts (`POST /v1/payments/payouts`) from pooled balance to vendor sandbox account | One designated member completes PayPal checkout (Orders v2 with `payee = vendor`) after Guard approval |
| **Guard Balance Check** | `available_cents = captured - refunded - paid - reserved` | `budget_remaining = budget_cents - paid_orders - reserved` |
| **UI Banner** | None | *"Direct purchase mode: Quorum is not holding funds."* |
| **PayPal API Required** | Orders v2 + Payments v2 + Payouts API | Orders v2 + Payments v2 (No Payouts API required) |

### 2.1 Common Core & Architectural Boundaries
Both modes share governance and deterministic policy enforcement:
1. Exact same group charter & policy schema.
2. Identical proposal creation, agent adapt loop, voting, and veto windows.
3. Identical Quorum Guard rules, decision precedence, and append-only ledger.

**Key Distinction:**
- **Pooled mode (Primary):** Member contributions are authorized, then captured into the Quorum platform sandbox business account. PayPal Payouts pays the vendor from pooled balance. The funding round state machine manages pool health and partial failures.
- **Direct mode (Fallback):** Member commitments are tracked as policy limits only; Quorum never holds or captures pooled money. One designated purchaser completes a standard PayPal checkout directly with the vendor (`payee = vendor`) after Guard approval. Guard checks spend against `budget_remaining = budget_cents - paid_checkout - reserved`.

The Day-1 test of sandbox Payouts decides which mode the demo group runs in. The funding round code (authorize, capture, void, refund) is built either way on Nov 3–4, as Pooled is the primary product promise and contribution processing does not require Payouts access.

---

## 3. Architecture

### 3.1 Module boundaries

```
           +-----------------------------------------------+
           |              Next.js 14 Web UI                |
           |  Workspace • Ledger (AG Grid) • "Why?" Panel   |
           +-----------------------+-----------------------+
                                   | HTTP / Server Actions
                                   v
           +-----------------------------------------------+
           |              API & Application Layer          |
           |   Auth (Demo Switcher) • Proposals • Votes    |
           +----------+-----------------------+------------+
                      |                       |
                      v                       v
      +-----------------------------+   +----------------------------+
      |      Agent Service (LLM)    |   |      Approval Service      |
      | parse_charter, search,      |   | proposals, votes, vetoes,  |
      | compare, propose, explain   |   | policy amendments          |
      +---------------+-------------+   +--------------+-------------+
                      |                                |
                      +--------------->+<--------------+
                                       |
                                       v
                    +-------------------------------------+
                    |            QUORUM GUARD             |
                    |  (Pure function, zero I/O, no LLM)  |
                    +------------------+------------------+
                                       |
                                       v
                    +-------------------------------------+
                    |           Payment Service           |
                    | (Direct Postgres row-lock & check)  |
                    +------------------+------------------+
                                       |
                        +--------------+--------------+
                        |                             |
                        v                             v
           [PayoutAdapter (Pooled)]      [CheckoutAdapter (Direct)]
                        |                             |
                        +--------------+--------------+
                                       |
                                       v
                         +---------------------------+
                         |    PayPal Sandbox APIs    |
                         +-------------+-------------+
                                       |
                                       v
       +---------------------------------------------------------------+
       | Webhook Handler (`verify-webhook-signature`) & `tick(groupId)` |
       +-------------------------------+-------------------------------+
                                       |
                                       v
       +---------------------------------------------------------------+
       |             Append-Only Ledger (PostgreSQL Triggers)          |
       +---------------------------------------------------------------+
```

### 3.2 Invariants (non-negotiable)

- **I1.** The LLM never decides whether money moves. Quorum Guard is a pure deterministic TypeScript function.
- **I2.** The agent has **no** payment tools, no vote tool, no policy-edit tool, and no access to PayPal API secrets.
- **I3.** The Payment service re-runs Guard in the `EXECUTION` phase inside a direct PostgreSQL transaction with a group row lock (`SELECT ... FOR UPDATE`), immediately before issuing any PayPal call. Prior approval in `VOTING` phase is never sufficient on its own.
- **I4.** Every external PayPal write call carries a deterministic idempotency key. The **database** is the primary source of truth for idempotency; PayPal request ID deduplication is a defensive secondary layer.
- **I5.** Ledger events, recorded votes, and Guard evaluation decisions are strictly append-only. Updates and deletes are blocked by PostgreSQL database triggers.
- **I6.** Webhooks are cryptographically verified and deduplicated by PayPal event ID. Webhooks are supplemented by a lazy state synchronization function (`tick(groupId)`) running on application requests.
- **I7.** No unilateral money-affecting code path exists for any user role (including `OWNER`). The group owner has invitation and proposal-drafting permissions only.
- **I8.** Every balance or status change writes an audit row to `ledger_events` recording actor, rationale, and external reference IDs.
- **I9.** Funding goals and spending caps are **never changed silently**. Any alteration requires an explicit group proposal and recorded vote.
- **I10.** Untrusted text (catalog titles, vendor payloads, chat prompts) is treated as data, never system instructions, and is strictly delimited in LLM prompts.

---

## 4. Data model (PostgreSQL / Supabase)

### 4.1 Schema DDL

```sql
-- Extensions
create extension if not exists "uuid-ossp";

-- Users (with demo persona support)
create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  paypal_sandbox_email text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- Groups
create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null check (mode in ('POOLED','PURCHASER')),
  status text not null default 'DRAFT'
    check (status in ('DRAFT','FUNDING','ACTIVE','CLOSING','CLOSED')),
  currency text not null default 'USD' check (currency = 'USD'),
  active_policy_id uuid,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

-- Group Memberships
create table memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  user_id uuid not null references users(id),
  role text not null default 'MEMBER' check (role in ('OWNER','MEMBER')), -- OWNER has no financial superpowers (I7)
  status text not null default 'INVITED' check (status in ('INVITED','ACTIVE','LEFT')),
  unique (group_id, user_id)
);

-- Policies (Versioned & Immutable)
create table policies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  version int not null,
  status text not null check (status in ('DRAFT','ACTIVE','SUPERSEDED')),
  charter_text text,
  policy jsonb not null,            -- validated against section 5 schema
  created_at timestamptz not null default now(),
  unique (group_id, version)
);

-- Curated / Verified Vendors
create table vendors (
  id text primary key,              -- e.g. 'v_projector_shop'
  name text not null,
  paypal_email text not null,       -- sandbox business account email
  category text not null,
  verified boolean not null default false,
  source text not null default 'CATALOG' check (source in ('CATALOG','AGENT_FOUND'))
);

-- Funding Rounds (Member pool collection)
create table funding_rounds (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  status text not null check (status in (
    'OPEN', 'CAPTURING', 'FUNDED', 'PARTIAL_FAILURE', 
    'AWAITING_GROUP_DECISION', 'FUNDED_REDUCED', 'UNWINDING', 'UNWOUND', 'CANCELLED'
  )),
  per_member_cents int not null check (per_member_cents > 0),
  min_contributors int not null check (min_contributors > 0),
  authorization_deadline timestamptz not null,
  decision_deadline timestamptz,
  created_at timestamptz not null default now()
);

-- Member Contributions
create table contributions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references funding_rounds(id),
  member_id uuid not null references memberships(id),
  amount_cents int not null check (amount_cents > 0),
  status text not null check (status in (
    'PENDING_APPROVAL', 'AUTHORIZED', 'CAPTURE_PENDING', 
    'CAPTURED', 'CAPTURE_FAILED', 'VOIDED', 'REFUNDED'
  )),
  paypal_order_id text,
  authorization_id text,
  capture_id text,
  authorized_at timestamptz,
  honor_expires_at timestamptz,         -- authorized_at + 3 days (or reauth + 3 days)
  authorization_expires_at timestamptz,     -- authorized_at + 29 days
  capture_attempts int not null default 0,
  last_error text,
  unique (round_id, member_id)
);

-- Proposals
create table proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  type text not null check (type in
    ('PURCHASE','POLICY_AMENDMENT','ACCEPT_REDUCED_BUDGET','UNWIND_FUNDING')),
  status text not null check (status in (
    'DRAFT', 'OPEN', 'VETO_WINDOW', 'EXECUTABLE', 
    'EXECUTING', 'EXECUTED', 'EXECUTION_FAILED', 'REJECTED', 'VETOED', 'BLOCKED', 'CANCELLED', 'EXPIRED'
  )),
  created_by_kind text not null check (created_by_kind in ('AGENT','MEMBER','SYSTEM')),
  created_by uuid references users(id),
  policy_version int not null,
  vendor_id text references vendors(id),
  category text,
  amount_cents int,
  payload jsonb not null,
  voting_deadline timestamptz,
  veto_ends_at timestamptz,
  created_at timestamptz not null default now()
);

-- Append-Only Votes
create table votes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id),
  member_id uuid not null references memberships(id),
  kind text not null check (kind in ('VOTE','VETO')),
  choice text not null check (choice in ('APPROVE','REJECT','VETO')),
  created_at timestamptz not null default now(),
  unique (proposal_id, member_id, kind)
);

-- Payments
create table payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  proposal_id uuid not null references proposals(id),
  kind text not null check (kind in ('PAYOUT','CHECKOUT','REFUND')),
  status text not null check (status in
    ('CREATED','PENDING','SUCCEEDED','FAILED','RETURNED','UNCLAIMED')),
  amount_cents int not null check (amount_cents > 0),
  sender_batch_id text unique,          -- Idempotency key: q_<proposal_id>_<attempt>
  paypal_batch_id text,
  paypal_item_id text,
  paypal_order_id text,
  paypal_capture_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live payment per proposal (I3/I4)
create unique index one_live_payment_per_proposal
  on payments (proposal_id) where kind in ('PAYOUT','CHECKOUT') and status not in ('FAILED','RETURNED');

-- Guard Decisions Log (Audit trail)
create table guard_decisions (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id),
  phase text not null check (phase in ('PROPOSAL','VOTING','EXECUTION')),
  policy_version int not null,
  input_snapshot jsonb not null,
  result jsonb not null,
  decision text not null,
  created_at timestamptz not null default now()
);

-- Financial & Operational Ledger (Source of Truth)
create table ledger_events (
  id bigserial primary key,
  group_id uuid not null references groups(id),
  type text not null,
  actor_kind text not null check (actor_kind in ('MEMBER','AGENT','SYSTEM','PAYPAL')),
  actor_id uuid,
  ref_type text,
  ref_id text,
  amount_cents int,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index idx_ledger_group_type on ledger_events (group_id, type);

-- Webhook Ingestion Log
create table webhook_events (
  paypal_event_id text primary key,
  event_type text not null,
  verified boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload jsonb not null
);

-- Agent Trace Log
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  proposal_id uuid references proposals(id),
  model text not null,
  tool_calls jsonb not null,
  created_at timestamptz not null default now()
);

-- Append-Only Database Triggers (I5)
create or replace function forbid_mutation() returns trigger as $$
begin 
  raise exception 'Table % is strictly append-only. UPDATE and DELETE operations are forbidden.', TG_TABLE_NAME; 
end; 
$$ language plpgsql;

create trigger ledger_no_mutation before update or delete on ledger_events
  for each row execute function forbid_mutation();

create trigger votes_no_mutation before update or delete on votes
  for each row execute function forbid_mutation();

create trigger guard_no_mutation before update or delete on guard_decisions
  for each row execute function forbid_mutation();
```

### 4.2 Ledger Event Types
`CONTRIBUTION_AUTHORIZED`, `CONTRIBUTION_CAPTURED`, `CONTRIBUTION_CAPTURE_FAILED`, `CONTRIBUTION_VOIDED`, `CONTRIBUTION_REFUNDED`, `FUNDS_RESERVED`, `FUNDS_RELEASED`, `PAYOUT_SUBMITTED`, `PAYOUT_SUCCEEDED`, `PAYOUT_FAILED`, `CHECKOUT_COMPLETED`, `POLICY_ACTIVATED`, `PROPOSAL_CREATED`, `PROPOSAL_STATUS_CHANGED`, `VOTE_CAST`, `VETO_CAST`, `GUARD_DECISION`, `WEBHOOK_APPLIED`.

### 4.3 Deterministic Balance Formulas

#### Pooled Mode
```
captured   = sum(amount_cents) from ledger_events where type = 'CONTRIBUTION_CAPTURED'
refunded   = sum(amount_cents) from ledger_events where type = 'CONTRIBUTION_REFUNDED'
paid       = sum(amount_cents) from ledger_events where type = 'PAYOUT_SUCCEEDED'
reserved   = sum(amount_cents) from ledger_events where type = 'FUNDS_RESERVED' 
             - sum(amount_cents) from ledger_events where type = 'FUNDS_RELEASED'
             - paid_against_reservations
available  = captured - refunded - paid - reserved
```

#### Direct Mode
```
budget_cents     = policy.budget_cents
paid_checkout    = sum(amount_cents) from ledger_events where type = 'CHECKOUT_COMPLETED'
reserved         = sum(amount_cents) from ledger_events where type = 'FUNDS_RESERVED'
                   - sum(amount_cents) from ledger_events where type = 'FUNDS_RELEASED'
                   - paid_against_reservations
budget_remaining = budget_cents - paid_checkout - reserved
```

---

## 5. Policy schema (v1.1)

### 5.1 Demo Policy Configuration

```json
{
  "schema_version": 1,
  "currency": "USD",
  "budget_cents": 48000,
  "hard_cap_cents": 20000,
  "unanimous_above_cents": 15000,
  "approval_tiers": [
    { "max_cents": 6000, "votes_required": 2 },
    { "max_cents": 20000, "votes_required": 4 }
  ],
  "veto_window_minutes": 2,
  "proposal_expiry_hours": 72,
  "vendors": {
    "mode": "ALLOWLIST_ONLY",
    "allowlist_vendor_ids": ["v_projector_shop", "v_cafe_supplies", "v_print_hub"]
  },
  "categories_allowed": ["equipment", "food", "printing"],
  "funding": {
    "per_member_cents": 8000,
    "min_contributors": 6,
    "authorization_window_hours": 48,
    "capture_retry_attempts": 2,
    "capture_retry_interval_minutes": 2,
    "partial_failure_decision": "GROUP_VOTE",
    "partial_failure_default": "UNWIND",
    "reduced_budget_votes_required": "MAJORITY_OF_CONTRIBUTORS"
  },
  "amendment_votes_required": 4,
  "close": { "refund": "PRO_RATA" }
}
```

### 5.2 Deterministic Validator Rules
1. `budget_cents == funding.per_member_cents * funding.min_contributors`.
2. `0 < unanimous_above_cents <= hard_cap_cents <= budget_cents`.
3. `approval_tiers` sorted by `max_cents` ascending; highest tier's `max_cents == hard_cap_cents`.
4. Every tier `votes_required` is between `1` and `min_contributors`.
5. Any amount exceeding `unanimous_above_cents` mandates unanimous approval of all eligible voters.
6. `veto_window_minutes >= 1`; `capture_retry_attempts` between `0` and `3`.
7. `authorization_window_hours <= 48` (ensures capture remains within PayPal's 3-day honor window).
8. Allowlisted vendors must exist in `vendors` table with `verified = true`.
9. `partial_failure_default` must be `'UNWIND'`.

### 5.3 Charter to Policy
`parse_charter(text)` returns `{ policy_draft, ambiguities[], conflicts[], questions[] }`.
- The LLM parses freeform charter prose and populates a policy draft, flagging inconsistencies (e.g. "Cap of $250 exceeds budget of $200").
- The deterministic validator (5.2) executes on the output. The AI cannot activate a policy.
- Activation requires unanimous initial member approval (`POLICY_ACTIVATED` ledger entry).

---

## 6. Quorum Guard

### 6.1 Function Signature & Types

Quorum Guard is a **pure function**. It performs no disk reads, no network requests, no database queries, and no LLM calls.

```ts
export type GuardPhase = 'PROPOSAL' | 'VOTING' | 'EXECUTION';

export interface GuardInput {
  phase: GuardPhase;
  now: string;                       // ISO timestamp (injected for deterministic testing)
  policy: Policy;                    // Active policy snapshot
  group: { 
    id: string;
    mode: 'POOLED' | 'PURCHASER'; 
    status: string 
  };
  proposal: Proposal;
  votes: Vote[];                     // Cast VOTE and VETO records
  eligibleVoters: string[];          // Membership IDs of valid contributors
  vendor?: Vendor;
  funds: { 
    availableCents: number;          // Pooled mode: available balance; Direct mode: budget_remaining
    reservedCents: number; 
    fundingReady: boolean 
  };
  existingLivePayment: boolean;
}

export type GuardDecision =
  | 'APPROVED'
  | 'VETO_WINDOW_OPEN'
  | 'NEEDS_VOTES'
  | 'REJECTED_BY_VOTE'
  | 'VETOED'
  | 'BLOCKED';

export interface CheckDetail {
  code: string;
  pass: boolean;
  detail: string;
}

export interface GuardResult {
  decision: GuardDecision;
  executionAllowed: boolean;         // True iff decision === 'APPROVED' and phase === 'EXECUTION'
  reasonCodes: string[];
  checks: CheckDetail[];
  numbers: {
    amountCents: number;
    hardCapCents: number;
    unanimousAboveCents: number;
    availableCents: number;
    remainingAfterCents: number;
    votesRequired: number;
    approvals: number;
    eligibleVoters: number;
    vetoActive: boolean;
  };
  suggestions: { 
    maxAllowedAmountCents: number;   // Injected back to the agent on failure
  };
}

export function evaluate(input: GuardInput): GuardResult;
```

### 6.2 Check Codes & Evaluation Logic

All checks run on every invocation; all failures are accumulated in `reasonCodes`.

| Check Code | Failure Condition |
|---|---|
| `GROUP_NOT_ACTIVE` | Group status is not `ACTIVE`, or funding is incomplete |
| `PROPOSAL_EXPIRED` | `now > proposal.voting_deadline` (when status is `OPEN`) |
| `POLICY_VERSION_CHANGED` | `proposal.policy_version != policy.version` |
| `PROPOSER_NOT_ALLOWED` | Proposer is not active member, registered agent, or system |
| `CURRENCY_MISMATCH` | Proposal currency is not `USD` |
| `VENDOR_NOT_ALLOWED` | `proposal.vendor_id` not in `policy.vendors.allowlist_vendor_ids` |
| `VENDOR_UNVERIFIED` | Vendor record has `verified = false` |
| `CATEGORY_NOT_ALLOWED` | `proposal.category` not in `policy.categories_allowed` |
| `HARD_CAP_EXCEEDED` | `proposal.amount_cents > policy.hard_cap_cents` |
| `BUDGET_EXCEEDED` | `proposal.amount_cents > funds.availableCents` |
| `FUNDING_NOT_READY` | Pooled mode and funding round is not `FUNDED` or `FUNDED_REDUCED` |
| `DUPLICATE_EXECUTION` | `existingLivePayment == true` |
| `NEEDS_VOTES` | Approval count < required votes (or < all eligible voters if amount > `unanimous_above_cents`) |
| `REJECTED_BY_VOTE` | Impossible to reach required votes: `approvals + (eligible - votesCast) < votes_required` |
| `VETOED` | At least one valid `VETO` vote exists |
| `VETO_WINDOW_OPEN` | Approval threshold met, but `now < proposal.veto_ends_at` |

**Strict Decision Precedence:**  
`BLOCKED` > `VETOED` > `REJECTED_BY_VOTE` > `NEEDS_VOTES` > `VETO_WINDOW_OPEN` > `APPROVED`.

`executionAllowed` evaluates to `true` **only** when `decision === 'APPROVED'` and `phase === 'EXECUTION'`.

---

## 7. State machines

### 7.1 Proposal Lifecycle

```
[DRAFT]
   │
   ├─ Guard(PROPOSAL) passes ──> [OPEN]
   └─ Guard(PROPOSAL) blocks ──> [BLOCKED] (Terminal for this proposal; agent adapts)

[OPEN]
   │
   ├─ Approvals reach threshold ──> [VETO_WINDOW] (veto_ends_at = threshold_reached_at + veto_window_minutes)
   ├─ Mathematically rejected   ──> [REJECTED] (Terminal)
   └─ Voting deadline passes    ──> [EXPIRED] (Terminal)

[VETO_WINDOW]
   │
   ├─ Any eligible voter vetoes ──> [VETOED] (Terminal)
   └─ now >= veto_ends_at       ──> [EXECUTABLE]

[EXECUTABLE]
   │
   ├─ Active member clicks "Execute" & Guard(EXECUTION) passes ──> [EXECUTING]
   └─ Guard(EXECUTION) fails (e.g. policy changed or budget gone)──> [BLOCKED]

[EXECUTING]
   │
   ├─ Payment succeeds ──> [EXECUTED] (Terminal)
   └─ Payment fails    ──> [EXECUTION_FAILED] (Releases reserved funds; manual retry permitted)
```

### 7.2 Funding Round Lifecycle

```
[OPEN]
   │
   ├─ Contributors count >= min_contributors ──> [CAPTURING]
   └─ Authorization deadline passes underfunded ──> [CANCELLED] (Void all authorizations)

[CAPTURING]
   │
   ├─ All member authorizations captured ──> [FUNDED] (Group moves to ACTIVE)
   └─ Any capture fails after max retries ──> [PARTIAL_FAILURE] (Group execution FROZEN)

[PARTIAL_FAILURE]
   │
   └─ System generates two governance proposals ──> [AWAITING_GROUP_DECISION]

[AWAITING_GROUP_DECISION]
   │
   ├─ ACCEPT_REDUCED_BUDGET passes ──> [FUNDED_REDUCED] (Policy v2 created, budget = sum of captured)
   ├─ UNWIND_FUNDING passes        ──> [UNWINDING]
   └─ Decision deadline passes      ──> [UNWINDING] (Default safe path)

[UNWINDING]
   │
   └─ All captures refunded & authorizations voided ──> [UNWOUND]
```

#### Funding Execution Rules
1. Every capture carries request ID `cap_<contribution_id>_<attempt>`.
2. Failed captures retry up to `capture_retry_attempts` times, separated by `capture_retry_interval_minutes`.
3. If `now > honor_expires_at`, call PayPal reauthorization first, store the new `authorization_id`, then capture.
4. `ACCEPT_REDUCED_BUDGET` requires a majority vote among members whose funds were successfully captured. Uncaptured members become inactive.

### 7.3 Payment Lifecycle
`CREATED` → `PENDING` → `SUCCEEDED`  
Failure branches: `FAILED`, `RETURNED`, `UNCLAIMED`.  
On failure, `FUNDS_RELEASED` is logged, and the proposal marks `EXECUTION_FAILED`.

### 7.4 The Execution Transaction (§3.2 I3, I4)

Because PostgREST cannot maintain an interactive row-lock across API roundtrips, the payment execution path runs through a **direct PostgreSQL connection** (`pg` pool):

> [!IMPORTANT]
> **Supabase Connection Mode:** Supabase's direct connection (`db.[ref].supabase.co:5432`) is IPv6-only on the free tier. Hosts lacking IPv6 egress (such as Render or some local developer networks) must connect through Supabase's connection pooler in **Session mode** (`aws-0-[region].pooler.supabase.com:5432`). Both direct IPv6 and pooler Session mode support `SELECT ... FOR UPDATE` (unlike Transaction mode on port 6543, which does not support session row-locks).

```sql
BEGIN;
  -- 1. Serialize execution for this group
  SELECT id FROM groups WHERE id = $1 FOR UPDATE;

  -- 2. Assemble Guard input from ledger and DB
  -- 3. Evaluate Guard in EXECUTION phase
  -- 4. INSERT INTO guard_decisions (...)
  
  -- 5. If !result.executionAllowed, COMMIT and return failure
  
  -- 6. Reserve funds and insert payment in CREATED status
  INSERT INTO payments (group_id, proposal_id, kind, status, amount_cents, sender_batch_id)
    VALUES ($1, $2, $3, 'CREATED', $4, 'q_' || $2 || '_' || $5);
  INSERT INTO ledger_events (group_id, type, amount_cents, ...) 
    VALUES ($1, 'FUNDS_RESERVED', $4, ...);
  UPDATE proposals SET status = 'EXECUTING' WHERE id = $2;
COMMIT;

-- 7. Outside DB transaction: Invoke Payment Adapter (PayPal API)
-- 8. Record outcome or await webhook notification
```

### 7.5 Group Closing (`CLOSING` → `CLOSED`)
When a group initiates closure:
1. Status updates to `CLOSING`.
2. No new proposals may be drafted or opened.
3. All pending proposals transition to `CANCELLED`.
4. The ledger calculates unspent net contributions per member.
5. The system issues refunds via the same unwind mechanism as `UNWIND_FUNDING`.
6. When all refunds succeed, group status becomes `CLOSED`.

### 7.6 Execution Trigger
Execution is triggered **manually** by any active member clicking the "Execute" button on an `EXECUTABLE` card.
- The AI agent cannot trigger execution.
- Auto-execution is deliberately avoided: manual execution ensures an explicit video beat, clear human agency, and removes the need for persistent server crons.

---

## 8. PayPal integration

### 8.1 Required Sandbox Accounts
1. **Platform Business Account:** Hosts the Quorum app integration, captures pooled funds, and funds payouts.
2. **3 Vendor Business Accounts:**
   - `v_projector_shop` (`vendor-projector@sandbox.quorum.app`)
   - `v_cafe_supplies` (`vendor-cafe@sandbox.quorum.app`)
   - `v_print_hub` (`vendor-print@sandbox.quorum.app`)
3. **6 Personal Buyer Accounts:** Asha, Ben, Chloe, Dev, Elena, Farid (Demo members).

### 8.2 API Endpoints Used

| Purpose | Method & Route | Request Key / Headers |
|---|---|---|
| OAuth2 Token | `POST /v1/oauth2/token` | Basic Auth, cached until expiry |
| Order Creation (Auth) | `POST /v2/checkout/orders` | `intent: "AUTHORIZE"`, `custom_id: contribution_id` |
| Authorize Order | `POST /v2/checkout/orders/{id}/authorize` | `PayPal-Request-Id: auth_<contribution_id>` |
| Capture Auth | `POST /v2/payments/authorizations/{id}/capture` | `PayPal-Request-Id: cap_<contribution_id>_<attempt>` |
| Reauthorize | `POST /v2/payments/authorizations/{id}/reauthorize` | `PayPal-Request-Id: reauth_<contribution_id>_<attempt>` |
| Void Auth | `POST /v2/payments/authorizations/{id}/void` | `PayPal-Request-Id: void_<contribution_id>` |
| Refund Capture | `POST /v2/payments/captures/{id}/refund` | `PayPal-Request-Id: ref_<contribution_id>` |
| Payouts (Pooled) | `POST /v1/payments/payouts` | Body: `sender_batch_header.sender_batch_id = q_<prop_id>_<att>` |
| Check Payout Batch | `GET /v1/payments/payouts/{batch_id}` | Bearer Token |
| Verify Webhook | `POST /v1/notifications/verify-webhook-signature` | Uses Dashboard Webhook ID |
| Checkout (Direct) | `POST /v2/checkout/orders` | `intent: "CAPTURE"`, `purchase_units[0].payee.email_address = vendor` |

### 8.3 Vendor Payment Adapter Pattern
```ts
export interface VendorPaymentAdapter {
  executePayment(params: {
    groupId: string;
    proposalId: string;
    amountCents: number;
    vendorEmail: string;
    attempt: number;
  }): Promise<{
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
    transactionId: string;
    rawResponse: any;
  }>;
}

export class PayoutAdapter implements VendorPaymentAdapter { ... }
export class CheckoutAdapter implements VendorPaymentAdapter { ... }
```

### 8.4 Idempotency Verification & Error Handling
PayPal Payouts enforces idempotency on `sender_batch_header.sender_batch_id`. Re-submitting an identical `sender_batch_id` returns **HTTP 400 Bad Request** with the following verified sandbox response:
```json
{
  "name": "USER_BUSINESS_ERROR",
  "message": "User business error.",
  "details": [
    {
      "field": "SENDER_BATCH_ID",
      "location": "body",
      "issue": "Batch with given sender_batch_id already exists"
    }
  ]
}
```
The application treats this error as confirmation that the batch was already accepted and queries `GET /v1/payments/payouts/{batch_id}` to reconcile status.

### 8.5 Webhooks & Deduplication
- Subscribed Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.DENIED`.
- Processing:
  1. Validate signature via `verify-webhook-signature`. (Use real events; simulator events fail signature checks).
  2. `INSERT INTO webhook_events (paypal_event_id, ...) ON CONFLICT DO NOTHING`. If duplicate, return HTTP 200 immediately.
  3. Apply state transition and ledger event inside a database transaction.

### 8.5 Lazy State Synchronization (`tick(groupId)`)
To avoid background worker costs and render free-tier sleep issues, time-dependent transitions are evaluated lazily via `tick(groupId)`:
- Invoked on: Every page request, proposal action, member vote, and webhook delivery.
- Checks:
  1. Veto windows expired? (`OPEN` / `VETO_WINDOW` → `EXECUTABLE`).
  2. Proposals expired? (`OPEN` → `EXPIRED`).
  3. Funding rounds timed out or pending retry?
- Webhook deliveries: When a sleeping Render web service wakes on incoming webhook traffic, `tick()` and webhook deduplication guarantee reliable recovery.
- **[VERIFY]** The claim that "PayPal retries failed webhook deliveries up to 25 times across 3 days" originates from third-party guides; verify against PayPal's official platform documentation during webhook setup.

### 8.6 Hosting, Keep-Alive, & "Zero-Cost Scheduler"
- **Render Deployment:** Free web service tier eligible for the Render Hackathon prize. Note that Render provides 750 free instance hours per month (a 31-day month consumes ~744 hours for 1 service). Do not deploy a second service under the same free account.
- **Dual-Purpose Keep-Alive Ping:** Configure a free external monitor (e.g. UptimeRobot or GitHub Actions scheduled curl) to ping `GET https://<app>.onrender.com/api/health` every 10 minutes.
- **Automated Deadline Processing (Free Scheduler):** Inside `/api/health`:
  1. Execute a lightweight database query (`SELECT 1`) to reset Supabase's 7-day inactivity pause counter. **[VERIFY]** Confirm on Day 1 whether `SELECT 1` via the pooler resets Supabase's pause timer.
  2. Query groups with pending deadlines (`now >= veto_ends_at` or `now >= voting_deadline` or `now >= decision_deadline`).
  3. Call `tick(groupId)` for those groups. This yields an automated scheduler at zero extra infrastructure cost.

---

## 9. The AI agent

### 9.1 Role & Tool Whitelist
The agent acts as the group's researcher and policy-aware assistant.

| Registered Tool | Access | Description |
|---|---|---|
| `get_group_state()` | Read | Reads active policy, available funds, member count, and active proposals |
| `parse_charter(text)` | Read/Write | Parses charter into draft policy with ambiguities flagged |
| `search_options(query, filters)` | Read | Searches curated catalog fixture |
| `compare_options(options)` | Read | Ranks products against policy constraints and budget |
| `create_proposal(option, rationale)` | Write | Submits a proposal in `DRAFT` status; triggers Guard(PROPOSAL) |
| `explain_decision(proposal_id)` | Read | Returns deterministic Guard result and explanation template |

### 9.2 Prohibited Agent Operations (§3.2 I2)
The agent cannot:
- Cast votes or vetoes.
- Edit, approve, or activate policies.
- Execute payments, captures, payouts, or refunds.
- Inspect or alter PayPal secrets.

### 9.3 The Adapt Loop (Key Demo Beat)
1. Agent proposes a $350 projector (`create_proposal`).
2. Quorum Guard evaluates in `PROPOSAL` phase and returns `BLOCKED` with code `HARD_CAP_EXCEEDED` and `suggestions.maxAllowedAmountCents = 20000`.
3. The server returns this feedback to the agent conversation loop.
4. Agent re-queries `search_options({ max_price: 20000 })` and creates a compliant alternative proposal for $145.
5. Max 3 proposal attempts per user request.

### 9.4 LLM Configuration
- Provider: Google Gemini (`gemini-2.5-flash` or current active Flash model via AI Studio).
- Deterministic parsing: Low temperature (0.1), structured JSON output with Zod schema validation.
- Prompt injection defense (I10): Vendor catalog data and user inputs are encapsulated within XML delimiters (`<catalog_item>...</catalog_item>`) and declared as untrusted data in the system prompt.

---

## 10. Authentication and demo mode

- **No login barrier for hackathon judges:** The application ships with a pre-seeded demo group ("Event Committee") and an **"Act as Member"** persona switcher.
- Persona switcher sets a signed, HTTP-only session cookie identifying the acting demo member (Asha, Ben, Chloe, Dev, Elena, Farid).
- All server routes and actions validate membership and permissions against the session cookie.
- Owner role can invite members and create proposals, but possesses zero unilateral payment powers (I7).

---

## 11. UI spec

Single-page responsive committee workspace:
1. **Header & Persona Switcher:** Displays active user, group mode badge ("Pooled mode" or "Direct mode"), and "Act as..." dropdown.
2. **Group Policy Card:** Visual breakdown of budget, spending cap, approval tiers, and allowlisted vendors. "View Charter" and "Amend Policy" buttons.
3. **Funding Round Bar:** Real-time contributor readiness status with visual progress bar and partial-failure alerts.
4. **Agent Panel:** Interactive chat for requesting research, drafting proposals, and inspecting the adapt loop.
5. **Proposals Feed:** Cards showing item details, cost, vendor badge, voting progress, veto countdown timer, manual "Execute" button, and a **"Why?"** button.
6. **Guard Explanation Modal ("Why?"):** Human-readable checklist generated directly from the deterministic Guard result JSON, with a toggle to inspect raw decision data.
7. **Append-Only Financial Ledger (AG Grid):** Complete, auditable log of every financial and governance event with filtering, sorting, and PayPal reference ID inspector. *(Eligible for $5,000 AG Grid sponsor prize)*.

---

## 12. Seeded demo and scenarios

### 12.1 Curated Catalog Fixture
Curated catalog with deliberate boundary prices:
- Projectors: $350 (over cap), $180 (unanimity tier), $145 (4-vote tier), $135 (4-vote tier alternative).
- Tier Boundary Test Items:
  - $59 (Tier 1: 2 votes) vs $60 (Tier 1 limit) vs $61 (Tier 2: 4 votes).
  - $149 (Tier 2: 4 votes) vs $150 (Unanimity threshold) vs $151 (Requires all 6 votes).
  - $199 (Under cap) vs $200 (Hard cap limit) vs $201 (Over cap: BLOCKED).

### 12.2 Test Scenarios

| ID | Scenario | Expected Outcome |
|---|---|---|
| **S1** | Agent proposes $350 projector | `BLOCKED` (`HARD_CAP_EXCEEDED`, max allowed = $200) |
| **S2** | Agent adapts to $145 projector; 4 approve; Elena vetoes during veto window | Proposal status moves to `VETOED`; no execution possible |
| **S3** | Agent proposes $135 projector; 4 approve; veto window ends; Elena clicks "Execute" | `APPROVED` → Payout executes → PayPal webhook confirms → `EXECUTED`; ledger records event |
| **S4** | Funding failure: 5 captures succeed, Farid's capture fails after retries | `PARTIAL_FAILURE`; system proposes `ACCEPT_REDUCED_BUDGET` ($400) or `UNWIND_FUNDING`; group accepts reduced budget |
| **S5** | Member double-clicks "Execute" or replays network request | Direct DB row-lock & unique payment index blocks second payment; returns `DUPLICATE_EXECUTION` |
| **S6** | PayPal webhook delivers duplicate event | Deduplicated via `webhook_events` primary key; no duplicate ledger entry |
| **S7** | Payout fails (simulated insufficient funds) | Payment status marks `FAILED`, reservation released, proposal becomes `EXECUTION_FAILED` |
| **S8** | Owner attempts unilateral payout | Request fails with HTTP 403 / Guard block; no bypass path exists |
| **S9** | Policy amended while proposal in veto window | Guard re-run in `EXECUTION` phase detects `POLICY_VERSION_CHANGED` and blocks execution |
| **S10** | Member proposes $180 item; 4 approve | Status remains `NEEDS_VOTES`; items > $150 require unanimous 6/6 votes |

### 12.3 Demo Reset
`npm run demo:reset` (and protected route `POST /api/demo/reset` with `Authorization: Bearer <DEMO_RESET_SECRET>`):
- Drops mutable state, clears test records, and re-seeds the demo group in `ACTIVE` funded status with clean ledger entries.
- **PayPal Balance Awareness:** Database resets do *not* reverse real sandbox payouts or restore sandbox account balances. Demo payouts must be kept small (e.g. $1 - $5 for live sandbox calls, or standard demo figures).
- **Simulated Fixture Isolation:** Mark seeded historical fixture transactions with `simulated: true` in `ledger_events.data` so `tick()` and reconciliation ignore them and avoid polling PayPal for non-existent sandbox IDs.
- Never expose the reset endpoint without authentication.

---

## 13. Testing strategy

1. **Quorum Guard Unit Tests (`vitest`):**
   - At least 25 pure table-driven test cases covering every check code, decision precedence, tier boundaries, and unanimity overrides.
   - Property tests asserting that `executionAllowed` is never true outside `EXECUTION` phase and never true if amount exceeds available funds.
2. **State Machine Transitions:**
   - Exhaustive tests asserting that illegal state jumps (e.g. `VETOED` → `EXECUTING`) throw exceptions.
3. **Payment Concurrency & Idempotency:**
   - Concurrency tests asserting that simultaneous execution attempts on the direct PostgreSQL connection yield exactly one payment reservation.
4. **End-to-End Sandbox Flow:**
   - Scripted test executing S1 through S10 against the live PayPal sandbox.

---

## 14. Repository structure & lint rules

```
/app                      # Next.js 14 App Router (Pages, UI components, AG Grid)
/lib
  /guard                  # Pure Quorum Guard: evaluate(), reason codes, templates
  /policy                 # Zod schema, deterministic validator, charter parser
  /funding                # Funding round state machine & retry logic
  /payments               # Payment service, DB transactions
    /adapters             # VendorPaymentAdapter, PayoutAdapter, CheckoutAdapter
    /paypal               # PayPal sandbox client & signature verification
  /agent                  # AI Agent: tool definitions, prompts, catalog fixture
  /ledger                 # Append-only queries & balance calculations
  /db                     # Direct pg connection pool & Supabase client
/db
  /migrations             # PostgreSQL schema, triggers, and indexes
  /seeds                  # Seed data for demo group, catalog, and members
/tests                    # Vitest test suites (Guard, funding, payments, integration)
SPEC.md                   # Single source of truth
README.md                 # Judge walkthrough & setup instructions
LICENSE                   # MIT License
```

### Architectural Lint Enforcements
In `.eslintrc.json`, enforce architectural boundary I1/I2:
```json
{
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        { "name": "@/lib/payments", "message": "Quorum Guard cannot import payments." },
        { "name": "@/lib/agent", "message": "Quorum Guard cannot import agent logic." }
      ]
    }]
  }
}
```

---

## 15. Day-1 verification checklist (Oct 31)

- [x] **Test Sandbox Payouts immediately (Priority #1):** **VERIFIED (Nov 2).** OAuth token generation, $1.00 payout execution (Batch ID `RECH875Y3KX4U`, HTTP 201), batch terminal `SUCCESS`, item `SUCCESS` (Item ID `F3RRGP4AFNFMU`), and duplicate rejection (HTTP 400 `USER_BUSINESS_ERROR`, `"Batch with given sender_batch_id already exists"`) confirmed working on US sandbox accounts. **Pooled mode is greenlit.**
- [ ] **Supabase Connection & Row-Locking:** Test direct connection vs. pooler in **Session mode** (`aws-0-[region].pooler.supabase.com:5432`) to confirm `SELECT ... FOR UPDATE` row-locking works on IPv4 environments.
- [ ] **Supabase Keep-Alive:** **[VERIFY]** Confirm whether a scheduled `SELECT 1` query reliably prevents Supabase's 7-day free tier project pausing.
- [ ] **Orders & Authorizations:** Test `POST /v2/checkout/orders` (`intent: "AUTHORIZE"`), approve via buyer sandbox account, and execute capture.
- [ ] **Verify Reauthorization:** Confirm that reauthorization restarts the honor window and updates the authorization ID.
- [ ] **Webhook Verification:** Register sandbox webhook URL and verify signature using the Developer Dashboard Webhook ID.
- [ ] **Webhook Retries:** **[VERIFY]** Confirm PayPal's documented retry schedule for failed webhook deliveries.
- [ ] **Check Active Gemini Models:** Verify active Gemini models and rate limits in Google AI Studio; confirm Flash model availability.
- [ ] **Deploy Initial Webhook Shell to Render:** Verify public HTTPS accessibility and register the live URL with PayPal Sandbox Webhooks.

---

## 16. Build order & priority cut list

### Build Schedule (Oct 31 - Nov 11)

| Date | Target Deliverable | Exit Gate |
|---|---|---|
| **Oct 31** | Repo setup, database schema, sandbox accounts, Day-1 PayPal test script | Sandbox authorization, capture, and payout succeed |
| **Nov 1 - 2** | Policy validator, **Quorum Guard pure core + 25+ unit tests**, explanation templates | Vitest Guard suite 100% green |
| **Nov 3 - 4** | Funding state machine, lazy `tick(groupId)`, webhooks, failure injection | S4, S5, S6 automated tests pass |
| **Nov 5** | Payment execution transaction (direct pg row lock), Payout & Checkout adapters | S3, S7 pass; double-execution test passes |
| **Nov 6** | Agent tool registry, adapt loop, catalog fixture, charter parsing panel | S1 → S2 → S3 runs end-to-end; **Feature Freeze** |
| **Nov 7 - 8** | UI workspace, AG Grid ledger integration, persona switcher, demo reset script | Judge walkthrough runs flawlessly on Render |
| **Nov 9 - 10** | Video production (100s storyboard), documentation, clean-install verification | YouTube unlisted/public video link ready |
| **Nov 11** | Final buffer & Devpost submission | Submitted before deadline day |

### Prioritized Cut Order (If Behind Schedule)
If development encounters delays, cut features strictly in this order:
1. **Cut 1:** Channel3 external product enrichment (keep curated catalog fixture).
2. **Cut 2:** UI visual animations.
3. **Cut 3:** `ACCEPT_REDUCED_BUDGET` governance proposal (on partial failure, always trigger `UNWIND_FUNDING`).
4. **Cut 4:** Live policy amendments (freeze policy at version 1).
5. **DO NOT CUT:** AG Grid financial ledger (qualifies for $5,000 sponsor prize).
6. **NEVER CUT:** Pure Quorum Guard, real PayPal sandbox integration, funding failure handling, and the agent adapt loop (S1→S2→S3).
