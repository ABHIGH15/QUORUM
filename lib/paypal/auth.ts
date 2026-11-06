/**
 * Quorum PayPal Authentication Helper
 * 
 * Provides OAuth2 Client Credentials token generation with in-memory caching.
 */

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getPayPalAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.token;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET environment variable is missing.');
  }

  const isSandbox = (process.env.PAYPAL_ENV || 'sandbox') !== 'production';
  const baseUrl = isSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal OAuth token generation failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresInSeconds = data.expires_in || 3600;

  cachedToken = {
    token,
    expiresAt: now + expiresInSeconds * 1000,
  };

  return token;
}
