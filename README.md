# Quorum — Deterministic AI Group Purchasing & Governance Agent

> **PayPal AI Hackathon 2026 Submission**  
> **Core Promise:** *No individual member can independently authorize a purchase. Every spend must satisfy the group's agreed policy and approval requirements.*

---

## 1. Overview

**Quorum** is an autonomous group purchasing and collective decision-making platform powered by PayPal Sandbox. When groups of individuals (clubs, co-ops, project teams, shared households) want to pool money and make purchases together, traditional shared accounts fail: one rogue administrator can drain the balance, or tedious manual approvals stall purchases.

Quorum introduces **Quorum Guard**: a 100% deterministic, zero-LLM governance engine that enforces agreed policies, multi-signature approval tiers, spending caps, and veto windows before a single cent can be disbursed.

Quorum operates primarily in **Pooled Mode**, where member contributions are collected into a platform sandbox account, and payouts are executed deterministically via PayPal Payouts with idempotency protections.

---

## 2. Architecture & Invariants

```
             +-----------------------------------------------+
             |              Next.js 14 Web UI                |
             |       Workspace • "Why?" Decision Modal       |
             +-----------------------+-----------------------+
                                     | HTTP / Web API
                                     v
             +-----------------------------------------------+
             |              API & Application Layer          |
             |      Health • Webhooks • Proposals • Votes    |
             +----------+-----------------------+------------+
                        |                       |
                        v                       v
        +-----------------------------+   +----------------------------+
        |   Gemini AI Agent (LLM)     |   |      Voting Engine         |
        |  search, compare, propose   |   |   votes, vetoes, proposals |
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
                                         v
                         [PayPal Payouts API (Sandbox)]
```

### Non-Negotiable Invariants:
1. **Zero Financial Superpowers for LLM (I2):** The AI Agent can only research and propose. It has zero capability to cast votes, register vetoes, modify policy, or trigger payments.
2. **Double Evaluation Gate (I3):** Quorum Guard evaluates twice: once in `PROPOSAL` phase to block non-compliant items before voting, and again in `EXECUTION` phase inside an interactive PostgreSQL transaction with a physical row lock (`SELECT ... FOR UPDATE SKIP LOCKED`).
3. **The Adapt Loop (§9.3):** When Quorum Guard blocks an item (e.g. S1: $350 4K projector over the $200 hard cap), the proposal is saved as a visible `BLOCKED` proposal in the database for transparency. The agent automatically adapts to search within Guard's suggested limit ($200) and submits a compliant alternative ($145 OptiView HD).
4. **Veto Window (I4):** High-value purchases enter a time-delayed veto window. Any single contributing member can veto and halt execution. If votes fall below the threshold, the window is cancelled.
5. **Idempotent Payouts (I6):** Deterministic `sender_batch_id` formatted as `q_<proposal_id>_<attempt>` prevents duplicate payments. Ambiguous failures (timeouts, network drops) keep funds reserved and retry with the same batch ID.

---

## 3. Gemini Model Specification

- **Default Model:** `gemini-3.8-flash` (or `gemini-flash-latest`).
- **Configurable via Environment:** `GEMINI_MODEL=gemini-3.8-flash`.
- **Structured Tool Calling:** Uses Google Generative Language REST API with 5 tool declarations: `get_group_state`, `search_options`, `compare_options`, `create_proposal`, `explain_decision`.
- **Judge Resilience / Rate Limit Protection:** On Google AI Studio free tier, if rate limits (HTTP 429) are encountered, Quorum catches the error and plays back a verified deterministic Adapt Loop demonstration trace so judging is never blocked.

---

## 4. Demo Persona Switcher & Identity Notice

> **Important Note for Evaluators:**  
> In production, member identity is authenticated via cryptographic web sessions or OAuth. For the hackathon evaluation workspace, a demo persona switcher allows judges to experience different member perspectives (e.g., Chair Asha, Member Ben, Member Chloe).  
> The API extracts member identity from the `quorum_member_id` session cookie or `x-quorum-member-id` header. On every vote and payment execution, the backend strictly verifies that the persona is an active contributing member with captured funds in the database.

---

## 5. Live REST API Endpoints

- `GET /api/health`: Database ping, uptime, and lazy tick evaluation trigger (§8.7).
- `POST /api/webhooks/paypal`: Ingests and verifies PayPal webhooks with atomic deduplication.
- `POST /api/agent/chat`: Conversational agent interface with automatic Adapt Loop.
- `POST /api/proposals/[id]/vote`: Records member vote/veto, opens veto window, or halts on veto.
- `POST /api/proposals/[id]/execute`: Executes PayPal payout inside interactive PostgreSQL row lock.
- `GET /api/groups/[id]/state`: Returns complete group overview, policy, members, and ledger.
- `POST /api/demo/reset`: Resets database state and re-seeds $480 active group with 6 contributors (protected by `DEMO_RESET_SECRET`).

---

## 6. Quick Start & Verification

### Prerequisites
- Node.js v20+ (Node 24 supported)
- PostgreSQL (Supabase Session Pooler or local Postgres)
- PayPal Sandbox Business Account credentials

### Setup
```bash
# Clone the repository
git clone <repo-url>
cd Quorum

# Install dependencies
npm install

# Configure environment variables (.env)
cp .env.example .env
# Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GEMINI_API_KEY, DATABASE_URL, DEMO_RESET_SECRET

# Run the 100-test automated test suite
npm test

# Run the live Gemini 3.8 Flash agent verification
npm run test:gemini

# Run real PostgreSQL concurrency test (with DATABASE_URL)
npm run test:real-postgres

# Build the Next.js production bundle
npm run build

# Start the web server
npm start
```

---

## 7. License

MIT License. Copyright (c) 2026 Quorum Contributors.
