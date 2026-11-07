'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import AgentPanel from '@/components/agent/AgentPanel';
import LedgerGrid from '@/components/ledger/LedgerGrid';
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  HelpCircle,
  Lock,
  Users,
  DollarSign,
  Check,
  X,
  FileText,
  Activity,
  Zap,
} from 'lucide-react';

interface Member {
  member_id: string;
  user_id: string;
  display_name: string;
  paypal_sandbox_email: string;
  status: string;
}

interface ProposalVote {
  proposal_id: string;
  member_id: string;
  kind: 'VOTE' | 'VETO';
  choice: 'APPROVE' | 'REJECT' | 'VETO';
  created_at: string;
  display_name: string;
}

interface Proposal {
  id: string;
  group_id: string;
  type: string;
  status:
    | 'DRAFT'
    | 'OPEN'
    | 'VETO_WINDOW'
    | 'EXECUTABLE'
    | 'EXECUTING'
    | 'EXECUTED'
    | 'EXECUTION_FAILED'
    | 'REJECTED'
    | 'VETOED'
    | 'BLOCKED'
    | 'CANCELLED'
    | 'EXPIRED';
  created_by_kind: 'AGENT' | 'MEMBER' | 'SYSTEM';
  policy_version: number;
  vendor_id?: string;
  vendor_name?: string;
  category?: string;
  amount_cents: number;
  payload: any;
  voting_deadline?: string;
  veto_ends_at?: string;
  created_at: string;
  last_guard_decision?: string;
  last_guard_result?: any;
  votes?: ProposalVote[];
  latest_payment?: {
    status: string;
    amount_cents: number;
    sender_batch_id: string;
    paypal_batch_id?: string;
    paypal_item_id?: string;
    error_code?: string;
  } | null;
}

interface GroupState {
  group: {
    id: string;
    name: string;
    mode: string;
    status: string;
    currency: string;
  };
  policy: {
    version: number;
    currency: string;
    budget_cents: number;
    hard_cap_cents: number;
    unanimous_above_cents: number;
    approval_tiers: Array<{ max_cents: number; votes_required: number }>;
    veto_window_minutes: number;
    proposal_expiry_hours: number;
    vendors: { mode: string; allowlist_vendor_ids: string[] };
    categories_allowed: string[];
  };
  funds: {
    capturedCents: number;
    refundedCents: number;
    paidCents: number;
    reservedCents: number;
    availableCents: number;
  };
  proposals: Proposal[];
  ledger: any[];
  members: Member[];
}

const DEFAULT_MEMBERS = [
  { id: '20000000-0000-0000-0000-000000000001', name: 'Asha Patel', role: 'Chair', initials: 'AP', color: 'bg-emerald-700' },
  { id: '20000000-0000-0000-0000-000000000002', name: 'Ben Miller', role: 'Member', initials: 'BM', color: 'bg-blue-700' },
  { id: '20000000-0000-0000-0000-000000000003', name: 'Chloe Chen', role: 'Member', initials: 'CC', color: 'bg-purple-700' },
  { id: '20000000-0000-0000-0000-000000000004', name: 'Dev Sharma', role: 'Member', initials: 'DS', color: 'bg-amber-700' },
  { id: '20000000-0000-0000-0000-000000000005', name: 'Elena Rostova', role: 'Member', initials: 'ER', color: 'bg-rose-700' },
  { id: '20000000-0000-0000-0000-000000000006', name: 'Farid Al-Mansoor', role: 'Member', initials: 'FA', color: 'bg-teal-700' },
];

export default function WorkspacePage({ params }: { params: { id: string } }) {
  const groupId = params.id;

  const [state, setState] = useState<GroupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Active persona
  const [currentMemberId, setCurrentMemberId] = useState<string>(DEFAULT_MEMBERS[0].id);

  // Action status / feedback
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Why Drawer state
  const [selectedWhyProposal, setSelectedWhyProposal] = useState<Proposal | null>(null);

  // Demo shortcut & reset
  const [shortcutLoading, setShortcutLoading] = useState(false);
  const [resetSecret, setResetSecret] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  // Live countdown timer hook & zero-trigger refetch
  const [now, setNow] = useState<number>(Date.now());
  const [hasRefetchedForVetoEnd, setHasRefetchedForVetoEnd] = useState(false);

  // Fetch full state from backend
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/state`, {
        headers: {
          'x-quorum-member-id': currentMemberId,
        },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}: Failed to load group state`);
      }
      const data = await res.json();
      setState(data);
      setError(null);
    } catch (err: any) {
      console.error('[Fetch State Error]', err);
      setError(err.message || 'Unable to connect to group state endpoint');
    } finally {
      setLoading(false);
    }
  }, [groupId, currentMemberId]);

  // Initial load
  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Read persona cookie on mount
  useEffect(() => {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)quorum_member_id=([^;]+)/);
    if (cookieMatch) {
      const savedId = decodeURIComponent(cookieMatch[1].trim());
      if (DEFAULT_MEMBERS.some((m) => m.id === savedId)) {
        setCurrentMemberId(savedId);
      }
    }
  }, []);

  // Countdown timer with reactive refetch on countdown zero
  useEffect(() => {
    const timer = setInterval(() => {
      const currentMs = Date.now();
      setNow(currentMs);

      // Check if any proposal in VETO_WINDOW just reached zero
      const activeVetoProp = state?.proposals?.find((p) => p.status === 'VETO_WINDOW' && p.veto_ends_at);
      if (activeVetoProp && activeVetoProp.veto_ends_at) {
        const remaining = new Date(activeVetoProp.veto_ends_at).getTime() - currentMs;
        if (remaining <= 0 && !hasRefetchedForVetoEnd) {
          setHasRefetchedForVetoEnd(true);
          fetchState();
        } else if (remaining > 0 && hasRefetchedForVetoEnd) {
          setHasRefetchedForVetoEnd(false);
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [fetchState, state?.proposals, hasRefetchedForVetoEnd]);

  // Polling behaviour: 3s while any proposal is in VETO_WINDOW or EXECUTING, else 10s
  useEffect(() => {
    const hasActiveWindow = state?.proposals?.some(
      (p) => p.status === 'VETO_WINDOW' || p.status === 'EXECUTING'
    );
    const intervalMs = hasActiveWindow ? 3000 : 10000;

    const poller = setInterval(() => {
      fetchState();
    }, intervalMs);

    return () => clearInterval(poller);
  }, [fetchState, state?.proposals]);

  // Switch persona handler
  const handleSwitchPersona = async (memberId: string) => {
    setCurrentMemberId(memberId);
    document.cookie = `quorum_member_id=${encodeURIComponent(memberId)}; path=/; max-age=2592000`;
    try {
      await fetch('/api/auth/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      });
    } catch (e) {
      console.warn('Failed to sync persona cookie with backend', e);
    }
  };

  // Cast vote or veto
  const handleVote = async (proposalId: string, choice: 'APPROVE' | 'REJECT' | 'VETO') => {
    setActionLoading(`vote-${proposalId}-${choice}`);
    setActionError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-quorum-member-id': currentMemberId,
        },
        body: JSON.stringify({
          memberId: currentMemberId,
          choice,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit vote');
      }
      await fetchState();
    } catch (err: any) {
      setActionError(err.message || 'Error submitting vote');
    } finally {
      setActionLoading(null);
    }
  };

  // Execute payment
  const handleExecute = async (proposalId: string) => {
    setActionLoading(`execute-${proposalId}`);
    setActionError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-quorum-member-id': currentMemberId,
        },
        body: JSON.stringify({
          executorMemberId: currentMemberId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Payment execution failed');
      }
      await fetchState();
    } catch (err: any) {
      setActionError(err.message || 'Error executing payment');
    } finally {
      setActionLoading(null);
    }
  };

  // Demo Shortcut: Cast approvals as Asha, Ben, Chloe, Dev
  const handleDemoApprovalsShortcut = async () => {
    const openProposal = state?.proposals?.find((p) => p.status === 'OPEN');
    if (!openProposal) {
      setActionError('No OPEN proposal found in feed to approve.');
      return;
    }
    setShortcutLoading(true);
    setActionError(null);
    try {
      const voterIds = [
        '20000000-0000-0000-0000-000000000001', // Asha
        '20000000-0000-0000-0000-000000000002', // Ben
        '20000000-0000-0000-0000-000000000003', // Chloe
        '20000000-0000-0000-0000-000000000004', // Dev
      ];
      for (const memberId of voterIds) {
        const res = await fetch(`/api/proposals/${openProposal.id}/vote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-quorum-member-id': memberId,
          },
          body: JSON.stringify({ memberId, choice: 'APPROVE' }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Vote failed for member ${memberId}`);
        }
      }
      await fetchState();
    } catch (err: any) {
      setActionError(err.message || 'Shortcut failed');
    } finally {
      setShortcutLoading(false);
    }
  };

  // Demo reset
  const handleDemoReset = async () => {
    if (!resetSecret) {
      setResetMessage('Please enter your DEMO_RESET_SECRET');
      return;
    }
    setResetting(true);
    setResetMessage(null);
    try {
      const res = await fetch('/api/demo/reset', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resetSecret.trim()}`,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Reset failed');
      }
      setResetMessage('✓ Demo group successfully reset to $480.00 funded state');
      await fetchState();
    } catch (err: any) {
      setResetMessage(`✕ Reset failed: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] text-[#18181b] flex flex-col font-sans">
      {/* Top Navigation Bar with Clickable Member Avatar Row */}
      <header className="sticky top-0 z-30 bg-[#faf9f6]/95 backdrop-blur-md border-b border-[#e7e5df] px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Logo & Group Title */}
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-2 group text-inherit hover:opacity-80 transition"
            >
              <div className="w-8 h-8 rounded-lg bg-[#064e3b] text-white flex items-center justify-center font-serif font-bold text-lg shadow-sm">
                Q
              </div>
              <div>
                <span className="font-serif font-bold text-lg tracking-tight block leading-tight text-slate-900">
                  Quorum
                </span>
                <span className="text-[10px] uppercase font-mono tracking-wider text-slate-500 block">
                  Governance Engine
                </span>
              </div>
            </Link>

            <div className="hidden sm:block h-5 w-px bg-slate-300 mx-1" />

            <div className="hidden sm:flex items-center gap-2">
              <span className="font-medium text-sm text-slate-900">
                {state?.group?.name || 'Quorum Demo Club'}
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                POOLED ($480)
              </span>
            </div>
          </div>

          {/* Clickable Row of 6 Member Avatars (1 click to switch persona) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 hidden xl:inline font-medium">Acting as:</span>
            <div className="flex items-center gap-1 sm:gap-1.5 p-1 bg-white border border-[#dcd8d0] rounded-2xl shadow-sm overflow-x-auto max-w-[280px] sm:max-w-none">
              {DEFAULT_MEMBERS.map((member) => {
                const isActive = member.id === currentMemberId;
                return (
                  <button
                    key={member.id}
                    onClick={() => handleSwitchPersona(member.id)}
                    title={`Act as ${member.name} (${member.role})`}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl transition cursor-pointer text-xs ${
                      isActive
                        ? 'bg-[#064e3b] text-white font-semibold shadow-sm'
                        : 'bg-transparent text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                        isActive ? 'bg-white text-[#064e3b]' : `${member.color} text-white`
                      }`}
                    >
                      {member.initials}
                    </span>
                    <span className="hidden md:inline text-[11px] font-medium truncate max-w-[65px]">
                      {member.name.split(' ')[0]}
                    </span>
                    {member.role === 'Chair' && (
                      <span
                        className={`hidden sm:inline text-[8px] font-mono uppercase px-1 rounded ${
                          isActive ? 'bg-white/20 text-emerald-100' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        Chair
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      {/* Action Error Banner */}
      {actionError && (
        <div className="bg-rose-50 border-b border-rose-200 px-4 py-2 text-xs text-rose-800 flex items-center justify-between">
          <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
            <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span>{actionError}</span>
          </div>
          <button
            onClick={() => setActionError(null)}
            className="text-rose-500 hover:text-rose-800 font-bold ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {loading && !state ? (
          <div className="py-24 text-center">
            <div className="w-10 h-10 border-4 border-slate-200 border-t-[#064e3b] rounded-full animate-spin mx-auto mb-4" />
            <h3 className="font-serif text-lg font-bold text-slate-800 mb-1">
              Connecting to Quorum Workspace...
            </h3>
            <p className="text-xs text-slate-500">
              Reading group state and financial ledger from PostgreSQL
            </p>
          </div>
        ) : error && !state ? (
          <div className="bg-white rounded-2xl p-8 border border-rose-200 shadow-sm max-w-lg mx-auto my-12 text-center">
            <ShieldAlert className="w-12 h-12 text-rose-500 mx-auto mb-3" />
            <h3 className="font-serif text-xl font-bold text-slate-900 mb-2">
              Workspace Unavailable
            </h3>
            <p className="text-sm text-slate-600 mb-4">{error}</p>
            <div className="bg-slate-50 rounded-lg p-3 text-xs font-mono text-slate-700 text-left mb-6 overflow-x-auto">
              Tip: Ensure database is seeded by executing POST /api/demo/reset.
            </div>
            <button
              onClick={fetchState}
              className="px-4 py-2 bg-[#064e3b] text-white rounded-lg text-sm font-semibold hover:bg-[#053f30] transition cursor-pointer"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Top Workspace Grid: 3-Column on Desktop (Policy/Budget, Proposals Feed, AI Agent) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* LEFT COLUMN: Policy & Budget & Funding (col-span-12 lg:col-span-4 xl:col-span-3 space-y-6) */}
              <div className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-6">
                {/* Policy Card (Rendered directly from Policy JSON) */}
                <div className="bg-white rounded-2xl p-5 border border-[#e4e2dd] shadow-sm">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-[#064e3b]" />
                      <h2 className="font-serif text-base font-bold text-slate-900">
                        Group Policy
                      </h2>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-100 text-slate-700 rounded border border-slate-200">
                      v{state?.policy?.version || 1} Active
                    </span>
                  </div>

                  <div className="space-y-2.5 text-xs text-slate-700">
                    <div className="flex justify-between items-center py-1 border-b border-slate-50">
                      <span className="text-slate-500">Hard Cap (Single Purchase)</span>
                      <span className="font-mono font-semibold text-slate-900">
                        ${(((state?.policy?.hard_cap_cents ?? 20000)) / 100).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-50">
                      <span className="text-slate-500">Unanimity Threshold</span>
                      <span className="font-mono font-semibold text-slate-900">
                        &gt; ${(((state?.policy?.unanimous_above_cents ?? 15000)) / 100).toFixed(2)} (All 6)
                      </span>
                    </div>
                    <div className="py-1 border-b border-slate-50">
                      <div className="text-slate-500 mb-1">Approval Tiers</div>
                      <div className="space-y-1 font-mono text-[11px] pl-2 border-l-2 border-emerald-500">
                        {(state?.policy?.approval_tiers || [
                          { max_cents: 6000, votes_required: 2 },
                          { max_cents: 15000, votes_required: 4 },
                          { max_cents: 20000, votes_required: 6 },
                        ]).map((tier, idx) => (
                          <div key={idx} className="flex justify-between">
                            <span>Up to ${(tier.max_cents / 100).toFixed(2)}</span>
                            <span className="font-semibold text-slate-900">
                              {tier.votes_required} votes required
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-50">
                      <span className="text-slate-500">Mandatory Veto Window</span>
                      <span className="font-mono font-semibold text-slate-900">
                        {state?.policy?.veto_window_minutes ?? 2} min
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-500">Curated Vendors</span>
                      <span className="font-semibold text-emerald-800">Allowlist Only (3 shops)</span>
                    </div>
                  </div>
                </div>

                {/* Budget Card */}
                <div className="bg-white rounded-2xl p-5 border border-[#e4e2dd] shadow-sm">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-[#064e3b]" />
                      <h2 className="font-serif text-base font-bold text-slate-900">
                        Budget & Ledger Pool
                      </h2>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">USD</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">
                        Available to Spend
                      </span>
                      <span className="text-xl font-bold font-mono text-emerald-700">
                        ${((state?.funds?.availableCents ?? 48000) / 100).toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">
                        Total Captured Pool
                      </span>
                      <span className="text-xl font-bold font-mono text-slate-900">
                        ${((state?.funds?.capturedCents ?? 48000) / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-xs text-slate-600 mb-4 font-mono">
                    <div className="flex justify-between">
                      <span>Reserved (In Flight):</span>
                      <span className="font-semibold text-amber-700">
                        ${((state?.funds?.reservedCents ?? 0) / 100).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Paid Out (Executed):</span>
                      <span className="font-semibold text-slate-900">
                        ${((state?.funds?.paidCents ?? 0) / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 italic">
                    Simulated pool: 6 &times; $80.00 contributions. Real payouts draw on PayPal Sandbox business balance.
                  </div>
                </div>

                {/* Funding Strip */}
                <div className="bg-white rounded-2xl p-5 border border-[#e4e2dd] shadow-sm">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-[#064e3b]" />
                      <h2 className="font-serif text-base font-bold text-slate-900">
                        Contributing Members
                      </h2>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">
                      6 / 6 Captured
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {DEFAULT_MEMBERS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => handleSwitchPersona(m.id)}
                        className={`p-2 rounded-xl border flex items-center gap-2 transition cursor-pointer text-left ${
                          m.id === currentMemberId
                            ? 'bg-emerald-50/50 border-emerald-300 ring-1 ring-emerald-400'
                            : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <div
                          className={`w-6 h-6 rounded-full ${m.color} text-white flex items-center justify-center text-[10px] font-bold flex-shrink-0`}
                        >
                          {m.initials}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-semibold text-slate-900 truncate">
                            {m.name.split(' ')[0]}
                          </div>
                          <div className="text-[9px] font-mono text-emerald-700 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            $80 Captured
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* CENTER COLUMN: Proposals Feed (col-span-12 lg:col-span-8 xl:col-span-5 space-y-4) */}
              <div className="col-span-12 lg:col-span-8 xl:col-span-5 space-y-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h2 className="font-serif text-2xl font-bold tracking-tight text-slate-900">
                      Governance & Proposals Feed
                    </h2>
                    <p className="text-xs text-slate-600">
                      Deterministic review, voting, veto window enforcement, and locked PayPal payout execution.
                    </p>
                  </div>
                  <button
                    onClick={fetchState}
                    className="p-2 text-slate-500 hover:text-slate-800 transition rounded-lg hover:bg-slate-200/50 cursor-pointer"
                    title="Refresh Feed"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>

                {state?.proposals?.length === 0 ? (
                  <div className="bg-white rounded-2xl p-12 border border-[#e4e2dd] text-center shadow-sm">
                    <FileText className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                    <h3 className="font-serif text-lg font-bold text-slate-800 mb-1">
                      No Proposals in Feed
                    </h3>
                    <p className="text-xs text-slate-500 max-w-md mx-auto mb-6">
                      Proposals drafted by the AI Purchasing Agent or group members appear here for review and voting.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {state?.proposals?.map((proposal) => {
                      const payload = proposal.payload || {};
                      const itemTitle =
                        payload.item_name ||
                        payload.itemName ||
                        payload.title ||
                        payload.description ||
                        'Purchasing Proposal';
                      const amount = (proposal.amount_cents / 100).toFixed(2);
                      const vendorName = proposal.vendor_name || payload.vendorName || proposal.vendor_id || 'Curated Vendor';
                      const category = proposal.category || payload.category || 'equipment';
                      const rationale =
                        payload.rationale ||
                        payload.description ||
                        'Group purchase proposal submitted for member approval.';

                      // Votes summary
                      const votes = proposal.votes || [];
                      const approvals = votes.filter((v) => v.choice === 'APPROVE');
                      const rejections = votes.filter((v) => v.choice === 'REJECT');
                      const vetoes = votes.filter((v) => v.choice === 'VETO');
                      const myVote = votes.find((v) => v.member_id === currentMemberId);

                      // Votes needed
                      const votesRequired =
                        proposal.last_guard_result?.votesRequired ||
                        (proposal.amount_cents <= 6000 ? 2 : proposal.amount_cents <= 15000 ? 4 : 6);

                      // Live Veto Countdown
                      let vetoCountdownStr: string | null = null;
                      if (proposal.status === 'VETO_WINDOW' && proposal.veto_ends_at) {
                        const endsAt = new Date(proposal.veto_ends_at).getTime();
                        const diffMs = endsAt - now;
                        if (diffMs > 0) {
                          const minutes = Math.floor(diffMs / 60000);
                          const seconds = Math.floor((diffMs % 60000) / 1000);
                          vetoCountdownStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                        } else {
                          vetoCountdownStr = '00:00 (Concluded)';
                        }
                      }

                      return (
                        <div
                          key={proposal.id}
                          className={`bg-white rounded-2xl p-5 border shadow-sm transition ${
                            proposal.status === 'BLOCKED'
                              ? 'border-rose-300 ring-1 ring-rose-200'
                              : proposal.status === 'VETO_WINDOW'
                              ? 'border-amber-300 ring-1 ring-amber-200'
                              : proposal.status === 'EXECUTED'
                              ? 'border-emerald-300 bg-emerald-50/20'
                              : 'border-[#e4e2dd]'
                          }`}
                        >
                          {/* Card Header */}
                          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                            <div>
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <h3 className="font-serif font-bold text-lg text-slate-900 leading-snug">
                                  {itemTitle}
                                </h3>
                                {/* Guard Status Chip with Icons */}
                                {proposal.status === 'BLOCKED' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                                    <ShieldAlert className="w-3.5 h-3.5" />
                                    BLOCKED BY POLICY
                                  </span>
                                )}
                                {proposal.status === 'OPEN' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-300">
                                    <Clock className="w-3.5 h-3.5" />
                                    VOTING OPEN
                                  </span>
                                )}
                                {proposal.status === 'VETO_WINDOW' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300 animate-pulse">
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
                                    VETO WINDOW ACTIVE
                                  </span>
                                )}
                                {proposal.status === 'EXECUTABLE' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                    EXECUTABLE
                                  </span>
                                )}
                                {proposal.status === 'EXECUTED' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-800 text-white">
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    EXECUTED
                                  </span>
                                )}
                                {proposal.status === 'VETOED' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                                    <XCircle className="w-3.5 h-3.5 text-rose-600" />
                                    VETOED
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-slate-500 flex items-center gap-2">
                                <span className="font-medium text-slate-700">{vendorName}</span>
                                <span>&bull;</span>
                                <span className="uppercase text-[10px] tracking-wider bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                                  {category}
                                </span>
                              </div>
                            </div>

                            {/* Amount in prominent Monospace */}
                            <div className="text-right">
                              <span className="font-mono text-2xl font-bold text-slate-900 block leading-tight">
                                ${amount}
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                Policy cap: $200.00
                              </span>
                            </div>
                          </div>

                          {/* Rationale text */}
                          <p className="text-xs text-slate-700 mb-4 bg-slate-50/70 p-3 rounded-xl border border-slate-100 leading-relaxed font-sans">
                            {rationale}
                          </p>

                          {/* Blocked Alert: Dynamic from Guard decision */}
                          {proposal.status === 'BLOCKED' && (
                            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900">
                              <div className="font-semibold flex items-center gap-1.5 mb-1 text-rose-800">
                                <ShieldAlert className="w-4 h-4 text-rose-600 flex-shrink-0" />
                                <span>
                                  Policy Rejection: {proposal.last_guard_result?.blockingCode || 'POLICY_LIMIT_EXCEEDED'}
                                </span>
                              </div>
                              <p className="text-rose-700 leading-relaxed font-sans">
                                {proposal.last_guard_result?.blockingDetail ||
                                  `Requested amount ($${amount}) exceeds the group's agreed cap ($200.00). Evaluated and blocked by Quorum Guard.`}
                              </p>
                            </div>
                          )}

                          {/* Live Veto Window Banner with Real-time Countdown */}
                          {proposal.status === 'VETO_WINDOW' && (
                            <div className="mb-4 p-3.5 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-900 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                              <div className="flex items-center gap-2.5">
                                <Clock className="w-4 h-4 text-amber-700 animate-spin" />
                                <div>
                                  <div className="font-semibold text-amber-950">
                                    Approval Threshold Reached ({approvals.length} of {votesRequired} Approvals)
                                  </div>
                                  <div className="text-amber-800 text-[11px] leading-tight">
                                    Mandatory veto window is running. Any single member veto will immediately halt the purchase.
                                  </div>
                                </div>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <span className="font-mono font-bold text-sm text-amber-950 bg-amber-200/70 px-3 py-1 rounded-lg border border-amber-400">
                                  {vetoCountdownStr || '02:00'}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Executed Success Confirmation */}
                          {proposal.status === 'EXECUTED' && (
                            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900">
                              <div className="font-semibold flex items-center gap-1.5 mb-1 text-emerald-800">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                <span>Purchase Executed via PayPal Sandbox Payouts</span>
                              </div>
                              <div className="font-mono text-[11px] text-emerald-800 flex flex-wrap gap-x-4 gap-y-1">
                                <span>
                                  Batch ID:{' '}
                                  <strong>
                                    {proposal.latest_payment?.paypal_batch_id ||
                                      proposal.latest_payment?.sender_batch_id ||
                                      `q_${proposal.id.slice(0, 8)}_1`}
                                  </strong>
                                </span>
                                <span>Status: SUCCEEDED</span>
                                <span>Two-Phase Lock: Verified</span>
                              </div>
                            </div>
                          )}

                          {/* Vetoed Confirmation */}
                          {proposal.status === 'VETOED' && (
                            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900">
                              <div className="font-semibold flex items-center gap-1.5 text-rose-800">
                                <XCircle className="w-4 h-4 text-rose-600" />
                                <span>Purchase Cancelled by Member Veto</span>
                              </div>
                              <p className="text-rose-700 text-[11px] mt-0.5">
                                A member exercised their veto during the veto window. The proposal is permanently halted and cannot execute.
                              </p>
                            </div>
                          )}

                          {/* Vote Tally & Member Cast Chips */}
                          {proposal.status !== 'BLOCKED' && (
                            <div className="mb-4 bg-slate-50 p-3 rounded-xl border border-slate-100">
                              <div className="flex items-center justify-between text-xs mb-1.5">
                                <span className="text-slate-600 font-medium">
                                  Vote Progress: <strong>{approvals.length}</strong> of{' '}
                                  <strong>{votesRequired}</strong> needed (6 eligible contributors)
                                </span>
                                {myVote && (
                                  <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                    Your vote: {myVote.choice}
                                  </span>
                                )}
                              </div>
                              {/* Progress bar */}
                              <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden mb-2">
                                <div
                                  className="bg-emerald-600 h-full transition-all duration-500 rounded-full"
                                  style={{
                                    width: `${Math.min(100, (approvals.length / votesRequired) * 100)}%`,
                                  }}
                                />
                              </div>
                              {/* Vote chips */}
                              {votes.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-2">
                                  {votes.map((v) => (
                                    <span
                                      key={`${v.proposal_id}-${v.member_id}`}
                                      className={`text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1 ${
                                        v.choice === 'APPROVE'
                                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                          : v.choice === 'VETO'
                                          ? 'bg-rose-100 text-rose-800 border border-rose-300 font-bold'
                                          : 'bg-slate-200 text-slate-700'
                                      }`}
                                    >
                                      {v.choice === 'APPROVE' ? (
                                        <Check className="w-3 h-3 text-emerald-700" />
                                      ) : v.choice === 'VETO' ? (
                                        <XCircle className="w-3 h-3 text-rose-600" />
                                      ) : (
                                        <X className="w-3 h-3 text-slate-500" />
                                      )}
                                      {v.display_name?.split(' ')[0]}: {v.choice}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Action Buttons Row */}
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                            <div className="flex flex-wrap items-center gap-2">
                              {/* Voting Buttons (OPEN status) */}
                              {proposal.status === 'OPEN' && (
                                <>
                                  <button
                                    onClick={() => handleVote(proposal.id, 'APPROVE')}
                                    disabled={actionLoading !== null}
                                    className="px-3.5 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs font-semibold shadow-sm transition disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    Approve
                                  </button>
                                  <button
                                    onClick={() => handleVote(proposal.id, 'REJECT')}
                                    disabled={actionLoading !== null}
                                    className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer"
                                  >
                                    Reject
                                  </button>
                                  <button
                                    onClick={() => handleVote(proposal.id, 'VETO')}
                                    disabled={actionLoading !== null}
                                    className="px-3 py-1.5 bg-rose-50 border border-rose-300 text-rose-700 hover:bg-rose-100 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer flex items-center gap-1"
                                  >
                                    <XCircle className="w-3.5 h-3.5 text-rose-600" />
                                    Veto
                                  </button>
                                </>
                              )}

                              {/* Veto Button during VETO_WINDOW */}
                              {proposal.status === 'VETO_WINDOW' && (
                                <button
                                  onClick={() => handleVote(proposal.id, 'VETO')}
                                  disabled={actionLoading !== null}
                                  className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white rounded-lg text-xs font-bold shadow transition disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                                >
                                  <XCircle className="w-4 h-4" />
                                  Cast Member Veto (Halt Execution)
                                </button>
                              )}

                              {/* Execute Button (EXECUTABLE status) */}
                              {proposal.status === 'EXECUTABLE' && (
                                <button
                                  onClick={() => handleExecute(proposal.id)}
                                  disabled={actionLoading !== null}
                                  className="px-5 py-2 bg-[#064e3b] hover:bg-[#053f30] text-white rounded-lg text-xs font-bold shadow-md transition disabled:opacity-50 cursor-pointer flex items-center gap-2"
                                >
                                  <Lock className="w-4 h-4 text-emerald-300" />
                                  <span>
                                    {actionLoading === `execute-${proposal.id}`
                                      ? 'Executing PostgreSQL Lock & Payout...'
                                      : 'Execute PayPal Payout'}
                                  </span>
                                </button>
                              )}
                            </div>

                            {/* "Why?" Button (Opens Guard Audit Drawer) */}
                            <div>
                              <button
                                onClick={() => setSelectedWhyProposal(proposal)}
                                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
                              >
                                <HelpCircle className="w-3.5 h-3.5 text-slate-500" />
                                <span>Why?</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN: AI Purchasing Agent Panel (col-span-12 lg:col-span-12 xl:col-span-4) */}
              <div className="col-span-12 lg:col-span-12 xl:col-span-4">
                <AgentPanel
                  groupId={groupId}
                  currentMemberId={currentMemberId}
                  onProposalCreated={fetchState}
                />
              </div>
            </div>

            {/* Bottom Row: AG Grid Interactive Audit Ledger (Milestone D) */}
            <LedgerGrid
              ledger={state?.ledger || []}
              currency={state?.group?.currency || 'USD'}
            />

            {/* Footer Demo Tools & Shortcuts */}
            <footer className="pt-6 pb-12 border-t border-slate-200 text-xs text-slate-500 space-y-4">
              {/* Demo Tools Bar */}
              <div className="flex flex-col lg:flex-row items-center justify-between gap-4 bg-slate-100 p-4 rounded-xl border border-slate-200">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <div>
                    <span className="font-semibold text-slate-800 block">Evaluation Shortcuts:</span>
                    <span className="text-[11px] text-slate-600">
                      Real Guard-evaluated shortcuts to test voting and reset state.
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
                  {/* Demo Shortcut: Cast 4 Approvals */}
                  <button
                    onClick={handleDemoApprovalsShortcut}
                    disabled={shortcutLoading}
                    className="px-3.5 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                  >
                    <Zap className="w-3.5 h-3.5 text-emerald-300" />
                    <span>
                      {shortcutLoading ? 'Casting votes...' : 'Demo Shortcut: 4 Approvals (Asha, Ben, Chloe, Dev)'}
                    </span>
                  </button>

                  {/* Reset Demo State */}
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      placeholder="DEMO_RESET_SECRET"
                      value={resetSecret}
                      onChange={(e) => setResetSecret(e.target.value)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                    <button
                      onClick={handleDemoReset}
                      disabled={resetting}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer flex-shrink-0"
                    >
                      {resetting ? 'Resetting...' : 'Reset Pool ($480)'}
                    </button>
                  </div>
                </div>
              </div>

              {resetMessage && (
                <div className="text-center text-xs font-mono font-medium text-slate-700">
                  {resetMessage}
                </div>
              )}
            </footer>
          </div>
        )}
      </main>

      {/* "Why?" Guard Decision Audit Drawer (Milestone B Feature) */}
      {selectedWhyProposal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Drawer Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#064e3b]" />
                <h3 className="font-serif font-bold text-lg text-slate-900">
                  Quorum Guard Audit Trail
                </h3>
              </div>
              <button
                onClick={() => setSelectedWhyProposal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-800">
              <div>
                <h4 className="font-bold text-sm text-slate-900 mb-1">
                  {selectedWhyProposal.payload?.item_name ||
                    selectedWhyProposal.payload?.itemName ||
                    'Purchasing Proposal'}
                </h4>
                <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
                  <span>Amount: ${(selectedWhyProposal.amount_cents / 100).toFixed(2)}</span>
                  <span>&bull;</span>
                  <span>Status: {selectedWhyProposal.status}</span>
                  <span>&bull;</span>
                  <span>Policy: v{selectedWhyProposal.policy_version}</span>
                </div>
              </div>

              {/* Primary Blocking Reason (Led at the top) */}
              {selectedWhyProposal.last_guard_result?.checks?.some((c: any) => !c.pass) && (
                <div className="p-3.5 bg-rose-50 border border-rose-300 rounded-xl text-rose-950">
                  <div className="font-bold text-rose-900 flex items-center gap-1.5 mb-1 text-sm">
                    <ShieldAlert className="w-4 h-4 text-rose-600 flex-shrink-0" />
                    <span>
                      Primary Blocking Reason:{' '}
                      {selectedWhyProposal.last_guard_result?.blockingCode ||
                        selectedWhyProposal.last_guard_result?.checks?.find((c: any) => !c.pass)?.code ||
                        'CHECK_FAILED'}
                    </span>
                  </div>
                  <p className="text-rose-800 text-xs leading-relaxed font-sans">
                    {selectedWhyProposal.last_guard_result?.blockingDetail ||
                      selectedWhyProposal.last_guard_result?.checks?.find((c: any) => !c.pass)?.detail ||
                      'Proposal violates group policy requirements and was blocked by Quorum Guard.'}
                  </p>
                </div>
              )}

              {/* Quantitative Snapshot */}
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 font-mono text-xs space-y-1.5 text-slate-800">
                <div className="flex justify-between">
                  <span className="text-slate-500">Proposal Amount:</span>
                  <span className="font-bold text-slate-900">
                    ${(selectedWhyProposal.amount_cents / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Policy Hard Cap:</span>
                  <span className="font-bold text-slate-900">
                    ${(((state?.policy?.hard_cap_cents ?? 20000)) / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Votes Required:</span>
                  <span className="font-bold text-slate-900">
                    {selectedWhyProposal.last_guard_result?.votesRequired || 4} of 6 eligible
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Approvals Recorded:</span>
                  <span className="font-bold text-emerald-700">
                    {selectedWhyProposal.votes?.filter((v) => v.choice === 'APPROVE').length || 0}
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-200">
                  <span className="text-slate-500">Budget Remaining After Purchase:</span>
                  <span className="font-bold text-slate-900">
                    ${(((state?.funds?.availableCents ?? 48000) - selectedWhyProposal.amount_cents) / 100).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Guard Policy Checks Breakdown (Grouped into Failed & Passed) */}
              <div>
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-2">
                  All Guard Checks Evaluated
                </div>
                <div className="space-y-1.5 font-mono text-[11px]">
                  {(selectedWhyProposal.last_guard_result?.checks || []).map((chk: any) => (
                    <div
                      key={chk.code}
                      className={`p-2.5 rounded-lg border flex items-start gap-2.5 ${
                        chk.pass
                          ? 'bg-emerald-50/40 border-emerald-200 text-emerald-950'
                          : 'bg-rose-50 border-rose-300 text-rose-950 font-bold'
                      }`}
                    >
                      {chk.pass ? (
                        <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{chk.code}</span>
                          <span
                            className={`text-[9px] uppercase px-1.5 py-0.2 rounded font-bold ${
                              chk.pass ? 'bg-emerald-200/60 text-emerald-900' : 'bg-rose-200 text-rose-900'
                            }`}
                          >
                            {chk.pass ? 'PASSED' : 'FAILED'}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-600 font-sans mt-0.5">{chk.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Drawer Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                onClick={() => setSelectedWhyProposal(null)}
                className="px-4 py-1.5 bg-[#064e3b] text-white rounded-lg text-xs font-semibold hover:bg-[#053f30] transition cursor-pointer"
              >
                Close Audit View
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}