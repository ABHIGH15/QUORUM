-- Extensions
create extension if not exists "uuid-ossp";

-- Users (with demo persona support)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  paypal_sandbox_email text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- Groups
create table if not exists groups (
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
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  user_id uuid not null references users(id),
  role text not null default 'MEMBER' check (role in ('OWNER','MEMBER')), -- OWNER has no financial superpowers (I7)
  status text not null default 'INVITED' check (status in ('INVITED','ACTIVE','LEFT')),
  unique (group_id, user_id)
);

-- Policies (Versioned & Immutable)
create table if not exists policies (
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
create table if not exists vendors (
  id text primary key,              -- e.g. 'v_projector_shop'
  name text not null,
  paypal_email text not null,       -- sandbox business account email
  category text not null,
  verified boolean not null default false,
  source text not null default 'CATALOG' check (source in ('CATALOG','AGENT_FOUND'))
);

-- Funding Rounds (Member pool collection)
create table if not exists funding_rounds (
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
create table if not exists contributions (
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
create table if not exists proposals (
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
create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id),
  member_id uuid not null references memberships(id),
  kind text not null check (kind in ('VOTE','VETO')),
  choice text not null check (choice in ('APPROVE','REJECT','VETO')),
  created_at timestamptz not null default now(),
  unique (proposal_id, member_id, kind)
);

-- Payments
create table if not exists payments (
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
create unique index if not exists one_live_payment_per_proposal
  on payments (proposal_id) where kind in ('PAYOUT','CHECKOUT') and status not in ('FAILED','RETURNED');

-- Guard Decisions Log (Audit trail)
create table if not exists guard_decisions (
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
create table if not exists ledger_events (
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
create index if not exists idx_ledger_group_type on ledger_events (group_id, type);

-- Webhook Ingestion Log
create table if not exists webhook_events (
  paypal_event_id text primary key,
  event_type text not null,
  verified boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload jsonb not null
);

-- Agent Trace Log
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  proposal_id uuid references proposals(id),
  model text not null,
  tool_calls jsonb not null,
  created_at timestamptz not null default now()
);
