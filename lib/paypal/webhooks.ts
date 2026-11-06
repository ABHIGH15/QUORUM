/**
 * Quorum PayPal Webhook Verification & Event Processor (§8.5)
 * 
 * Invariants:
 * 1. Signature Verification via PayPal API POST /v1/notifications/verify-webhook-signature
 * 2. Deduplication via PostgreSQL webhook_events (paypal_event_id PRIMARY KEY)
 * 3. Atomic state transitions & append-only ledger entries inside withTransaction
 */

import pg from 'pg';
import { withTransaction } from '../db/pool';

export interface WebhookHeaders {
  'paypal-auth-algo'?: string;
  'paypal-cert-url'?: string;
  'paypal-transmission-id'?: string;
  'paypal-transmission-sig'?: string;
  'paypal-transmission-time'?: string;
}

export interface WebhookVerificationParams {
  baseUrl?: string;
  token: string;
  webhookId: string;
  headers: WebhookHeaders;
  body: any; // Raw JSON string or parsed object
}

export interface WebhookVerificationResult {
  verified: boolean;
  status: 'SUCCESS' | 'FAILURE';
  error?: string;
}

/**
 * Verifies PayPal webhook signature against PayPal Sandbox API
 */
export async function verifyWebhookSignature(
  params: WebhookVerificationParams
): Promise<WebhookVerificationResult> {
  const { baseUrl = 'https://api-m.sandbox.paypal.com', token, webhookId, headers, body } = params;

  const authAlgo = headers['paypal-auth-algo'];
  const certUrl = headers['paypal-cert-url'];
  const transmissionId = headers['paypal-transmission-id'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const transmissionTime = headers['paypal-transmission-time'];

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !webhookId) {
    return {
      verified: false,
      status: 'FAILURE',
      error: 'Missing required PayPal signature headers or webhook ID',
    };
  }

  // Ensure webhook_event is valid object
  const webhookEvent = typeof body === 'string' ? JSON.parse(body) : body;

  const payload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: webhookEvent,
  };

  try {
    const res = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        verified: false,
        status: 'FAILURE',
        error: `PayPal verification request returned HTTP ${res.status}: ${errText}`,
      };
    }

    const data = await res.json();
    const isSuccess = data.verification_status === 'SUCCESS';

    return {
      verified: isSuccess,
      status: isSuccess ? 'SUCCESS' : 'FAILURE',
    };
  } catch (err: any) {
    return {
      verified: false,
      status: 'FAILURE',
      error: `Network error verifying webhook: ${err.message}`,
    };
  }
}

export interface ProcessWebhookResult {
  processed: boolean;
  duplicate: boolean;
  eventType: string;
  paypalEventId: string;
  actionTaken?: string;
}

/**
 * Ingests and processes a verified PayPal webhook event with strict deduplication
 */
export async function processWebhookEvent(params: {
  pool: pg.Pool;
  event: any;
  verified?: boolean;
}): Promise<ProcessWebhookResult> {
  const { pool, event, verified = true } = params;
  const eventId = event.id;
  const eventType = event.event_type;

  if (!eventId || !eventType) {
    throw new Error('Invalid webhook event payload: missing id or event_type');
  }

  return await withTransaction(pool, async (client) => {
    // 1. Deduplication check
    const existing = await client.query(
      `SELECT paypal_event_id FROM webhook_events WHERE paypal_event_id = $1`,
      [eventId]
    );

    if (existing.rows.length > 0) {
      // Event has already been ingested and processed
      return {
        processed: false,
        duplicate: true,
        eventType,
        paypalEventId: eventId,
        actionTaken: 'DUPLICATE_IGNORED',
      };
    }

    await client.query(
      `INSERT INTO webhook_events (paypal_event_id, event_type, verified, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (paypal_event_id) DO NOTHING`,
      [eventId, eventType, verified, JSON.stringify(event)]
    );

    let actionTaken = 'NONE';
    const resource = event.resource || {};

    // 2. Dispatch based on event type
    switch (eventType) {
      case 'PAYMENT.PAYOUTSBATCH.SUCCESS': {
        const batchId = resource.batch_header?.payout_batch_id;
        if (batchId) {
          const paymentRes = await client.query(
            `SELECT id, group_id, proposal_id, amount_cents, status FROM payments 
             WHERE paypal_batch_id = $1 OR sender_batch_id = $2`,
            [batchId, resource.batch_header?.sender_batch_id || batchId]
          );

          if (paymentRes.rows.length > 0) {
            const p = paymentRes.rows[0];
            if (p.status !== 'SUCCEEDED') {
              await client.query(
                `UPDATE payments SET status = 'SUCCEEDED', updated_at = NOW() WHERE id = $1`,
                [p.id]
              );
              await client.query(
                `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
                 VALUES ($1, 'PAYOUT_SUCCEEDED', 'PAYPAL', 'PAYMENT', $2, $3, $4)`,
                [p.group_id, p.id, p.amount_cents, JSON.stringify({ webhook_event_id: eventId, batch_id: batchId })]
              );
              // Release reservation so netReserved is zeroed out
              await client.query(
                `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
                 VALUES ($1, 'FUNDS_RELEASED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
                [p.group_id, p.id, p.amount_cents, JSON.stringify({ reason: 'PAYOUT_SUCCEEDED', payment_id: p.id })]
              );
              await client.query(
                `UPDATE proposals SET status = 'EXECUTED' WHERE id = $1`,
                [p.proposal_id]
              );
              actionTaken = 'PAYMENT_SUCCEEDED_AND_PROPOSAL_EXECUTED';
            }
          }
        }
        break;
      }

      case 'PAYMENT.PAYOUTSBATCH.DENIED': {
        const batchId = resource.batch_header?.payout_batch_id;
        if (batchId) {
          const paymentRes = await client.query(
            `SELECT id, group_id, proposal_id, amount_cents, status FROM payments 
             WHERE paypal_batch_id = $1 OR sender_batch_id = $2`,
            [batchId, resource.batch_header?.sender_batch_id || batchId]
          );

          if (paymentRes.rows.length > 0) {
            const p = paymentRes.rows[0];
            await client.query(
              `UPDATE payments SET status = 'FAILED', error_code = 'PAYOUT_BATCH_DENIED', updated_at = NOW() WHERE id = $1`,
              [p.id]
            );
            await client.query(
              `INSERT INTO ledger_events (group_id, type, actor_kind, ref_type, ref_id, amount_cents, data)
               VALUES ($1, 'FUNDS_RELEASED', 'SYSTEM', 'PAYMENT', $2, $3, $4)`,
              [p.group_id, p.id, p.amount_cents, JSON.stringify({ reason: 'PAYOUT_DENIED', webhook_event_id: eventId })]
            );
            await client.query(
              `UPDATE proposals SET status = 'EXECUTION_FAILED' WHERE id = $1`,
              [p.proposal_id]
            );
            actionTaken = 'PAYMENT_FAILED_AND_FUNDS_RELEASED';
          }
        }
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': {
        const itemId = resource.payout_item_id;
        const batchId = resource.payout_batch_id;
        if (itemId || batchId) {
          await client.query(
            `UPDATE payments SET status = 'UNCLAIMED', updated_at = NOW()
             WHERE paypal_item_id = $1 OR paypal_batch_id = $2`,
            [itemId, batchId]
          );
          actionTaken = 'PAYMENT_MARKED_UNCLAIMED';
        }
        break;
      }

      case 'PAYMENT.CAPTURE.COMPLETED': {
        const captureId = resource.id;
        const customId = resource.custom_id; // contributionId
        const amountCents = Math.round(parseFloat(resource.amount?.value || '0') * 100);

        if (customId) {
          await client.query(
            `UPDATE contributions SET status = 'CAPTURED', capture_id = $1 WHERE id = $2`,
            [captureId, customId]
          );
          actionTaken = 'CONTRIBUTION_CAPTURED';
        }
        break;
      }

      case 'PAYMENT.CAPTURE.REFUNDED': {
        const captureId = resource.id;
        const customId = resource.custom_id;

        if (customId) {
          await client.query(
            `UPDATE contributions SET status = 'REFUNDED' WHERE id = $1`,
            [customId]
          );
          actionTaken = 'CONTRIBUTION_REFUNDED';
        }
        break;
      }

      case 'PAYMENT.AUTHORIZATION.VOIDED': {
        const authId = resource.id;
        const customId = resource.custom_id;

        if (customId) {
          await client.query(
            `UPDATE contributions SET status = 'VOIDED' WHERE id = $1`,
            [customId]
          );
          actionTaken = 'CONTRIBUTION_VOIDED';
        }
        break;
      }

      default:
        actionTaken = `UNHANDLED_EVENT_TYPE_${eventType}`;
        break;
    }

    // 3. Mark processed_at
    await client.query(
      `UPDATE webhook_events SET processed_at = NOW() WHERE paypal_event_id = $1`,
      [eventId]
    );

    return {
      processed: true,
      duplicate: false,
      eventType,
      paypalEventId: eventId,
      actionTaken,
    };
  });
}
