#!/usr/bin/env node

/**
 * Quorum First-Hop PayPal Sandbox Probe
 * 
 * Verifies:
 * 1. POST /v2/checkout/orders with intent: "AUTHORIZE" and custom_id
 * 2. Buyer Sandbox Approval (interactive browser step)
 * 3. POST /v2/checkout/orders/{id}/authorize (with PayPal-Request-Id: auth_<id>)
 * 4. POST /v2/payments/authorizations/{id}/capture (with PayPal-Request-Id: cap_<id>_<attempt>)
 * 5. POST /v2/payments/captures/{id}/refund (with PayPal-Request-Id: ref_<id>)
 * 6. (Optional --void): POST /v2/payments/authorizations/{id}/void
 * 7. (Optional --mock-failure): Test mock capture rejection to inspect exact error body
 * 
 * Usage:
 *   node scripts/test-first-hop.mjs
 *   node scripts/test-first-hop.mjs --void
 *   node scripts/test-first-hop.mjs --mock-failure
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Safe minimal .env loader (never prints or exposes values)
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env or environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const IS_VOID_TEST = args.includes('--void');
const IS_MOCK_FAILURE_TEST = args.includes('--mock-failure');

async function getOAuthToken() {
  console.log('\n--- Step 1: Getting OAuth2 Sandbox Token ---');
  const authHeader = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`\n❌ OAuth token request failed with HTTP ${res.status}:`);
    console.error(text);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`✓ OAuth token acquired (expires in ${data.expires_in}s)`);
  return data.access_token;
}

async function createAuthorizationOrder(token, contributionId, amountCents = 100) {
  console.log('\n--- Step 2: Creating Order with intent: "AUTHORIZE" ---');
  const amountStr = (amountCents / 100).toFixed(2);
  const requestId = `ord_${contributionId}`;

  console.log(`• Contribution ID: ${contributionId}`);
  console.log(`• Amount: $${amountStr} USD`);
  console.log(`• PayPal-Request-Id: ${requestId}`);

  const payload = {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: contributionId,
        custom_id: contributionId,
        description: `Quorum Member Contribution (${contributionId})`,
        amount: {
          currency_code: 'USD',
          value: amountStr,
        },
      },
    ],
    application_context: {
      brand_name: 'Quorum Sandbox',
      user_action: 'CONTINUE',
      return_url: 'https://example.com/return',
      cancel_url: 'https://example.com/cancel',
    },
  };

  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error(`\n❌ Create Order failed with HTTP ${res.status}:`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`✓ Order Created: ID = ${body.id}, Status = ${body.status}`);
  const approveLink = body.links?.find((l) => l.rel === 'approve')?.href;
  return { orderId: body.id, approveUrl: approveLink };
}

async function checkOrderStatus(token, orderId) {
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.status;
}

async function waitForBuyerApproval(token, orderId, approveUrl) {
  console.log('\n=============================================================');
  console.log('👉 ACTION REQUIRED: APPROVE ORDER IN BROWSER');
  console.log('=============================================================');
  console.log(`\nOpen the following link in your browser:`);
  console.log(`\n   \x1b[36m\x1b[4m${approveUrl}\x1b[0m\n`);
  console.log('1. Log in with your US Sandbox Personal Account');
  console.log('2. Click "Continue" / "Review Order"');
  console.log('3. (Optional) You can press [Enter] here once approved, or simply');
  console.log('   wait as this script automatically polls for status: APPROVED...\n');

  let approved = false;

  // Set up readline for manual enter trigger
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const enterPromise = new Promise((resolve) => {
    rl.question('Press [Enter] when approved in browser (or wait for auto-poll)... ', () => {
      rl.close();
      resolve();
    });
  });

  // Polling loop (every 3 seconds for up to 5 minutes)
  const maxAttempts = 100;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    process.stdout.write(`\r⏳ Polling order status (attempt ${attempt}/${maxAttempts})... `);
    const status = await checkOrderStatus(token, orderId);
    if (status === 'APPROVED') {
      console.log(`\n\n✅ Order is APPROVED by buyer!`);
      approved = true;
      rl.close();
      break;
    }

    // Wait 3000ms or until enter key
    await Promise.race([
      new Promise((r) => setTimeout(r, 3000)),
      enterPromise,
    ]);

    const checkNow = await checkOrderStatus(token, orderId);
    if (checkNow === 'APPROVED') {
      console.log(`\n\n✅ Order is APPROVED by buyer!`);
      approved = true;
      break;
    }
  }

  if (!approved) {
    console.error('\n❌ Timed out waiting for buyer approval.');
    process.exit(1);
  }
}

async function authorizeOrder(token, orderId, contributionId) {
  console.log('\n--- Step 3: Authorizing the Approved Order ---');
  const requestId = `auth_${contributionId}`;
  console.log(`• Order ID: ${orderId}`);
  console.log(`• PayPal-Request-Id: ${requestId}`);

  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/authorize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
  });

  const body = await res.json();
  if (!res.ok) {
    console.error(`\n❌ Authorize Order failed with HTTP ${res.status}:`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const authorization = body.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authorization) {
    console.error('\n❌ No authorization object found in response:');
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`✓ Order AUTHORIZED successfully!`);
  console.log(`  • Authorization ID: ${authorization.id}`);
  console.log(`  • Status:           ${authorization.status}`);
  console.log(`  • Amount:           ${authorization.amount.value} ${authorization.amount.currency_code}`);
  console.log(`  • Expiration Time:  ${authorization.expiration_time}`);

  return authorization.id;
}

async function captureAuthorization(token, authId, contributionId, attempt = 1, mockHeader = null) {
  console.log(`\n--- Step 4: Capturing Authorization (Attempt #${attempt}) ---`);
  const requestId = `cap_${contributionId}_${attempt}`;
  console.log(`• Authorization ID: ${authId}`);
  console.log(`• PayPal-Request-Id: ${requestId}`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': requestId,
  };

  if (mockHeader) {
    console.log(`⚠️ Applying Mock Header: PayPal-Mock-Response = ${mockHeader}`);
    headers['PayPal-Mock-Response'] = mockHeader;
  }

  const payload = {
    amount: {
      currency_code: 'USD',
      value: '1.00',
    },
    is_final_capture: true,
  };

  const res = await fetch(`${PAYPAL_BASE}/v2/payments/authorizations/${authId}/capture`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  console.log(`Capture Response Status: HTTP ${res.status}`);

  if (!res.ok) {
    console.log(`Capture Error Response Body:`);
    console.log(JSON.stringify(body, null, 2));
    return { ok: false, status: res.status, body };
  }

  console.log(`✓ Capture COMPLETED!`);
  console.log(`  • Capture ID: ${body.id}`);
  console.log(`  • Status:     ${body.status}`);
  return { ok: true, status: res.status, captureId: body.id, body };
}

async function refundCapture(token, captureId, contributionId) {
  console.log('\n--- Step 5: Refunding Capture ---');
  const requestId = `ref_${contributionId}`;
  console.log(`• Capture ID: ${captureId}`);
  console.log(`• PayPal-Request-Id: ${requestId}`);

  const payload = {
    amount: {
      currency_code: 'USD',
      value: '1.00',
    },
    note_to_payer: 'Quorum first-hop refund verification test',
  };

  const res = await fetch(`${PAYPAL_BASE}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error(`\n❌ Refund failed with HTTP ${res.status}:`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`✓ Refund SUCCEEDED!`);
  console.log(`  • Refund ID: ${body.id}`);
  console.log(`  • Status:    ${body.status}`);
  return body.id;
}

async function voidAuthorization(token, authId, contributionId) {
  console.log('\n--- Voiding Authorization ---');
  const requestId = `void_${contributionId}`;
  console.log(`• Authorization ID: ${authId}`);
  console.log(`• PayPal-Request-Id: ${requestId}`);

  const res = await fetch(`${PAYPAL_BASE}/v2/payments/authorizations/${authId}/void`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
  });

  if (res.status === 204) {
    console.log(`✓ Authorization VOIDED successfully (HTTP 204 No Content)!`);
    return true;
  }

  const body = await res.json();
  if (!res.ok) {
    console.error(`\n❌ Void failed with HTTP ${res.status}:`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`✓ Authorization VOIDED! Status = ${body.status}`);
  return true;
}

async function run() {
  console.log('=============================================================');
  console.log('   Quorum First-Hop PayPal Sandbox Probe (Order/Auth/Cap)   ');
  console.log('=============================================================');

  const token = await getOAuthToken();
  const testRunId = Date.now().toString(36);
  const contributionId = `c_probe_${testRunId}`;

  // 1. Create order
  const { orderId, approveUrl } = await createAuthorizationOrder(token, contributionId, 100);

  // 2. Wait for buyer approval in browser
  await waitForBuyerApproval(token, orderId, approveUrl);

  // 3. Authorize order
  const authId = await authorizeOrder(token, orderId, contributionId);

  if (IS_VOID_TEST) {
    // Test Void path
    await voidAuthorization(token, authId, contributionId);
    console.log('\n🎉 First-Hop VOID Probe Complete: Authorization -> Void succeeded!');
    return;
  }

  if (IS_MOCK_FAILURE_TEST) {
    // Test Mock Failure for S4 Simulation
    console.log('\n--- Testing Mock Capture Failure for S4 Simulation ---');
    const mockRes = await captureAuthorization(
      token,
      authId,
      contributionId,
      1,
      JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' })
    );
    console.log('\nRecorded Mock Response for Spec §8.4:');
    console.log(JSON.stringify(mockRes, null, 2));

    // Follow up with real capture to clean up authorization
    console.log('\nNow executing real capture attempt to complete flow:');
    const realCapture = await captureAuthorization(token, authId, contributionId, 2);
    if (realCapture.ok) {
      await refundCapture(token, realCapture.captureId, contributionId);
    }
    return;
  }

  // 4. Capture authorization
  const captureResult = await captureAuthorization(token, authId, contributionId, 1);
  if (!captureResult.ok) {
    console.error('\n❌ Capture failed. Exiting.');
    process.exit(1);
  }

  // 5. Refund the capture
  await refundCapture(token, captureResult.captureId, contributionId);

  console.log('\n=============================================================');
  console.log('🎉 FIRST-HOP PROBE COMPLETED 100% SUCCESSFULLY!');
  console.log('Verified:');
  console.log('  1. Order intent=AUTHORIZE created with custom_id');
  console.log('  2. Buyer browser approval verified via polling');
  console.log('  3. Order authorized (Authorization ID generated)');
  console.log('  4. Authorization captured (Capture ID generated)');
  console.log('  5. Capture refunded (Refund ID generated)');
  console.log('=============================================================');
}

run().catch((err) => {
  console.error('\n💥 Unhandled error in probe:', err);
  process.exit(1);
});
