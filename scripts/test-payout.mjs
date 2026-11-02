#!/usr/bin/env node

/**
 * Quorum Day-1 Sandbox Payout Verification Script
 * 
 * Verifies:
 * 1. OAuth2 token generation with sandbox credentials.
 * 2. POST /v1/payments/payouts to an existing sandbox personal account.
 * 3. Polling GET /v1/payments/payouts/{batch_id} (up to 30 attempts) until terminal batch status
 *    (SUCCESS, DENIED, CANCELED) and inspecting item-level transaction_status.
 * 4. Duplicate sender_batch_id rejection (capturing exact HTTP status and error body).
 * 
 * Usage:
 *   node scripts/test-payout.mjs
 * 
 * Required Environment Variables (via shell export or .env):
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_RECIPIENT_EMAIL (must be a valid sandbox personal account from Developer Dashboard)
 */

import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader if dotenv is not yet installed
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

// Hardcoded Sandbox Base URL — no environment toggle can accidentally point to live
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const RECIPIENT_EMAIL = process.env.PAYPAL_RECIPIENT_EMAIL;

if (!CLIENT_ID || !CLIENT_SECRET || !RECIPIENT_EMAIL) {
  console.error('\n❌ Missing required configuration in environment or .env:');
  if (!CLIENT_ID) console.error('   • PAYPAL_CLIENT_ID');
  if (!CLIENT_SECRET) console.error('   • PAYPAL_CLIENT_SECRET');
  if (!RECIPIENT_EMAIL) {
    console.error('   • PAYPAL_RECIPIENT_EMAIL');
    console.error('     ⚠️ Must be an existing sandbox personal buyer account email from your');
    console.error('        PayPal Developer Dashboard (Sandbox > Accounts), NOT a dummy or real email.');
  }
  console.error('\nExample:');
  console.error('  export PAYPAL_CLIENT_ID="A..."');
  console.error('  export PAYPAL_CLIENT_SECRET="E..."');
  console.error('  export PAYPAL_RECIPIENT_EMAIL="sb-user123@personal.example.com"');
  console.error('  node scripts/test-payout.mjs\n');
  process.exit(1);
}

// Global record of the 4 requested verification results
const results = {
  firstPayoutHttpStatus: null,
  finalBatchStatus: null,
  itemTransactionStatus: null,
  duplicateSendErrorBody: null,
};

async function step1_getOAuthToken() {
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
    console.error('\n👉 Check that CLIENT_ID and CLIENT_SECRET belong to the Sandbox App of your Business account.');
    process.exit(1);
  }

  const data = await res.json();
  console.log(`✅ Token obtained successfully (expires in ${data.expires_in}s)`);
  return data.access_token;
}

async function step2_createPayout(token, senderBatchId) {
  console.log(`\n--- Step 2: Submitting Payout (sender_batch_id: ${senderBatchId}) ---`);
  console.log(`   Recipient: ${RECIPIENT_EMAIL}`);
  console.log(`   Amount: $1.00 USD`);

  const payload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'Quorum Sandbox Test Payout',
      email_message: 'Verification payout from Quorum Day-1 automated script.',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: {
          value: '1.00',
          currency: 'USD',
        },
        note: 'Quorum Day 1 Verification Item',
        receiver: RECIPIENT_EMAIL,
        sender_item_id: `item_${Date.now()}`,
      },
    ],
  };

  const res = await fetch(`${PAYPAL_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  results.firstPayoutHttpStatus = res.status;
  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  return { status: res.status, ok: res.ok, data, payload };
}

async function step3_pollBatch(token, batchId) {
  console.log(`\n--- Step 3: Polling Payout Batch Status (batch_id: ${batchId}) ---`);
  
  const maxAttempts = 30; // Capped at 30 attempts
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    process.stdout.write(`   Poll attempt ${attempt}/${maxAttempts}... `);

    const res = await fetch(`${PAYPAL_BASE}/v1/payments/payouts/${batchId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.log(`HTTP ${res.status}`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    const data = await res.json();
    const batchStatus = data.batch_header?.batch_status;
    console.log(`Batch Status: ${batchStatus}`);

    // Terminal batch statuses: SUCCESS, DENIED, CANCELED
    if (['SUCCESS', 'DENIED', 'CANCELED'].includes(batchStatus)) {
      results.finalBatchStatus = batchStatus;
      console.log(`\nBatch reached terminal state: ${batchStatus}`);

      if (data.items && data.items.length > 0) {
        const item = data.items[0];
        results.itemTransactionStatus = item.transaction_status;
        console.log(`   Item Transaction Status: ${item.transaction_status}`);
        console.log(`   PayPal Item ID: ${item.payout_item_id || 'N/A'}`);

        if (item.transaction_status === 'SUCCESS') {
          console.log('   ✅ Item successfully paid!');
        } else if (item.transaction_status === 'UNCLAIMED') {
          console.log('   ⚠️ Item is UNCLAIMED. This occurs when the recipient email is not');
          console.log('      registered as an active personal sandbox account in PayPal.');
        } else if (['FAILED', 'RETURNED', 'BLOCKED', 'ONHOLD'].includes(item.transaction_status)) {
          console.log(`   ❌ Item status failed: ${item.transaction_status}`);
          if (item.errors) {
            console.log('   Item Errors:', JSON.stringify(item.errors, null, 2));
          }
        }
      } else {
        console.log('   ⚠️ No items returned in batch response.');
      }
      return data;
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  console.log(`\n⚠️ Polling capped at ${maxAttempts} attempts without terminal status.`);
  results.finalBatchStatus = 'TIMEOUT';
  return null;
}

async function step4_testDuplicateRejection(token, payload) {
  console.log(`\n--- Step 4: Testing Duplicate sender_batch_id Idempotency ---`);
  console.log(`   Re-sending identical batch with sender_batch_id: ${payload.sender_batch_header.sender_batch_id}`);

  const res = await fetch(`${PAYPAL_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  results.duplicateSendErrorBody = data;

  if (!res.ok) {
    console.log(`✅ Duplicate submission rejected with HTTP ${res.status}`);
    return true;
  } else {
    console.log(`⚠️ Warning: Duplicate batch was accepted with HTTP ${res.status}:`, data);
    return false;
  }
}

async function main() {
  console.log('====================================================');
  console.log('   Quorum Day-1 PayPal Payouts Verification Test    ');
  console.log('====================================================');

  try {
    const token = await step1_getOAuthToken();
    const testBatchId = `q_test_${Date.now()}`;
    
    const payoutResult = await step2_createPayout(token, testBatchId);

    if (!payoutResult.ok) {
      console.error(`\n❌ Payout creation failed (HTTP ${payoutResult.status}):`);
      console.error(JSON.stringify(payoutResult.data, null, 2));
      console.log('\nDIAGNOSIS:');
      if (payoutResult.status === 401) {
        console.log('👉 HTTP 401 Unauthorized: Invalid client credentials or token.');
      } else if (payoutResult.status === 403 || payoutResult.data?.name === 'NOT_AUTHORIZED') {
        console.log('👉 HTTP 403 Forbidden: Payouts feature is not enabled for this sandbox app.');
        console.log('   Action: In PayPal Developer Dashboard > Apps & Credentials > App Details,');
        console.log('           check the "Features" section and toggle "Payouts".');
        console.log('   If unavailable, Quorum will fall back cleanly to Direct mode (Mode B).');
      } else if (payoutResult.data?.name === 'INSUFFICIENT_FUNDS') {
        console.log('👉 INSUFFICIENT_FUNDS: Sandbox Business account has $0.00 balance.');
        console.log('   Action: Top up the sandbox Business account balance in Developer Dashboard > Sandbox Accounts.');
      }
      process.exit(1);
    }

    const batchHeader = payoutResult.data.batch_header;
    console.log(`✅ Payout submitted! PayPal Payout Batch ID: ${batchHeader.payout_batch_id}`);
    console.log(`   Initial Status: ${batchHeader.batch_status}`);

    await step3_pollBatch(token, batchHeader.payout_batch_id);

    await step4_testDuplicateRejection(token, payoutResult.payload);

    // Print the 4 requested verification fields cleanly
    console.log('\n====================================================');
    console.log('            VERIFICATION RESULTS REPORT             ');
    console.log('====================================================');
    console.log(`1. HTTP Status of First Payout: ${results.firstPayoutHttpStatus}`);
    console.log(`2. Final batch_status:          ${results.finalBatchStatus}`);
    console.log(`3. Item transaction_status:     ${results.itemTransactionStatus}`);
    console.log('4. Full Duplicate-Send Error Body:');
    console.log(JSON.stringify(results.duplicateSendErrorBody, null, 2));
    console.log('====================================================\n');

  } catch (err) {
    console.error('\n❌ Verification script encountered an unhandled error:', err.message);
    process.exit(1);
  }
}

main();
