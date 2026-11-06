/**
 * Quorum API Routes Unit & Integration Tests
 * 
 * Verifies:
 * - GET /api/health
 * - POST /api/demo/reset (authentication and re-seeding)
 * - GET /api/groups/[id]/state (fund calculation, proposals, ledger)
 * - POST /api/agent/chat (agent interaction via HTTP API)
 * - POST /api/proposals/[id]/vote (member voting and veto window transition)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import { createTestDb } from '../lib/db/test-db';
import { setPool } from '../lib/db/pool';
import { GET as healthHandler } from '../app/api/health/route';
import { POST as demoResetHandler } from '../app/api/demo/reset/route';
import { GET as groupStateHandler } from '../app/api/groups/[id]/state/route';
import { POST as agentChatHandler } from '../app/api/agent/chat/route';
import { POST as voteHandler } from '../app/api/proposals/[id]/vote/route';

describe('Quorum API Route Handlers', () => {
  let pool: pg.Pool;

  beforeEach(() => {
    const testDb = createTestDb();
    pool = testDb.pool;
    setPool(pool);
    process.env.DEMO_RESET_SECRET = 'test_secret_123';
  });

  it('GET /api/health: Returns healthy status with active groups count', async () => {
    const res = await healthHandler();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('quorum-governance-agent');
    expect(data.database.status).toBe('connected');
  });

  it('POST /api/demo/reset: Rejects unauthorized request, succeeds with valid secret and seeds data', async () => {
    // 1. Unauthorized attempt
    const unauthReq = new Request('http://localhost/api/demo/reset', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong_secret' },
    });
    const unauthRes = await demoResetHandler(unauthReq);
    expect(unauthRes.status).toBe(401);

    // 2. Authorized attempt
    const authReq = new Request('http://localhost/api/demo/reset', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test_secret_123' },
    });
    const authRes = await demoResetHandler(authReq);
    expect(authRes.status).toBe(200);

    const resetData = await authRes.json();
    expect(resetData.success).toBe(true);
    expect(resetData.groupId).toBe('00000000-0000-0000-0000-000000000001');
    expect(resetData.poolBalanceCents).toBe(48000);
    expect(resetData.activeMembersCount).toBe(6);

    // 3. Verify group state via GET /api/groups/[id]/state
    const stateReq = new Request(`http://localhost/api/groups/${resetData.groupId}/state`);
    const stateRes = await groupStateHandler(stateReq, { params: { id: resetData.groupId } });
    expect(stateRes.status).toBe(200);

    const stateData = await stateRes.json();
    expect(stateData.group.name).toBe('Quorum Demo Club');
    expect(stateData.funds.capturedCents).toBe(48000);
    expect(stateData.funds.availableCents).toBe(48000);
    expect(stateData.members).toHaveLength(6);
    expect(stateData.ledger.length).toBeGreaterThanOrEqual(6);
  });

  it('POST /api/demo/reset: Refuses to seed when vendor emails are missing in production/sandbox deployment', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as any).NODE_ENV = 'production';
      delete process.env.PAYPAL_VENDOR_PROJECTOR_EMAIL;
      delete process.env.PAYPAL_VENDOR_SCREEN_EMAIL;
      delete process.env.PAYPAL_VENDOR_AUDIO_EMAIL;
      delete process.env.PAYPAL_RECIPIENT_EMAIL;

      const req = new Request('http://localhost/api/demo/reset', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test_secret_123' },
      });
      const res = await demoResetHandler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Missing vendor sandbox accounts');
    } finally {
      (process.env as any).NODE_ENV = originalEnv;
    }
  });

  it('POST /api/agent/chat: Successfully triggers Adapt Loop through API route', async () => {
    // Seed demo group first
    const resetReq = new Request('http://localhost/api/demo/reset', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test_secret_123' },
    });
    const resetRes = await demoResetHandler(resetReq);
    const { groupId } = await resetRes.json();

    // Call chat endpoint
    const chatReq = new Request('http://localhost/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId,
        message: 'I want to buy a projector for our movie nights',
      }),
    });

    const chatRes = await agentChatHandler(chatReq);
    expect(chatRes.status).toBe(200);

    const chatData = await chatRes.json();
    expect(chatData.success).toBe(true);
    expect(chatData.adaptationOccurred).toBe(true);
    expect(chatData.proposedItem.priceCents).toBe(14500); // $145.00 compliant OptiView HD
    expect(chatData.steps.length).toBeGreaterThan(0);
  });

  it('POST /api/proposals/[id]/vote: Casts votes, transitions to VETO_WINDOW, and supports veto', async () => {
    // 1. Reset demo
    const resetReq = new Request('http://localhost/api/demo/reset', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer test_secret_123' },
    });
    await demoResetHandler(resetReq);

    // 2. Run agent chat to create $145 proposal
    const chatReq = new Request('http://localhost/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '00000000-0000-0000-0000-000000000001',
        message: 'projector',
      }),
    });
    const chatRes = await agentChatHandler(chatReq);
    const chatData = await chatRes.json();
    const proposalId = chatData.proposedItem.proposalId;
    expect(proposalId).toBeDefined();

    // Members from demo reset
    const member1 = '20000000-0000-0000-0000-000000000001';
    const member2 = '20000000-0000-0000-0000-000000000002';
    const member3 = '20000000-0000-0000-0000-000000000003';
    const member4 = '20000000-0000-0000-0000-000000000004';
    const member5 = '20000000-0000-0000-0000-000000000005';

    // Vote 1, 2, 3: status remains OPEN (4 required for $145 tier)
    for (const mId of [member1, member2, member3]) {
      const vReq = new Request(`http://localhost/api/proposals/${proposalId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: mId, choice: 'APPROVE' }),
      });
      const vRes = await voteHandler(vReq, { params: { id: proposalId } });
      const vData = await vRes.json();
      expect(vData.success).toBe(true);
      expect(vData.proposalStatus).toBe('OPEN');
    }

    // Vote 4: Satisfies threshold -> moves to VETO_WINDOW!
    const v4Req = new Request(`http://localhost/api/proposals/${proposalId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: member4, choice: 'APPROVE' }),
    });
    const v4Res = await voteHandler(v4Req, { params: { id: proposalId } });
    const v4Data = await v4Res.json();
    expect(v4Data.success).toBe(true);
    expect(v4Data.proposalStatus).toBe('VETO_WINDOW');
    expect(v4Data.vetoEndsAt).toBeDefined();

    // Member 5 casts a VETO during VETO_WINDOW -> immediately halts into VETOED!
    const vetoReq = new Request(`http://localhost/api/proposals/${proposalId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: member5, choice: 'VETO' }),
    });
    const vetoRes = await voteHandler(vetoReq, { params: { id: proposalId } });
    const vetoData = await vetoRes.json();
    expect(vetoData.success).toBe(true);
    expect(vetoData.proposalStatus).toBe('VETOED');

    // Verify DB row
    const finalProp = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
    expect(finalProp.rows[0].status).toBe('VETOED');
  });
});
