# Quorum — Deterministic AI Group Purchasing & Governance Agent

> **PayPal AI Hackathon 2026 Submission**  
> **Core Promise:** *No individual member can independently authorize a purchase. Every expenditure must satisfy the group's agreed policy and approval requirements.*

[![Next.js](https://img.shields.io/badge/Next.js-14.2.25-black)](https://nextjs.org/)
[![PayPal](https://img.shields.io/badge/PayPal-Sandbox%20Payouts%20API-003087)](https://developer.paypal.com/)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-3.8%20Flash-4285F4)](https://aistudio.google.com/)
[![AG Grid Community](https://img.shields.io/badge/AG%20Grid-Community%20v36-22c55e)](https://www.ag-grid.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Row--Lock%20%26%20RLS-336791)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 1. Overview

**Quorum** is an autonomous group purchasing and collective governance platform built on the **PayPal Sandbox**.

When groups of individuals (clubs, co-ops, project teams, shared households, hackathon squads) pool money for collective purchases, traditional shared accounts fail:
- A single rogue admin or treasurer can unilaterally drain the balance.
- Tedious manual approvals lead to deadlocks and dropped purchases.
- LLM agents given direct API keys create severe financial hallucination risks.

Quorum solves this with **Quorum Guard**: a 100% deterministic, zero-I/O, zero-LLM governance evaluator that enforces group policies, multi-signature approval tiers, spending caps, and mandatory veto windows before a single cent can be disbursed.

The AI Purchasing Agent (powered by **Google Gemini 3.8 Flash** with structured tool calling) assists the group by researching options, navigating policy restrictions, and proposing purchases—but has **zero financial authority**. Payments execute only when deterministic group approval thresholds are met, the veto window expires without objection, and an active contributing member triggers execution through an interactive PostgreSQL row-lock.

---

## 2. Architecture Diagram

```mermaid
flowchart TD
    subgraph UI ["Next.js 14 Workspace UI"]
        Workspace["Interactive Workspace (/g/[id])"]
        AgentUI["AI Agent Panel (Chat & Tools)"]
        LedgerUI["AG Grid Community Ledger"]
        AuditModal["'Why?' Guard Audit Modal"]
    end

    subgraph AgentLayer ["AI Agent & Intelligence Layer"]
        Gemini["Google Gemini 3.8 Flash"]
        AdaptLoop["Autonomous Adapt Loop"]
        Tools["Tools: search, compare, check_proposal, create_proposal"]
    end

    subgraph GuardLayer ["Quorum Guard (Deterministic Evaluator)"]
        Guard["Quorum Guard Core\n(Pure Function: Zero I/O, No DB, No LLM)"]
        Policy["Policy Rules (Cap: $200, Unanimity: $150, 2m Veto)"]
    end

    subgraph DataLayer ["PostgreSQL Database & Ledger"]
        RowLock["Interactive Row Lock (SELECT ... FOR UPDATE)"]
        UniqueIdx["one_live_payment_per_proposal (Partial Unique Index)"]
        AppendLedger["Append-Only Ledger (ledger_events)"]
        RLS["Row Level Security (RLS Enabled on all tables)"]
    end

    subgraph PayPalIntegration ["PayPal Sandbox API"]
        Payouts["PayPal Payouts API\n(POST /v1/payments/payouts)"]
        Webhooks["Webhook Ingestion & Signature Verification\n(POST /v1/notifications/verify-webhook-signature)"]
        Reconcile["Authoritative Batch Reconciliation\n(GET /v1/payments/payouts/{batch_id})"]
    end

    Workspace --> AgentUI
    AgentUI --> Gemini
    Gemini --> Tools
    Tools --> Guard
    Guard -.->|Dry-run Check / Propose| AdaptLoop
    AdaptLoop -.->|Rejection with suggestions| Gemini

    Workspace -->|Vote / Veto| Guard
    Workspace -->|Execute Payment| RowLock
    RowLock -->|Re-evaluate in EXECUTION phase| Guard
    Guard -->|APPROVED| AppendLedger
    AppendLedger -->|FUNDS_RESERVED| Payouts
    Payouts -->|Deterministic sender_batch_id| Payouts
    Payouts --> Webhooks
    Webhooks -->|Primary Key Deduplication| AppendLedger
    Reconcile -->|Idempotent Status Sync| AppendLedger
    AppendLedger --> LedgerUI
```

---

## 3. How PayPal is Central to Quorum

Quorum is architected from the ground up around PayPal's core financial and platform capabilities:

1. **Deterministic Payout Execution via PayPal Payouts API:**
   - Disburses funds to curated sandbox vendor accounts using `POST /v1/payments/payouts`.
   - Generates deterministic, idempotent batch IDs (`q_<proposal_id>_<attempt>`) preventing double-spend even across network drops, timeouts, or duplicate clicks.
2. **Authoritative Webhook Verification & Primary-Key Deduplication:**
   - Ingests all PayPal webhook events at `/api/webhooks/paypal`.
   - Verifies cryptographic signatures directly against PayPal Sandbox (`POST /v1/notifications/verify-webhook-signature`).
   - Deduplicates events via PostgreSQL `webhook_events (paypal_event_id PRIMARY KEY)` so duplicate deliveries never duplicate ledger entries.
3. **Out-of-Band Batch Reconciliation:**
   - Background and on-demand synchronization queries PayPal's `GET /v1/payments/payouts/{batch_id}`.
   - Proposals seamlessly advance from `EXECUTING` to `EXECUTED` upon PayPal confirmation without relying on external webhooks arriving in development environments.
4. **Funding Lifecycle & Partial Failure Recovery:**
   - Models multi-member contribution collection ($80.00 per member &times; 6 members = $480.00 pooled budget).
   - If an authorization capture fails (simulated via PayPal mock error headers), Quorum generates automated governance proposals (`ACCEPT_REDUCED_BUDGET` or `UNWIND_FUNDING`), giving the group collective authority to proceed with reduced funds or issue full refunds.

---

## 4. Quorum Guard Invariants & Governance Rules

Quorum enforces seven non-negotiable architectural guarantees:

| Invariant | Name | Guarantee |
|---|---|---|
| **I1** | **Policy Immutability** | No unilateral policy changes. Modifications require supermajority or unanimity. |
| **I2** | **Zero LLM Financial Power** | The AI agent can only research, rank, dry-run check, and draft proposals. It cannot vote, veto, or execute payments. |
| **I3** | **Double Evaluation Gate** | Evaluated twice: once at `PROPOSAL` draft time, and re-evaluated inside an interactive PostgreSQL transaction with a physical row lock (`SELECT ... FOR UPDATE`) at `EXECUTION` time. |
| **I4** | **Mandatory Veto Window** | Approved purchases enter a time-delayed veto window (2 minutes in demo, 24 hours in production). Any single member veto halts execution permanently. |
| **I5** | **Append-Only Financial Ledger** | Balances are computed directly from `ledger_events` (`CONTRIBUTION_CAPTURED`, `FUNDS_RESERVED`, `FUNDS_RELEASED`, `PAYOUT_SUCCEEDED`, `CONTRIBUTION_REFUNDED`). No phantom funds. |
| **I6** | **Idempotent Payouts** | Enforces partial unique database index `one_live_payment_per_proposal`. Double execute clicks produce exactly one payment and one blocked transaction. |
| **I7** | **Contributor-Only Execution** | Only active members with captured contributions can vote or trigger payout execution. Non-contributors are rejected with `GUARD_BLOCKED`. |

---

## 5. Scenario Verification Matrix (§12.2)

Every key scenario from the specification is verified automatically by the test harness (`npm run verify:scenarios`):

| Scenario | Name | Policy & Preconditions | Expected Behavior | Verification Status |
|---|---|---|---|---|
| **S1** | **Over-Cap Proposal Block** | Hard Cap = $200.00 | Agent attempts $350 4K projector; Guard returns `BLOCKED (HARD_CAP_EXCEEDED)` with max allowed suggestion ($200.00). | `PASS` |
| **S2** | **Veto in Veto Window** | $145 OptiView HD approved (4/4 votes) | Veto window opens; Elena casts `VETO`; proposal immediately halts and transitions to `VETOED`. | `PASS` |
| **S3** | **Post-Veto Adaptation & Payout** | Excludes vetoed $145 item | Agent proposes $135 portable projector; 4 approvals cast; veto window closes; Asha executes payout with PayPal batch ID. | `PASS` |
| **S4** | **Partial Funding Failure** | 5/6 member captures succeed, Farid fails | Round marks `PARTIAL_FAILURE`; Guard generates `ACCEPT_REDUCED_BUDGET` ($400) and `UNWIND_FUNDING`; unwinding records 5 refund ledger events. | `PASS` |
| **S5** | **Double Execute Protection** | Proposal in `EXECUTABLE` status | Two simultaneous execution requests execute concurrently; PostgreSQL row lock & unique index ensure exactly 1 payout and 1 blocked. | `PASS` |
| **S6** | **Duplicate Webhook Deduplication** | Webhook event with identical ID | Ingested twice; 1st processed, 2nd deduplicated via primary key and ignored with `DUPLICATE_IGNORED`. | `PASS` |
| **S7** | **Injected Payout Failure & Recovery** | Simulated definite payout failure | Payment marked `FAILED`; reserved funds released via `FUNDS_RELEASED`; proposal marked `EXECUTION_FAILED`; subsequent retry succeeds. | `PASS` |
| **S8** | **Non-Eligible Executor Block** | Unilateral execution attempt by non-contributor | Guard rejects in `EXECUTION` phase with `GUARD_BLOCKED` and reason `PROPOSER_NOT_ALLOWED` / non-contributor. | `PASS` |
| **S10** | **Unanimity Threshold Enforcement** | Amount = $180 (above $150 unanimity line) | 4 approvals cast; Guard returns `NEEDS_VOTES` (requires 6/6 unanimous approvals; veto window does not open). | `PASS` |

---

## 6. Financial Ledger (Built with AG Grid Community)

Quorum features an interactive, immutable financial and governance audit ledger built with **AG Grid Community v36** (`ag-grid-community` & `ag-grid-react`) using the Quartz theme:
- Real-time client-side filtering, quick search, and multi-column sorting.
- Visual status badges for all transaction types (`CONTRIBUTION_CAPTURED`, `FUNDS_RESERVED`, `FUNDS_RELEASED`, `PAYOUT_SUBMITTED`, `PAYOUT_SUCCEEDED`, `CONTRIBUTION_REFUNDED`).
- Deep-dive inspection modal displaying append-only audit records, formatted JSON payload metadata, and PayPal transaction/batch IDs.

---

## 7. Environment Variables Reference

| Variable | Description | Required? | Default / Example |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL connection URI (Supabase Session Pooler port 5432 or local) | **Yes** (in production) | `postgresql://postgres.[ref]:[pass]@aws-0-[region].pooler.supabase.com:5432/postgres` |
| `ALLOW_IN_MEMORY_DB` | Allows local in-memory SQLite/Postgres fallback for testing | Dev only | `"false"` |
| `PAYPAL_ENV` | PayPal environment | **Yes** | `"sandbox"` |
| `PAYPAL_CLIENT_ID` | PayPal REST App Client ID | **Yes** | Sandbox App Client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal REST App Secret | **Yes** | Sandbox App Secret |
| `PAYPAL_WEBHOOK_ID` | Registered Webhook ID from PayPal Dashboard | **Yes** (for webhooks) | `WH-xxxxxxxxxxxxxxxxx` |
| `PAYPAL_RECIPIENT_EMAIL` | Default PayPal Sandbox Personal Account for payouts | **Yes** | e.g. `sb-vendor@personal.example.com` |
| `PAYPAL_VENDOR_PROJECTOR_EMAIL` | Vendor email for projector purchases | Optional | e.g. `sb-projector@personal.example.com` |
| `PAYPAL_VENDOR_SCREEN_EMAIL` | Vendor email for screen purchases | Optional | e.g. `sb-screen@personal.example.com` |
| `PAYPAL_VENDOR_AUDIO_EMAIL` | Vendor email for audio purchases | Optional | e.g. `sb-audio@personal.example.com` |
| `GEMINI_API_KEY` | Google AI Studio API Key | **Yes** | `AIzaSy...` |
| `GEMINI_MODEL` | Gemini model identifier | Optional | `"gemini-3.8-flash"` |
| `DEMO_RESET_SECRET` | Secret token to authenticate `POST /api/demo/reset` | **Yes** | e.g. `"quorum_demo_reset_secret_key"` |
| `BASE_URL` | Application base URL | Optional | `"http://localhost:3000"` |

---

## 8. Quick Start & Setup Instructions

### Prerequisites
- Node.js v20+ (Node.js 24 supported)
- PostgreSQL (Supabase Session Pooler or local PostgreSQL)
- PayPal Sandbox Developer Account

### Local Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/Quorum.git
cd Quorum

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env and enter your PayPal Sandbox credentials, GEMINI_API_KEY, and DATABASE_URL

# 4. Run the full unit test suite (109 tests)
npm test

# 5. Run the end-to-end scenario verification harness (S1-S8, S10)
npm run verify:scenarios

# 6. Build the Next.js production bundle
npm run build

# 7. Start the server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the landing page and launch the interactive workspace.

---

## 9. Built With

- **[Next.js 14](https://nextjs.org/)** — React framework with App Router and server routes.
- **[PayPal Sandbox](https://developer.paypal.com/)** — Payouts API, Webhook Ingestion, and Signature Verification.
- **[Google Gemini](https://aistudio.google.com/)** — Structured tool-calling agent with autonomous Adapt Loop.
- **[PostgreSQL](https://www.postgresql.org/)** — Interactive row-locks (`SELECT ... FOR UPDATE`), partial unique indexes, append-only ledger, and RLS.
- **[AG Grid Community](https://www.ag-grid.com/)** — High-performance financial audit ledger table with Quartz theme.
- **[Render](https://render.com/)** — Production cloud hosting via `render.yaml` Blueprint.
- **[Tailwind CSS](https://tailwindcss.com/) & [Lucide](https://lucide.dev/)** — Clean, high-contrast, accessible UI.

---

## 10. Limitations & Hackathon Context

1. **Sandbox Environment:** All payments, authorizations, captures, and payouts execute against PayPal Sandbox. Real currency is not transferred.
2. **Evaluation Persona Switcher:** In production, member identity is authenticated via cryptographic sessions or OAuth. For hackathon evaluation, judges can switch active members (Asha, Ben, Chloe, Dev, Elena, Farid) using the avatar bar. Identity is verified against the database on every vote and execution.
3. **Seeded Demonstration Pool:** The seeded $480.00 pool represents a simulated initial contribution ledger (6 members &times; $80.00); live sandbox payouts draw against the sandbox business account balance.

---

## 11. License

MIT License. Copyright &copy; 2026 Quorum Contributors. See [LICENSE](LICENSE) for details.
