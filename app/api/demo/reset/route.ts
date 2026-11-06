import { getPool } from '@/lib/db/pool';

/**
 * Protected Demo Reset Endpoint (§12.3)
 * 
 * Invariants:
 * 1. Protected by DEMO_RESET_SECRET.
 * 2. Clears previous demo proposals, payments, and ledger events.
 * 3. Re-seeds demo group in ACTIVE funded status with 6 members and $480 captured pool.
 * 4. Never exposed without authentication.
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const expectedSecret = process.env.DEMO_RESET_SECRET;

    if (!expectedSecret || token !== expectedSecret) {
      return Response.json({ error: 'Unauthorized: Invalid or missing DEMO_RESET_SECRET' }, { status: 401 });
    }

    // Refuse to seed if no real sandbox vendor account is configured (prevents payouts from becoming UNCLAIMED)
    const isTest = process.env.NODE_ENV === 'test';
    const defaultRecipient = process.env.PAYPAL_RECIPIENT_EMAIL?.trim();
    const vendorProjectorEmail =
      process.env.PAYPAL_VENDOR_PROJECTOR_EMAIL?.trim() ||
      defaultRecipient ||
      (isTest ? 'test-vendor-projector@sandbox.quorum.app' : null);
    const vendorScreenEmail =
      process.env.PAYPAL_VENDOR_SCREEN_EMAIL?.trim() ||
      defaultRecipient ||
      (isTest ? 'test-vendor-screen@sandbox.quorum.app' : null);
    const vendorAudioEmail =
      process.env.PAYPAL_VENDOR_AUDIO_EMAIL?.trim() ||
      defaultRecipient ||
      (isTest ? 'test-vendor-audio@sandbox.quorum.app' : null);

    if (!vendorProjectorEmail || !vendorScreenEmail || !vendorAudioEmail) {
      return Response.json(
        {
          error:
            'Missing vendor sandbox accounts. Refusing to seed demo state without valid vendor emails, or payouts will silently become UNCLAIMED. Configure PAYPAL_VENDOR_PROJECTOR_EMAIL, PAYPAL_VENDOR_SCREEN_EMAIL, PAYPAL_VENDOR_AUDIO_EMAIL, or set PAYPAL_RECIPIENT_EMAIL to a PayPal Sandbox Personal Account.',
        },
        { status: 400 }
      );
    }

    const pool = getPool();

    // 1. Clear existing demo data
    await pool.query(`DELETE FROM votes`);
    await pool.query(`DELETE FROM payments`);
    await pool.query(`DELETE FROM guard_decisions`);
    await pool.query(`DELETE FROM agent_runs`);
    await pool.query(`DELETE FROM proposals`);
    await pool.query(`DELETE FROM ledger_events`);
    await pool.query(`DELETE FROM contributions`);
    await pool.query(`DELETE FROM funding_rounds`);
    await pool.query(`DELETE FROM memberships`);
    await pool.query(`DELETE FROM policies`);
    await pool.query(`DELETE FROM groups`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM vendors`);

    // 2. Fixed Demo IDs
    const demoGroupId = '00000000-0000-0000-0000-000000000001';
    const demoPolicyId = '00000000-0000-0000-0000-000000000002';
    const demoRoundId = '00000000-0000-0000-0000-000000000003';

    // 3. Seed Users & Members (6 members)
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

    // 4. Seed Group
    await pool.query(
      `INSERT INTO groups (id, name, mode, status, currency, created_by)
       VALUES ($1, 'Quorum Demo Club', 'POOLED', 'ACTIVE', 'USD', $2)`,
      [demoGroupId, members[0].uId]
    );

    // 5. Seed Policy ($200 hard cap, $150 unanimity, $480 budget)
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
      veto_window_minutes: 1440,
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

    // 6. Seed Memberships, Funding Round & Captured Contributions ($480 total)
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

    // 7. Seed Vendors using validated sandbox personal accounts
    const vendors = [
      { id: 'v_projector_shop', name: 'Projector Shop', email: vendorProjectorEmail!, category: 'equipment' },
      { id: 'v_screen_co', name: 'OptiScreen Direct', email: vendorScreenEmail!, category: 'equipment' },
      { id: 'v_audio_direct', name: 'Audio Sound Direct', email: vendorAudioEmail!, category: 'equipment' },
    ];
    for (const v of vendors) {
      await pool.query(
        `INSERT INTO vendors (id, name, paypal_email, category, verified, source)
         VALUES ($1, $2, $3, $4, true, 'CATALOG')`,
        [v.id, v.name, v.email, v.category]
      );
    }

    return Response.json({
      success: true,
      message: 'Demo state reset successfully. Demo group initialized in ACTIVE funded status.',
      groupId: demoGroupId,
      poolBalanceCents: 48000,
      activeMembersCount: 6,
    });
  } catch (err: any) {
    console.error('[API Demo Reset Error]', err);
    return Response.json({ error: err.message || 'Demo reset failed' }, { status: 500 });
  }
}
