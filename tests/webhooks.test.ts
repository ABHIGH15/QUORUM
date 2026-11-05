/**
 * Quorum PayPal Webhooks & Deduplication Unit Tests (§8.5)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { createTestDb } from '../lib/db/test-db';
import { verifyWebhookSignature, processWebhookEvent } from '../lib/paypal/webhooks';

describe('PayPal Webhook Ingestion & Deduplication', () => {
  let pool: pg.Pool;

  const testGroupId = '22222222-2222-2222-2222-222222222222';
  const testProposalId = '33333333-3333-3333-3333-333333333333';
  const testBatchId = 'BATCH_WEBHOOK_123';

  beforeEach(async () => {
    const testDb = createTestDb();
    pool = testDb.pool;

    // Seed User
    const userId = '11111111-1111-1111-1111-111111111101';
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1, 'Asha')`,
      [userId]
    );

    // Seed Group
    await pool.query(
      `INSERT INTO groups (id, name, mode, status, created_by)
       VALUES ($1, 'Club', 'POOLED', 'ACTIVE', $2)`,
      [testGroupId, userId]
    );

    // Seed Proposal
    await pool.query(
      `INSERT INTO proposals (
        id, group_id, type, status, created_by_kind, policy_version,
        amount_cents, payload
       ) VALUES (
        $1, $2, 'PURCHASE', 'EXECUTING', 'AGENT', 1, 14500, '{}'
       )`,
      [testProposalId, testGroupId]
    );

    // Seed Payment in PENDING status with paypal_batch_id
    await pool.query(
      `INSERT INTO payments (
        group_id, proposal_id, kind, status, amount_cents, sender_batch_id, paypal_batch_id
       ) VALUES (
        $1, $2, 'PAYOUT', 'PENDING', 14500, 'q_33333333-3333-3333-3333-333333333333_1', $3
       )`,
      [testGroupId, testProposalId, testBatchId]
    );

    // Seed initial FUNDS_RESERVED in ledger
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, amount_cents)
       VALUES ($1, 'FUNDS_RESERVED', 'SYSTEM', 14500)`,
      [testGroupId]
    );
  });

  describe('verifyWebhookSignature', () => {
    it('Fails verification when required PayPal signature headers are missing', async () => {
      const result = await verifyWebhookSignature({
        token: 'fake_token',
        webhookId: 'WH-12345',
        headers: {},
        body: { id: 'WH-EVENT-1' },
      });

      expect(result.verified).toBe(false);
      expect(result.status).toBe('FAILURE');
      expect(result.error).toContain('Missing required PayPal signature headers');
    });

    it('Calls PayPal verify-webhook-signature and returns SUCCESS when verified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ verification_status: 'SUCCESS' }),
      });
      global.fetch = mockFetch;

      const result = await verifyWebhookSignature({
        baseUrl: 'https://api-m.sandbox.paypal.com',
        token: 'valid_oauth_token',
        webhookId: 'WH-12345',
        headers: {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
          'paypal-transmission-id': 'trans-123',
          'paypal-transmission-sig': 'sig-xyz',
          'paypal-transmission-time': '2026-11-06T00:00:00Z',
        },
        body: { id: 'WH-EVENT-1', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS' },
      });

      expect(result.verified).toBe(true);
      expect(result.status).toBe('SUCCESS');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('processWebhookEvent & Deduplication', () => {
    it('S6 Scenario: Deduplicates identical webhook events via primary key', async () => {
      const eventPayload = {
        id: 'WH-EVENT-DUP-1',
        event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
        resource: {
          batch_header: {
            payout_batch_id: testBatchId,
          },
        },
      };

      // Delivery 1: Ingests and processes
      const result1 = await processWebhookEvent({
        pool,
        event: eventPayload,
        verified: true,
      });

      expect(result1.processed).toBe(true);
      expect(result1.duplicate).toBe(false);
      expect(result1.actionTaken).toBe('PAYMENT_SUCCEEDED_AND_PROPOSAL_EXECUTED');

      // Delivery 2: Exact same event delivered again
      const result2 = await processWebhookEvent({
        pool,
        event: eventPayload,
        verified: true,
      });

      expect(result2.processed).toBe(false);
      expect(result2.duplicate).toBe(true);
      expect(result2.actionTaken).toBe('DUPLICATE_IGNORED');

      // Verify DB has exactly 1 webhook_event recorded
      const webhookRows = await pool.query(
        `SELECT * FROM webhook_events WHERE paypal_event_id = $1`,
        ['WH-EVENT-DUP-1']
      );
      expect(webhookRows.rows).toHaveLength(1);

      // Verify ledger has exactly 1 PAYOUT_SUCCEEDED (not 2!)
      const ledgerRows = await pool.query(
        `SELECT * FROM ledger_events WHERE group_id = $1 AND type = 'PAYOUT_SUCCEEDED'`,
        [testGroupId]
      );
      expect(ledgerRows.rows).toHaveLength(1);
    });

    it('PAYMENT.PAYOUTSBATCH.SUCCESS: Updates payment SUCCEEDED, proposal EXECUTED, and releases reservation', async () => {
      const eventPayload = {
        id: 'WH-EVENT-SUCCESS-1',
        event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
        resource: {
          batch_header: {
            payout_batch_id: testBatchId,
          },
        },
      };

      const result = await processWebhookEvent({
        pool,
        event: eventPayload,
      });

      expect(result.processed).toBe(true);

      // Payment is SUCCEEDED
      const paymentRes = await pool.query(`SELECT status FROM payments WHERE paypal_batch_id = $1`, [testBatchId]);
      expect(paymentRes.rows[0].status).toBe('SUCCEEDED');

      // Proposal is EXECUTED
      const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
      expect(propRes.rows[0].status).toBe('EXECUTED');

      // Ledger has both PAYOUT_SUCCEEDED and FUNDS_RELEASED
      const ledgerRes = await pool.query(
        `SELECT type FROM ledger_events WHERE group_id = $1 ORDER BY id ASC`,
        [testGroupId]
      );
      const types = ledgerRes.rows.map((r) => r.type);
      expect(types).toContain('PAYOUT_SUCCEEDED');
      expect(types).toContain('FUNDS_RELEASED');
    });

    it('PAYMENT.PAYOUTSBATCH.DENIED: Updates payment FAILED, proposal EXECUTION_FAILED, and releases reservation', async () => {
      const eventPayload = {
        id: 'WH-EVENT-DENIED-1',
        event_type: 'PAYMENT.PAYOUTSBATCH.DENIED',
        resource: {
          batch_header: {
            payout_batch_id: testBatchId,
          },
        },
      };

      const result = await processWebhookEvent({
        pool,
        event: eventPayload,
      });

      expect(result.processed).toBe(true);

      // Payment is FAILED
      const paymentRes = await pool.query(`SELECT status, error_code FROM payments WHERE paypal_batch_id = $1`, [testBatchId]);
      expect(paymentRes.rows[0].status).toBe('FAILED');
      expect(paymentRes.rows[0].error_code).toBe('PAYOUT_BATCH_DENIED');

      // Proposal is EXECUTION_FAILED
      const propRes = await pool.query(`SELECT status FROM proposals WHERE id = $1`, [testProposalId]);
      expect(propRes.rows[0].status).toBe('EXECUTION_FAILED');

      // Ledger has FUNDS_RELEASED
      const ledgerRes = await pool.query(
        `SELECT type FROM ledger_events WHERE group_id = $1 AND type = 'FUNDS_RELEASED'`,
        [testGroupId]
      );
      expect(ledgerRes.rows).toHaveLength(1);
    });
  });
});
