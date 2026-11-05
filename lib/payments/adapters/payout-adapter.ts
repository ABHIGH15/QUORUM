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
  DefinitePaymentFailure,
  AmbiguousPaymentFailure,
} from '../types';

export interface PayoutAdapterConfig {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

export class PayoutAdapter implements VendorPaymentAdapter {
  private baseUrl: string;
  private clientId: string;
  private clientSecret: string;
  private timeoutMs: number;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(config: PayoutAdapterConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://api-m.sandbox.paypal.com';
    this.clientId = config.clientId || process.env.PAYPAL_CLIENT_ID || '';
    this.clientSecret = config.clientSecret || process.env.PAYPAL_CLIENT_SECRET || '';
    this.timeoutMs = config.timeoutMs || 15000;
  }

  /**
   * Helper to perform fetch with AbortController timeout
   */
  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        throw new AmbiguousPaymentFailure(
          `PayPal request timed out after ${this.timeoutMs}ms`,
          'REQUEST_TIMEOUT'
        );
      }
      throw new AmbiguousPaymentFailure(
        `PayPal network error: ${err.message}`,
        'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timeoutId);
    }
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
      throw new DefinitePaymentFailure(
        'PayPal credentials missing (PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET)',
        'MISSING_CREDENTIALS'
      );
    }

    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (err: any) {
      if (err instanceof AmbiguousPaymentFailure || err instanceof DefinitePaymentFailure) {
        throw err;
      }
      throw new AmbiguousPaymentFailure(`OAuth network error: ${err.message}`, 'OAUTH_NETWORK_ERROR');
    }

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new DefinitePaymentFailure(
          `PayPal OAuth unauthorized (HTTP ${res.status}): ${errText}`,
          'AUTH_UNAUTHORIZED'
        );
      }
      if (res.status >= 500) {
        throw new AmbiguousPaymentFailure(
          `PayPal OAuth server error (HTTP ${res.status}): ${errText}`,
          'AUTH_SERVER_ERROR'
        );
      }
      throw new DefinitePaymentFailure(
        `PayPal OAuth failed (HTTP ${res.status}): ${errText}`,
        'AUTH_FAILED'
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch (parseErr: any) {
      throw new AmbiguousPaymentFailure(
        `PayPal OAuth returned invalid JSON: ${parseErr.message}`,
        'UNPARSEABLE_RESPONSE'
      );
    }

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

    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let body: any;
    try {
      body = await res.json();
    } catch (parseErr: any) {
      throw new AmbiguousPaymentFailure(
        `PayPal returned unparseable response (HTTP ${res.status}): ${parseErr.message}`,
        'UNPARSEABLE_RESPONSE'
      );
    }

    // 1. Happy Path: 201 Created
    if (res.status === 201) {
      const batchHeader = body.batch_header || {};
      const batchId = batchHeader.payout_batch_id;
      const initialStatus = batchHeader.batch_status;

      // Handle definite batch-level rejection
      if (initialStatus === 'DENIED' || initialStatus === 'CANCELED') {
        throw new DefinitePaymentFailure(
          `PayPal payout batch was ${initialStatus}: ${body.message || ''}`,
          initialStatus,
          body
        );
      }

      return {
        status: initialStatus === 'SUCCESS' ? 'SUCCEEDED' : 'PENDING',
        batchId,
        itemId: body.items?.[0]?.payout_item_id,
        rawResponse: body,
        recoveredDuplicate: false,
      };
    }

    // 2. Server Error (5xx) -> Ambiguous (PayPal may or may not have processed it)
    if (res.status >= 500) {
      throw new AmbiguousPaymentFailure(
        `PayPal server error (HTTP ${res.status}): ${body.message || body.name || JSON.stringify(body)}`,
        'PAYPAL_5XX',
        body
      );
    }

    // 3. Idempotency Check: HTTP 400 USER_BUSINESS_ERROR for existing SENDER_BATCH_ID
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
      if (!selfLink) {
        throw new AmbiguousPaymentFailure(
          `Duplicate batch reported by PayPal for ${senderBatchId}, but response contained no self link to inspect existing batch`,
          'DUPLICATE_NO_SELF_LINK',
          body
        );
      }

      let batchRes: Response;
      try {
        batchRes = await this.fetchWithTimeout(selfLink, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (selfErr: any) {
        throw new AmbiguousPaymentFailure(
          `Duplicate batch reported by PayPal for ${senderBatchId}, but lookup via self link failed: ${selfErr.message}`,
          'DUPLICATE_LOOKUP_FAILED'
        );
      }

      if (!batchRes.ok) {
        throw new AmbiguousPaymentFailure(
          `Duplicate batch lookup via self link returned HTTP ${batchRes.status}`,
          'DUPLICATE_LOOKUP_HTTP_ERROR'
        );
      }

      let existingBatch: any;
      try {
        existingBatch = await batchRes.json();
      } catch (parseErr: any) {
        throw new AmbiguousPaymentFailure(
          `Duplicate batch lookup returned unparseable JSON`,
          'UNPARSEABLE_RESPONSE'
        );
      }

      const batchHeader = existingBatch.batch_header || {};
      const batchStatus = batchHeader.batch_status;
      const itemStatus = existingBatch.items?.[0]?.transaction_status;

      if (batchStatus === 'DENIED' || batchStatus === 'CANCELED') {
        throw new DefinitePaymentFailure(
          `Existing payout batch was ${batchStatus}`,
          batchStatus,
          existingBatch
        );
      }

      if (itemStatus === 'FAILED' || itemStatus === 'BLOCKED' || itemStatus === 'RETURNED') {
        throw new DefinitePaymentFailure(
          `Existing payout item status is ${itemStatus}`,
          itemStatus,
          existingBatch
        );
      }

      if (itemStatus === 'UNCLAIMED') {
        return {
          status: 'UNCLAIMED',
          batchId: batchHeader.payout_batch_id,
          itemId: existingBatch.items?.[0]?.payout_item_id,
          rawResponse: existingBatch,
          recoveredDuplicate: true,
        };
      }

      const isSucceeded = batchStatus === 'SUCCESS' || itemStatus === 'SUCCESS';
      return {
        status: isSucceeded ? 'SUCCEEDED' : 'PENDING',
        batchId: batchHeader.payout_batch_id,
        itemId: existingBatch.items?.[0]?.payout_item_id,
        rawResponse: existingBatch,
        recoveredDuplicate: true,
      };
    }

    // 4. Other 4xx Client / Business Error -> Definite Failure
    if (res.status === 401 || res.status === 403) {
      throw new DefinitePaymentFailure(
        `PayPal authentication failed (HTTP ${res.status}): ${body.message || body.name || JSON.stringify(body)}`,
        'AUTH_ERROR',
        body
      );
    }

    throw new DefinitePaymentFailure(
      `PayPal rejected payout request (HTTP ${res.status}): ${body.message || body.name || JSON.stringify(body)}`,
      body.name || 'BUSINESS_ERROR',
      body
    );
  }
}
}
