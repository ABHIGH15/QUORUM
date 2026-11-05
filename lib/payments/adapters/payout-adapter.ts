/**
 * Quorum PayPal Payout Adapter
 * 
 * Implements VendorPaymentAdapter for Pooled Mode:
 * - Issues POST /v1/payments/payouts using deterministic sender_batch_id
 * - Robust duplicate-send recovery conforming to SPEC.md §8.4:
 *   When PayPal returns HTTP 400 USER_BUSINESS_ERROR with details[].field === "SENDER_BATCH_ID",
 *   the adapter follows the 'self' link to adopt the existing batch status rather than failing.
 * - Single source of truth for vendor disbursements
 */

import {
  VendorPaymentAdapter,
  PaymentExecutionParams,
  PaymentExecutionOutcome,
} from '../types';

export interface PayoutAdapterConfig {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

export class PayoutAdapter implements VendorPaymentAdapter {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(config: PayoutAdapterConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://api-m.sandbox.paypal.com';
    this.clientId = config.clientId || process.env.PAYPAL_CLIENT_ID || '';
    this.clientSecret = config.clientSecret || process.env.PAYPAL_CLIENT_SECRET || '';
  }

  /**
   * Retrieves or refreshes OAuth2 token
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now + 60000) {
      return this.cachedToken.token;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('PayPal credentials missing (PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET)');
    }

    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`PayPal OAuth request failed (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    this.cachedToken = {
      token: data.access_token,
      expiresAtMs: now + (data.expires_in || 3600) * 1000,
    };

    return this.cachedToken.token;
  }

  /**
   * Executes a payout to a vendor for an approved proposal
   */
  async executePayment(params: PaymentExecutionParams): Promise<PaymentExecutionOutcome> {
    const { groupId, proposalId, amountCents, vendorEmail, senderBatchId, attempt = 1 } = params;
    const token = await this.getAccessToken();

    const payload = {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: 'Quorum Purchase Payout',
        email_message: `Payout for approved Quorum proposal ${proposalId} (Group: ${groupId})`,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: {
            value: (amountCents / 100).toFixed(2),
            currency: 'USD',
          },
          receiver: vendorEmail,
          note: `Quorum Purchase: Proposal ${proposalId}`,
          sender_item_id: `item_${proposalId}_${attempt}`,
        },
      ],
    };

    const res = await fetch(`${this.baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json();

    // 1. Happy Path: 201 Created
    if (res.status === 201) {
      const batchHeader = body.batch_header || {};
      const batchId = batchHeader.payout_batch_id;
      const initialStatus = batchHeader.batch_status;

      return {
        status: initialStatus === 'SUCCESS' ? 'SUCCEEDED' : 'PENDING',
        batchId,
        itemId: body.items?.[0]?.payout_item_id,
        rawResponse: body,
        recoveredDuplicate: false,
      };
    }

    // 2. Idempotency Check: HTTP 400 USER_BUSINESS_ERROR for existing SENDER_BATCH_ID
    const isDuplicateBatch =
      res.status === 400 &&
      body.name === 'USER_BUSINESS_ERROR' &&
      Array.isArray(body.details) &&
      body.details.some(
        (d: any) =>
          d.field === 'SENDER_BATCH_ID' &&
          typeof d.issue === 'string' &&
          d.issue.toLowerCase().includes('already exists')
      );

    if (isDuplicateBatch) {
      // Follow the 'self' link in the duplicate rejection response to adopt the existing batch
      const selfLink = body.links?.find((l: any) => l.rel === 'self')?.href;
      if (selfLink) {
        const batchRes = await fetch(selfLink, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (batchRes.ok) {
          const existingBatch = await batchRes.json();
          const batchHeader = existingBatch.batch_header || {};
          const batchStatus = batchHeader.batch_status;

          return {
            status: batchStatus === 'SUCCESS' ? 'SUCCEEDED' : 'PENDING',
            batchId: batchHeader.payout_batch_id,
            itemId: existingBatch.items?.[0]?.payout_item_id,
            rawResponse: existingBatch,
            recoveredDuplicate: true,
          };
        }
      }

      // If self link not found or query fails, extract batch ID from URL if present
      return {
        status: 'PENDING',
        batchId: senderBatchId,
        rawResponse: body,
        recoveredDuplicate: true,
      };
    }

    // 3. Other PayPal API Failure
    throw new Error(
      `PayPal Payout failed (HTTP ${res.status}): ${body.message || body.name || JSON.stringify(body)}`
    );
  }
}
