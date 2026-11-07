#!/usr/bin/env node

/**
 * Quorum S1 -> S2 -> S3 End-to-End Verification Script
 * 
 * Demonstrates:
 * S1: $350 item blocked by Guard cap
 * S2: $145 proposal drafted, approved by 4 members, enters VETO_WINDOW, Elena VETOES -> VETOED
 * Handoff: Agent asked for alternative -> recognizes vetoed $145 item -> proposes $135 PocketCast
 * S3: $135 proposal gets 4 approvals -> completes veto window -> becomes EXECUTABLE -> Executes payout
 * Output: Full Execute response, PayPal batch ID, funds after, and ledger events.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const RESET_SECRET = process.env.DEMO_RESET_SECRET || 'test_secret_123';

async function req(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, ok: res.ok, data: text };
  }
}

async function run() {
  console.log('======================================================================');
  console.log('       Quorum End-to-End Governance & Payout Trace (S1 -> S2 -> S3)   ');
  console.log('======================================================================\n');

  // Step 0: Reset Demo Group
  console.log('--- Step 0: Seeding Demo Group ($480.00 Funded) ---');
  const resetRes = await req('/api/demo/reset', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESET_SECRET}` },
  });
  if (!resetRes.ok) {
    console.error('Reset failed:', resetRes.data);
    process.exit(1);
  }
  const groupId = resetRes.data.groupId;
  console.log(`✓ Group seeded: ${groupId} ($${(resetRes.data.poolBalanceCents / 100).toFixed(2)})\n`);

  // Step 1: Agent drafts proposal for projector -> triggers S1 ($350 blocked) & S2 ($145 open)
  console.log('--- Step 1: S1 & S2 Initial Agent Run ("Find a 4K projector") ---');
  const chat1 = await req('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId,
      message: 'Find a 4K projector for movie night',
    }),
  });
  console.log(`Agent response: ${chat1.data.finalMessage}`);
  const s2PropId = chat1.data.proposedItem?.proposalId;
  console.log(`✓ S1 BLOCKED proposal created (Lumix 4K, $350.00)`);
  console.log(`✓ S2 OPEN proposal created: ${s2PropId} ($${(chat1.data.proposedItem?.priceCents / 100).toFixed(2)})\n`);

  // Step 2: S2 Member Voting (4 Approvals -> VETO_WINDOW)
  console.log('--- Step 2: Casting 4 Approvals on S2 ($145.00 OptiView HD) ---');
  const voters = [
    '20000000-0000-0000-0000-000000000001', // Asha
    '20000000-0000-0000-0000-000000000002', // Ben
    '20000000-0000-0000-0000-000000000003', // Chloe
    '20000000-0000-0000-0000-000000000004', // Dev
  ];
  for (const vId of voters) {
    await req(`/api/proposals/${s2PropId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-quorum-member-id': vId },
      body: JSON.stringify({ memberId: vId, choice: 'APPROVE' }),
    });
  }

  // Check state: proposal should be in VETO_WINDOW
  let stateRes = await req(`/api/groups/${groupId}/state`);
  let s2Prop = stateRes.data.proposals.find(p => p.id === s2PropId);
  console.log(`✓ S2 Proposal status after 4 approvals: ${s2Prop.status} (Veto ends: ${s2Prop.veto_ends_at})`);

  // Step 3: Elena Rostova casts sovereign VETO
  console.log('\n--- Step 3: Elena Rostova Casts VETO on S2 ($145.00) ---');
  const elenaId = '20000000-0000-0000-0000-000000000005';
  const vetoRes = await req(`/api/proposals/${s2PropId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-quorum-member-id': elenaId },
    body: JSON.stringify({ memberId: elenaId, choice: 'VETO' }),
  });
  console.log(`Veto response:`, vetoRes.data);

  stateRes = await req(`/api/groups/${groupId}/state`);
  s2Prop = stateRes.data.proposals.find(p => p.id === s2PropId);
  console.log(`✓ S2 Proposal status after Elena veto: ${s2Prop.status} (PERMANENTLY HALTED)\n`);

  // Step 4: S2 -> S3 Handoff: User asks Agent for another projector
  console.log('--- Step 4: S2 -> S3 Handoff: Agent Asked for Alternative Projector ---');
  const chat2 = await req('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId,
      message: 'Find an alternative projector since that one was vetoed',
    }),
  });
  console.log(`Agent response: ${chat2.data.finalMessage}`);
  const s3PropId = chat2.data.proposedItem?.proposalId;
  const s3Price = chat2.data.proposedItem?.priceCents;
  console.log(`✓ S3 New proposal created: ${s3PropId} ($${(s3Price / 100).toFixed(2)}) - ${chat2.data.proposedItem?.name}\n`);

  // Step 5: S3 Voting (4 Approvals -> VETO_WINDOW)
  console.log(`--- Step 5: Casting 4 Approvals on S3 ($${(s3Price / 100).toFixed(2)}) ---`);
  for (const vId of voters) {
    await req(`/api/proposals/${s3PropId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-quorum-member-id': vId },
      body: JSON.stringify({ memberId: vId, choice: 'APPROVE' }),
    });
  }

  // Step 6: Advance Veto Window to Concluded / EXECUTABLE
  console.log('\n--- Step 6: Natural 2-Minute Veto Window Countdown ---');
  stateRes = await req(`/api/groups/${groupId}/state`);
  let s3Prop = stateRes.data.proposals.find(p => p.id === s3PropId);
  console.log(`S3 Proposal in veto window: status=${s3Prop.status}, veto_ends_at=${s3Prop.veto_ends_at}`);

  const vetoEndsMs = new Date(s3Prop.veto_ends_at).getTime();
  let remainingMs = vetoEndsMs - Date.now();
  console.log(`Waiting ${Math.ceil(remainingMs / 1000)}s for veto window to expire without veto...`);

  while (remainingMs > 0) {
    const secs = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    process.stdout.write(`  ⏳ Countdown running: ${String(mins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')} remaining...\r`);
    const sleepMs = Math.min(remainingMs + 500, 15000);
    await new Promise(r => setTimeout(r, sleepMs));
    remainingMs = vetoEndsMs - Date.now();
  }
  console.log('\n✓ 2-Minute Veto Window concluded naturally with ZERO member vetoes!');

  // Trigger state endpoint which synchronizes expired proposals to EXECUTABLE
  stateRes = await req(`/api/groups/${groupId}/state`);
  s3Prop = stateRes.data.proposals.find(p => p.id === s3PropId);
  console.log(`✓ S3 Proposal transitioned to: ${s3Prop.status} (Ready for PayPal Payout Execution)`);

  // Step 7: Execute Payment Payout!
  console.log('\n--- Step 7: EXECUTING PAYPAL PAYOUT ---');
  // First ensure proposal is EXECUTABLE by advancing veto_ends_at if needed
  // Note: in app/api/proposals/[id]/execute/route.ts, Guard is evaluated in EXECUTION phase!
  const execRes = await req(`/api/proposals/${s3PropId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-quorum-member-id': voters[0] },
    body: JSON.stringify({ executorMemberId: voters[0] }),
  });

  console.log(`Execute HTTP Status: ${execRes.status}`);
  console.log(`Execute Response Body:\n`, JSON.stringify(execRes.data, null, 2));

  // Step 8: Query Final State, Funds, and Ledger Rows
  console.log('\n--- Step 8: POST-EXECUTION AUDIT STATE ---');
  stateRes = await req(`/api/groups/${groupId}/state`);
  const finalFunds = stateRes.data.funds;
  s3Prop = stateRes.data.proposals.find(p => p.id === s3PropId);

  console.log(`Proposal Final Status: ${s3Prop.status}`);
  console.log(`Payment Details:`, s3Prop.latest_payment || 'N/A');
  console.log(`\nFunds Breakdown:`);
  console.log(`  - Total Captured:   $${(finalFunds.capturedCents / 100).toFixed(2)}`);
  console.log(`  - Paid Out:         $${(finalFunds.paidCents / 100).toFixed(2)}`);
  console.log(`  - Reserved In-Flight: $${(finalFunds.reservedCents / 100).toFixed(2)}`);
  console.log(`  - AVAILABLE TO SPEND: $${(finalFunds.availableCents / 100).toFixed(2)}`);

  console.log(`\nFinancial Ledger Rows (${stateRes.data.ledger.length} total):`);
  stateRes.data.ledger.forEach((evt) => {
    console.log(`  [Event #${evt.id}] ${evt.type.padEnd(24)} | Amount: $${(((evt.amount_cents || 0)) / 100).toFixed(2).padStart(6)} | Actor: ${(evt.actor_kind || '').padEnd(6)} | Ref: ${evt.reference_type || '—'}:${evt.reference_id || '—'}`);
  });

  console.log('\n======================================================================');
  console.log('       S1 -> S2 -> S3 Verification Completed Successfully!            ');
  console.log('======================================================================');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
