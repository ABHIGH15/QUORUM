import fs from 'node:fs';
import path from 'node:path';

// Safe .env loader (never prints or logs secrets)
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

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.DEMO_RESET_SECRET;

async function run() {
  console.log('=============================================================');
  console.log('     Quorum Live Route Payout Execution Verification         ');
  console.log('=============================================================');
  console.log(`Target: ${BASE_URL}\n`);

  // 1. Reset Demo Group via POST /api/demo/reset
  console.log('--- Step 1: POST /api/demo/reset ---');
  const resetRes = await fetch(`${BASE_URL}/api/demo/reset`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
  });
  if (!resetRes.ok) {
    const errText = await resetRes.text();
    throw new Error(`Failed to reset demo: HTTP ${resetRes.status} - ${errText}`);
  }
  const resetData = await resetRes.json();
  const groupId = resetData.groupId;
  console.log(`✓ Seeded Demo Group: ${groupId}`);
  console.log(`  Members: ${resetData.activeMembersCount} active members`);
  console.log(`  Initial Balance: $${(resetData.poolBalanceCents / 100).toFixed(2)}`);

  // 2. Fetch Initial State
  console.log('\n--- Step 2: GET /api/groups/[id]/state ---');
  const stateRes1 = await fetch(`${BASE_URL}/api/groups/${groupId}/state`);
  const state1 = await stateRes1.json();
  console.log(`✓ Available Funds: $${(state1.funds.availableCents / 100).toFixed(2)}`);
  console.log(`✓ Active Members: ${state1.members?.map((m) => m.display_name).join(', ')}`);
  const members = state1.members || [];
  const asha = members.find((m) => m.display_name.includes('Asha')) || members[0];

  // 3. Trigger Agent via POST /api/agent/chat
  console.log('\n--- Step 3: POST /api/agent/chat (Live Gemini Agent) ---');
  const agentRes = await fetch(`${BASE_URL}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId,
      message: 'I want to buy a projector for movie nights',
    }),
  });
  if (!agentRes.ok) {
    throw new Error(`Agent call failed: HTTP ${agentRes.status} - ${await agentRes.text()}`);
  }
  const agentData = await agentRes.json();
  console.log(`✓ Agent Engine: ${agentData.engine} (Model: ${agentData.model || 'Flash'})`);
  console.log(`✓ Adaptation Occurred: ${agentData.adaptationOccurred}`);
  console.log(`✓ Proposed Item: ${agentData.proposedItem?.name} ($${((agentData.proposedItem?.priceCents || 0) / 100).toFixed(2)})`);
  const proposalId = agentData.proposedItem?.proposalId;
  console.log(`✓ Proposal ID: ${proposalId}`);

  // 4. Cast votes via POST /api/proposals/[id]/vote
  console.log('\n--- Step 4: Cast Approvals via POST /api/proposals/[id]/vote ---');
  // Cast 4 votes (or 6 if item exceeds unanimous threshold)
  const votesRequired = agentData.proposedItem?.priceCents > 15000 ? 6 : 4;
  for (let i = 0; i < votesRequired; i++) {
    const voter = members[i];
    const voteRes = await fetch(`${BASE_URL}/api/proposals/${proposalId}/vote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `quorum_member_id=${voter.member_id}`,
      },
      body: JSON.stringify({
        choice: 'APPROVE',
      }),
    });
    const voteData = await voteRes.json();
    console.log(`  - ${voter.display_name} voted APPROVE -> Status: ${voteData.proposalStatus}`);
  }

  // 5. Check State after voting
  console.log('\n--- Step 5: Check Veto Window & Transition ---');
  let stateRes2 = await fetch(`${BASE_URL}/api/groups/${groupId}/state`);
  let state2 = await stateRes2.json();
  let currentProposal = state2.proposals.find((p) => p.id === proposalId);
  console.log(`  Proposal Status: ${currentProposal?.status}`);
  console.log(`  Veto Ends At: ${currentProposal?.veto_ends_at}`);

  // If in VETO_WINDOW, wait for window to lapse naturally
  if (currentProposal?.status === 'VETO_WINDOW') {
    const vetoEndMs = new Date(currentProposal.veto_ends_at).getTime();
    console.log(`  Proposal entered VETO_WINDOW until ${currentProposal.veto_ends_at}`);
    while (Date.now() < vetoEndMs) {
      const remainingSec = Math.ceil((vetoEndMs - Date.now()) / 1000);
      process.stdout.write(`\r  [Live Veto Ticker] Waiting for 2-minute window: ${remainingSec}s remaining...   `);
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(1000, vetoEndMs - Date.now()))));
    }
    console.log('\n  ✓ 2-minute veto window elapsed.');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Re-check state (lazy tick advances to EXECUTABLE)
    stateRes2 = await fetch(`${BASE_URL}/api/groups/${groupId}/state`);
    state2 = await stateRes2.json();
    currentProposal = state2.proposals.find((p) => p.id === proposalId);
    console.log(`  Proposal Status after veto window: ${currentProposal?.status}`);
  }

  // 6. Execute Proposal via POST /api/proposals/[id]/execute
  console.log('\n--- Step 6: POST /api/proposals/[id]/execute (Live PayPal Sandbox) ---');
  console.log(`Executor Persona: ${asha.display_name} (${asha.member_id})`);
  const execStartTime = Date.now();
  const execRes = await fetch(`${BASE_URL}/api/proposals/${proposalId}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `quorum_member_id=${asha.member_id}`,
    },
    body: JSON.stringify({}),
  });
  const execElapsed = ((Date.now() - execStartTime) / 1000).toFixed(2);
  const execData = await execRes.json();

  if (!execRes.ok) {
    throw new Error(`Execution route failed (HTTP ${execRes.status}): ${JSON.stringify(execData)}`);
  }

  console.log(`✓ Execution Route Succeeded in ${execElapsed}s:`);
  console.log(`  Phase: ${execData.phase}`);
  console.log(`  Payment ID: ${execData.paymentId}`);
  console.log(`  Sender Batch ID: ${execData.senderBatchId}`);
  console.log(`  PayPal Batch ID: ${execData.paypalBatchId}`);

  // 7. Reconcile & Verify Final State
  console.log('\n--- Step 7: Authoritative Payout Reconciliation (No Webhooks Needed) ---');
  let finalState;
  let finalProposal;

  // Poll state endpoint up to 12 times (60 seconds) until PayPal moves batch to SUCCESS and Quorum reconciles to EXECUTED
  for (let poll = 1; poll <= 12; poll++) {
    const finalStateRes = await fetch(`${BASE_URL}/api/groups/${groupId}/state`);
    finalState = await finalStateRes.json();
    finalProposal = finalState.proposals.find((p) => p.id === proposalId);
    console.log(`  [Reconciliation Poll ${poll}/12] Proposal: ${finalProposal?.status} | Payment: ${finalProposal?.latest_payment?.status}`);

    if (finalProposal?.status === 'EXECUTED') {
      console.log(`  ✓ Authoritative PayPal lookup completed: Payment SUCCEEDED, Proposal EXECUTED!`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.log(`\n✓ Final Proposal Status: ${finalProposal?.status}`);
  console.log(`✓ Final Payment Status: ${finalProposal?.latest_payment?.status}`);
  console.log(`✓ Remaining Available Balance: $${(finalState.funds.availableCents / 100).toFixed(2)}`);
  console.log(`✓ Paid Funds: $${(finalState.funds.paidCents / 100).toFixed(2)}`);
  console.log(`✓ Reserved Funds: $${(finalState.funds.reservedCents / 100).toFixed(2)}`);

  console.log('\n--- Audit Ledger Events ---');
  for (const le of finalState.ledger || []) {
    console.log(`  [${le.id}] ${le.type}: $${(le.amount_cents / 100).toFixed(2)} (actor: ${le.actor_kind})`);
  }

  console.log('\n=============================================================');
  console.log('✓ Quorum Live Route Payout Execution Verification Complete');
  console.log('=============================================================');
}

run().catch((err) => {
  console.error('\n❌ Execution test failed:', err);
  process.exit(1);
});
