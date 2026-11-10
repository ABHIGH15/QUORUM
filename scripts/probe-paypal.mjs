import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

const clientId = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
const baseUrl = 'https://api-m.sandbox.paypal.com';

async function getToken() {
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

async function run() {
  console.log('--- Probing PayPal Sandbox Authorizations, Captures, & Voids ---');
  const token = await getToken();

  // 1. Create Order with intent: AUTHORIZE
  console.log('1. Creating order with intent: AUTHORIZE...');
  const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: 'ref_contrib_probe_1',
          amount: {
            currency_code: 'USD',
            value: '80.00',
          },
          description: 'Quorum Contribution Authorization Probe',
        },
      ],
    }),
  });
  const order = await orderRes.json();
  console.log(`Order created: ${order.id} (${order.status})`);

  // 2. Probe Capture with PayPal-Mock-Response (INSTRUMENT_DECLINED & PAYER_ACTION_REQUIRED)
  console.log('2. Probing Capture failure with PayPal-Mock-Response...');
  const mockCaptureRes = await fetch(`${baseUrl}/v2/checkout/orders/${order.id}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Mock-Response': JSON.stringify({
        mock_application_codes: 'PAYER_ACTION_REQUIRED',
      }),
    },
  });
  console.log('Capture Mock HTTP Status:', mockCaptureRes.status);
  const mockCaptureBody = await mockCaptureRes.text();
  console.log('Capture Mock Body:', mockCaptureBody);

  // 3. Probe Void Endpoint Error Handling (PREVIOUSLY_VOIDED mock response)
  console.log('3. Probing Void on authorization with PREVIOUSLY_VOIDED mock...');
  const voidRes = await fetch(`${baseUrl}/v2/payments/authorizations/${order.id}/void`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Mock-Response': JSON.stringify({
        mock_application_codes: 'PREVIOUSLY_VOIDED',
      }),
    },
  });
  console.log('Void Probe HTTP Status:', voidRes.status);
  const voidBody = await voidRes.text();
  console.log('Void Body:', voidBody);

  // Write documentation file
  const docsContent = `# PayPal Sandbox Real API Probes

Generated via live probes to PayPal Sandbox API (\`api-m.sandbox.paypal.com\`) on ${new Date().toISOString()}.

## 1. Create Order for Contribution Authorization (\`POST /v2/checkout/orders\`)
**Intent:** \`AUTHORIZE\`  
**Amount:** \`$80.00 USD\`  
**Order ID:** \`${order.id}\`  
**Status:** \`${order.status}\`

\`\`\`json
${JSON.stringify(order, null, 2)}
\`\`\`

## 2. Capture Failure Probe (\`POST /v2/checkout/orders/{id}/capture\`)
**Header:** \`PayPal-Mock-Response: {"mock_application_codes": "PAYER_ACTION_REQUIRED"}\`  
**HTTP Status:** \`${mockCaptureRes.status}\`  

\`\`\`json
${mockCaptureBody}
\`\`\`

## 3. Void Authorization Probe (\`POST /v2/payments/authorizations/{id}/void\`)
**Header:** \`PayPal-Mock-Response: {"mock_application_codes": "PREVIOUSLY_VOIDED"}\`  
**HTTP Status:** \`${voidRes.status}\`  
*When an active authorization is voided, PayPal returns HTTP 204 No Content. If an authorization has already been voided, PayPal returns HTTP 422 with issue \`PREVIOUSLY_VOIDED\`.*

\`\`\`json
${voidBody}
\`\`\`
`;

  fs.writeFileSync(path.resolve(process.cwd(), 'docs/paypal-probes.md'), docsContent);
  console.log('Updated docs/paypal-probes.md successfully.');
}

run().catch(console.error);
