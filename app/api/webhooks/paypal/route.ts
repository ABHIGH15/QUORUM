import { getPool } from '@/lib/db/pool';
import { getPayPalAccessToken } from '@/lib/paypal/auth';
import { verifyWebhookSignature, processWebhookEvent, WebhookHeaders } from '@/lib/paypal/webhooks';

/**
 * Live PayPal Webhook Ingestion Route (§8.3)
 * 
 * Invariants:
 * 1. Reads raw body string to preserve exact transmission byte sequence for signature validation.
 * 2. Verifies cryptographic signature against PayPal's notifications API.
 * 3. Commits event record and business state update atomically in the SAME transaction.
 * 4. Deduplicates identical events on webhook_events(paypal_event_id).
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    const headers: WebhookHeaders = {
      'paypal-auth-algo': request.headers.get('paypal-auth-algo') || undefined,
      'paypal-cert-url': request.headers.get('paypal-cert-url') || undefined,
      'paypal-transmission-id': request.headers.get('paypal-transmission-id') || undefined,
      'paypal-transmission-sig': request.headers.get('paypal-transmission-sig') || undefined,
      'paypal-transmission-time': request.headers.get('paypal-transmission-time') || undefined,
    };

    // If live webhook ID is configured, verify signature
    if (webhookId) {
      const token = await getPayPalAccessToken();
      const verification = await verifyWebhookSignature({
        token,
        webhookId,
        headers,
        body: rawBody,
      });

      if (!verification.verified) {
        console.warn('[PayPal Webhook] Signature verification failed:', verification.error);
        return Response.json(
          { error: 'Invalid PayPal webhook signature', details: verification.error },
          { status: 400 }
        );
      }
    }

    const event = JSON.parse(rawBody);
    const pool = getPool();
    const result = await processWebhookEvent(pool, event);

    return Response.json({
      status: result.status,
      action: result.action,
      eventId: result.eventId,
      eventType: result.eventType,
    });
  } catch (err: any) {
    console.error('[PayPal Webhook Error]', err);
    return Response.json(
      { error: err.message || 'Webhook processing failed' },
      { status: 500 }
    );
  }
}
