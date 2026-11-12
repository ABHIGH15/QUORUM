import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

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

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set in .env');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('Connecting to Supabase PostgreSQL...');
  
  // First ensure schema tables exist
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'db/schema.sql'), 'utf8');
  await pool.query(schemaSql);
  console.log('✓ DDL Schema applied successfully.');

  const demoGroupId = '00000000-0000-0000-0000-000000000001';
  const demoPolicyId = '00000000-0000-0000-0000-000000000002';
  const demoRoundId = '00000000-0000-0000-0000-000000000003';

  // 1. Clear previous demo data
  await pool.query('DELETE FROM votes');
  await pool.query('DELETE FROM payments');
  await pool.query('DELETE FROM guard_decisions');
  await pool.query('DELETE FROM agent_runs');
  await pool.query('DELETE FROM proposals');
  await pool.query('DELETE FROM ledger_events');
  await pool.query('DELETE FROM contributions');
  await pool.query('DELETE FROM funding_rounds');
  await pool.query('DELETE FROM memberships');
  await pool.query('DELETE FROM policies');
  await pool.query('DELETE FROM groups');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM vendors');

  // 2. Seed Users & Members (6 members)
  const members = [
    { name: 'Asha Patel (Chair)', email: 'asha@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000001', mId: '20000000-0000-0000-0000-000000000001' },
    { name: 'Ben Miller', email: 'ben@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000002', mId: '20000000-0000-0000-0000-000000000002' },
    { name: 'Chloe Chen', email: 'chloe@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000003', mId: '20000000-0000-0000-0000-000000000003' },
    { name: 'Dev Sharma', email: 'dev@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000004', mId: '20000000-0000-0000-0000-000000000004' },
    { name: 'Elena Rostova', email: 'elena@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000005', mId: '20000000-0000-0000-0000-000000000005' },
    { name: 'Farid Al-Mansoor', email: 'farid@sandbox.quorum.app', uId: '10000000-0000-0000-0000-000000000006', mId: '20000000-0000-0000-0000-000000000006' },
  ];

  for (const m of members) {
    await pool.query(
      `INSERT INTO users (id, display_name, paypal_sandbox_email) VALUES ($1, $2, $3)`,
      [m.uId, m.name, m.email]
    );
  }

  // 3. Seed Group
  await pool.query(
    `INSERT INTO groups (id, name, mode, status, currency, created_by)
     VALUES ($1, 'Quorum Demo Club', 'POOLED', 'ACTIVE', 'USD', $2)`,
    [demoGroupId, members[0].uId]
  );

  // 4. Seed Policy ($200 hard cap, $150 unanimity, $480 budget)
  const policy = {
    version: 1,
    currency: 'USD',
    budget_cents: 48000,
    hard_cap_cents: 20000,
    unanimous_above_cents: 15000,
    approval_tiers: [
      { max_cents: 6000, votes_required: 2 },
      { max_cents: 15000, votes_required: 4 },
      { max_cents: 20000, votes_required: 6 },
    ],
    veto_window_minutes: 2,
    proposal_expiry_hours: 72,
    vendors: {
      mode: 'OPEN',
      allowlist_vendor_ids: ['v_projector_shop', 'v_screen_co', 'v_audio_direct'],
    },
    categories_allowed: ['equipment', 'Electronics', 'Entertainment', 'Office'],
    funding: {
      per_member_cents: 8000,
      min_contributors: 6,
      authorization_window_hours: 48,
      capture_retry_attempts: 2,
      capture_retry_interval_minutes: 60,
      partial_failure_decision: 'GROUP_VOTE',
      partial_failure_default: 'UNWIND',
      reduced_budget_votes_required: 'MAJORITY_OF_CONTRIBUTORS',
    },
    amendment_votes_required: 6,
  };

  await pool.query(
    `INSERT INTO policies (id, group_id, version, status, policy)
     VALUES ($1, $2, 1, 'ACTIVE', $3)`,
    [demoPolicyId, demoGroupId, JSON.stringify(policy)]
  );
  await pool.query(`UPDATE groups SET active_policy_id = $1 WHERE id = $2`, [demoPolicyId, demoGroupId]);

  // 5. Seed Memberships, Funding Round & Captured Contributions ($480 total)
  await pool.query(
    `INSERT INTO funding_rounds (id, group_id, status, per_member_cents, min_contributors, authorization_deadline)
     VALUES ($1, $2, 'FUNDED', 8000, 6, NOW() - interval '1 hour')`,
    [demoRoundId, demoGroupId]
  );

  for (const m of members) {
    await pool.query(
      `INSERT INTO memberships (id, group_id, user_id, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [m.mId, demoGroupId, m.uId]
    );
    await pool.query(
      `INSERT INTO contributions (round_id, member_id, amount_cents, status) VALUES ($1, $2, 8000, 'CAPTURED')`,
      [demoRoundId, m.mId]
    );
    await pool.query(
      `INSERT INTO ledger_events (group_id, type, actor_kind, actor_id, amount_cents, data)
       VALUES ($1, 'CONTRIBUTION_CAPTURED', 'MEMBER', $2, 8000, $3)`,
      [demoGroupId, m.mId, JSON.stringify({ member_name: m.name, simulated: true })]
    );
  }

  // 6. Seed Vendors
  const vendorEmail = process.env.PAYPAL_RECIPIENT_EMAIL || 'sb-5b430653638298@personal.example.com';
  const vendors = [
    { id: 'v_projector_shop', name: 'Projector Shop', email: process.env.PAYPAL_VENDOR_PROJECTOR_EMAIL || vendorEmail, category: 'equipment' },
    { id: 'v_screen_co', name: 'OptiScreen Direct', email: process.env.PAYPAL_VENDOR_SCREEN_EMAIL || vendorEmail, category: 'equipment' },
    { id: 'v_audio_direct', name: 'Audio Sound Direct', email: process.env.PAYPAL_VENDOR_AUDIO_EMAIL || vendorEmail, category: 'equipment' },
  ];
  for (const v of vendors) {
    await pool.query(
      `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
       VALUES ($1, $2, $3, $4, true, 'CATALOG')`,
      [v.id, v.name, v.email, v.category]
    );
  }

  console.log('✓ Seed completed successfully:');
  console.log('  - Group: Quorum Demo Club ($480 pool, 6 members)');
  console.log('  - Group ID:', demoGroupId);
  console.log('  - Policy ID:', demoPolicyId);
  console.log('  - Vendors:', vendors.map(v => v.id).join(', '));

  await pool.end();
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
