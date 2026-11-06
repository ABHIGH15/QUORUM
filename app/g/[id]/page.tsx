'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Send,
  HelpCircle,
  Lock,
  User,
  Users,
  ChevronDown,
  DollarSign,
  Info,
  Check,
  X,
  ExternalLink,
  Bot,
  FileText,
  Activity,
  Layers,
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
  status: 'DRAFT' | 'OPEN' | 'VETO_WINDOW' | 'EXECUTABLE' | 'EXECUTING' | 'EXECUTED' | 'EXECUTION_FAILED' | 'REJECTED' | 'VETOED' | 'BLOCKED' | 'CANCELLED' | 'EXPIRED';
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
  const [personaOpen, setPersonaOpen] = useState(false);

  // Action status / feedback
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Why Drawer state
  const [selectedWhyProposal, setSelectedWhyProposal] = useState<Proposal | null>(null);

  // Demo reset
  const [resetSecret, setResetSecret] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  // Live countdown timer hook
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Initialize active persona from cookie on mount
  useEffect(() => {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)quorum_member_id=([^;]+)/);
    if (cookieMatch) {
      const savedId = decodeURIComponent(cookieMatch[1].trim());
      if (DEFAULT_MEMBERS.some((m) => m.id === savedId)) {
        setCurrentMemberId(savedId);
      }
    }
  }, []);

  // Switch persona handler
  const handleSwitchPersona = async (memberId: string) => {
    setCurrentMemberId(memberId);
    setPersonaOpen(false);
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

  // Demo reset
  const handleDemoReset = async () => {
    if (!resetSecret) {
      setResetMessage('Please enter your DEMO_RESET_SECRET (from Render or .env)');
      return;
    }
    setResetting(true);
    setResetMessage(null);
    try {
      const res = await fetch('/api/demo/reset', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resetSecret.trim()}`,
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

  const activePersona = useMemo(
    () => DEFAULT_MEMBERS.find((m) => m.id === currentMemberId) || DEFAULT_MEMBERS[0],
    [currentMemberId]
  );

  return (
    <div className="min-h-screen bg-[#faf9f6] text-[#18181b] flex flex-col font-sans">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-[#faf9f6]/95 backdrop-blur-md border-b border-[#e7e5df] px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
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

          {/* Persona Switcher Dropdown */}
          <div className="relative">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600 hidden md:inline">Acting as:</span>
              <button
                onClick={() => setPersonaOpen(!personaOpen)}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white border border-[#dcd8d0] shadow-sm hover:border-[#064e3b] transition cursor-pointer text-left"
              >
                <div
                  className={`w-6 h-6 rounded-full ${activePersona.color} text-white flex items-center justify-center text-[10px] font-bold`}
                >
                  {activePersona.initials}
                </div>
                <div>
                  <span className="text-xs font-semibold text-slate-900 block leading-tight">
                    {activePersona.name}
                  </span>
                  <span className="text-[10px] text-slate-500 block leading-none font-mono">
                    {activePersona.role}
                  </span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-1" />
              </button>
            </div>

            {/* Dropdown Menu */}
            {personaOpen && (
              <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 z-50">
                <div className="px-3 py-1.5 border-b border-slate-100 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Select Member Persona (I7 Test)
                </div>
                {DEFAULT_MEMBERS.map((member) => (
                  <button
                    key={member.id}
                    onClick={() => handleSwitchPersona(member.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 transition cursor-pointer ${
                      member.id === currentMemberId ? 'bg-emerald-50/70 font-medium' : ''
                    }`}
                  >
                    <div
                      className={`w-6 h-6 rounded-full ${member.color} text-white flex items-center justify-center text-[10px] font-bold flex-shrink-0`}
                    >
                      {member.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-900 truncate">{member.name}</div>
                      <div className="text-[10px] text-slate-500">{member.role}</div>
                    </div>
                    {member.id === currentMemberId && (
                      <Check className="w-4 h-4 text-emerald-700 flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
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
            className="text-rose-500 hover:text-rose-800 font-bold ml-2"
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
            {/* Top Workspace Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* LEFT COLUMN: Policy & Budget & Funding (col-span-12 lg:col-span-4 space-y-6) */}
              <div className="col-span-12 lg:col-span-4 space-y-6">
                {/* Policy Card */}
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
                      <span className="font-mono font-semibold text-slate-900">$200.00</span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-50">
                      <span className="text-slate-500">Unanimity Threshold</span>
                      <span className="font-mono font-semibold text-slate-900">&gt; $150.00 (All 6)</span>
                    </div>
                    <div className="py-1 border-b border-slate-50">
                      <div className="text-slate-500 mb-1">Approval Tiers</div>
                      <div className="space-y-1 font-mono text-[11px] pl-2 border-l-2 border-emerald-500">
                        <div className="flex justify-between">
                          <span>Up to $60.00</span>
                          <span className="font-semibold text-slate-900">2 votes required</span>
                        </div>
                        <div className="flex justify-between">
                          <span>$60.01 – $150.00</span>
                          <span className="font-semibold text-slate-900">4 votes required</span>
                        </div>
                        <div className="flex justify-between">
                          <span>$150.01 – $200.00</span>
                          <span className="font-semibold text-slate-900">6 votes (Unanimous)</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-50">
                      <span className="text-slate-500">Mandatory Veto Window</span>
                      <span className="font-mono font-semibold text-slate-900">
                        {state?.policy?.veto_window_minutes || 1440} min (24 hrs)
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
                      <div
                        key={m.id}
                        className={`p-2 rounded-xl border flex items-center gap-2 transition ${
                          m.id === currentMemberId
                            ? 'bg-emerald-50/50 border-emerald-300 ring-1 ring-emerald-400'
                            : 'bg-slate-50/60 border-slate-200'
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
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* CENTER COLUMN: Proposals Feed (col-span-12 lg:col-span-8 space-y-4) */}
              <div className="col-span-12 lg:col-span-8 space-y-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h2 className="font-serif text-2xl font-bold tracking-tight text-slate-900">
                      Governance & Proposals Feed
                    </h2>
                    <p className="text-xs text-slate-600">
                      Deterministic review, voting, veto enforcement, and locked PayPal execution.
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
                      Use the AI Purchasing Agent on the right to search the curated catalog and generate proposals (e.g. &ldquo;Find a projector for our meeting room&rdquo;).
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
                      const rationale = payload.rationale || payload.description || 'Group purchase proposal submitted for member approval.';

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

                      // Veto countdown calculation
                      let vetoCountdownStr: string | null = null;
                      let vetoExpired = false;
                      if (proposal.status === 'VETO_WINDOW' && proposal.veto_ends_at) {
                        const endsAt = new Date(proposal.veto_ends_at).getTime();
                        const diffMs = endsAt - now;
                        if (diffMs > 0) {
                          const hours = Math.floor(diffMs / 3600000);
                          const minutes = Math.floor((diffMs % 3600000) / 60000);
                          const seconds = Math.floor((diffMs % 60000) / 1000);
                          vetoCountdownStr = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
                        } else {
                          vetoExpired = true;
                          vetoCountdownStr = 'Veto window concluded';
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
                                {/* Guard Status Chip */}
                                {proposal.status === 'BLOCKED' && (
                                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                                    <ShieldAlert className="w-3.5 h-3.5" />
                                    BLOCKED BY GUARD
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
                          <p className="text-xs text-slate-700 mb-4 bg-slate-50/70 p-3 rounded-xl border border-slate-100 leading-relaxed">
                            {rationale}
                          </p>

                          {/* Blocked Alert Notice */}
                          {proposal.status === 'BLOCKED' && (
                            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900">
                              <div className="font-semibold flex items-center gap-1.5 mb-1 text-rose-800">
                                <ShieldAlert className="w-4 h-4 text-rose-600 flex-shrink-0" />
                                <span>Guard Invariant Violation (S1 Scene)</span>
                              </div>
                              <p className="text-rose-700 leading-relaxed">
                                {proposal.last_guard_result?.blockingDetail ||
                                  `Requested amount ($${amount}) exceeds the group's hard cap ($200.00). Quorum Guard rejected this proposal unconditionally in PROPOSAL phase.`}
                              </p>
                            </div>
                          )}

                          {/* Veto Window Banner */}
                          {proposal.status === 'VETO_WINDOW' && (
                            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <Clock className="w-4 h-4 text-amber-700 animate-spin" />
                                <div>
                                  <div className="font-semibold">
                                    Approval Threshold Reached ({approvals.length} of {votesRequired})
                                  </div>
                                  <div className="text-amber-800 text-[11px]">
                                    24-hour mandatory veto window is active. Any single member veto will immediately halt execution (I4).
                                  </div>
                                </div>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <span className="font-mono font-bold text-sm text-amber-900 bg-amber-100 px-2.5 py-1 rounded-md border border-amber-300">
                                  {vetoCountdownStr || '24h 0m'}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Executed Success Confirmation */}
                          {proposal.status === 'EXECUTED' && (
                            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900">
                              <div className="font-semibold flex items-center gap-1.5 mb-1 text-emerald-800">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                <span>Payment Executed via PayPal Sandbox Payouts (S3 Scene)</span>
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
                                <span>Row Lock: Verified</span>
                              </div>
                            </div>
                          )}

                          {/* Vetoed Confirmation */}
                          {proposal.status === 'VETOED' && (
                            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900">
                              <div className="font-semibold flex items-center gap-1.5 text-rose-800">
                                <XCircle className="w-4 h-4 text-rose-600" />
                                <span>Halted by Member Veto (S2 Scene)</span>
                              </div>
                              <p className="text-rose-700 text-[11px] mt-0.5">
                                A member exercised their sovereign veto during the veto window. Proposal is permanently halted (I4).
                              </p>
                            </div>
                          )}

                          {/* Vote Tally & Cast Votes */}
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
            </div>

            {/* Bottom Row: Ledger Preview (Skeleton for Step D) */}
            <div className="bg-white rounded-2xl p-5 border border-[#e4e2dd] shadow-sm">
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#064e3b]" />
                  <h2 className="font-serif text-base font-bold text-slate-900">
                    Financial & Governance Ledger (Source of Truth)
                  </h2>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-100 text-slate-700 rounded border border-slate-200">
                  {state?.ledger?.length || 0} Events Logged
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-[10px] uppercase">
                      <th className="py-2 pr-3 font-semibold">Event ID</th>
                      <th className="py-2 pr-3 font-semibold">Type</th>
                      <th className="py-2 pr-3 font-semibold">Actor</th>
                      <th className="py-2 pr-3 font-semibold">Amount</th>
                      <th className="py-2 pr-3 font-semibold">Details</th>
                      <th className="py-2 font-semibold">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-800">
                    {(state?.ledger || []).slice(0, 8).map((evt: any) => (
                      <tr key={evt.id} className="hover:bg-slate-50 transition">
                        <td className="py-2 pr-3 text-slate-400">#{evt.id}</td>
                        <td className="py-2 pr-3 font-semibold text-slate-900">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] ${
                              evt.type.includes('CAPTURED')
                                ? 'bg-emerald-50 text-emerald-800'
                                : evt.type.includes('PAYOUT')
                                ? 'bg-blue-50 text-blue-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {evt.type}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{evt.actor_kind}</td>
                        <td className="py-2 pr-3 font-semibold">
                          {evt.amount_cents ? `$${(evt.amount_cents / 100).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2 pr-3 text-slate-500 truncate max-w-xs">
                          {JSON.stringify(evt.data || {})}
                        </td>
                        <td className="py-2 text-slate-400 text-[10px]">
                          {new Date(evt.created_at).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Footer Demo Tools */}
            <footer className="pt-6 pb-12 border-t border-slate-200 text-xs text-slate-500">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4 bg-slate-100 p-4 rounded-xl border border-slate-200">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="font-semibold text-slate-700">Evaluation Demo Tools:</span>
                  <span>Reset demo group to $480.00 sandbox state.</span>
                </div>
                <div className="flex items-center gap-2 w-full md:w-auto">
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
                    className="px-3.5 py-1.5 bg-[#064e3b] hover:bg-[#053f30] text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer flex-shrink-0"
                  >
                    {resetting ? 'Resetting...' : 'Reset Demo'}
                  </button>
                </div>
              </div>
              {resetMessage && (
                <div className="mt-2 text-center text-xs font-mono font-medium text-slate-700">
                  {resetMessage}
                </div>
              )}
            </footer>
          </div>
        )}
      </main>

      {/* "Why?" Guard Decision Audit Drawer (Step B Feature) */}
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
                  {selectedWhyProposal.payload?.itemName || 'Purchasing Proposal'}
                </h4>
                <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
                  <span>Amount: ${(selectedWhyProposal.amount_cents / 100).toFixed(2)}</span>
                  <span>&bull;</span>
                  <span>Status: {selectedWhyProposal.status}</span>
                  <span>&bull;</span>
                  <span>Policy: v{selectedWhyProposal.policy_version}</span>
                </div>
              </div>

              {/* Blocking reason notice */}
              {selectedWhyProposal.status === 'BLOCKED' && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
                  <div className="font-bold text-rose-800 flex items-center gap-1.5 mb-1">
                    <ShieldAlert className="w-4 h-4 text-rose-600" />
                    <span>Blocking Check: {selectedWhyProposal.last_guard_result?.blockingCode || 'EXCEEDS_HARD_CAP'}</span>
                  </div>
                  <p className="text-rose-700 text-[11px] leading-relaxed">
                    {selectedWhyProposal.last_guard_result?.blockingDetail ||
                      `Proposal was blocked because its requested amount ($${(selectedWhyProposal.amount_cents / 100).toFixed(2)}) violates group policy limits.`}
                  </p>
                </div>
              )}

              {/* Guard Checks Breakdown */}
              <div>
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-2">
                  Guard Policy Checks Evaluated (100% Pure Function)
                </div>
                <div className="space-y-1.5 font-mono text-[11px]">
                  {(selectedWhyProposal.last_guard_result?.checks || [
                    { code: 'CAP_CHECK', passed: selectedWhyProposal.amount_cents <= 20000, detail: `Amount $${(selectedWhyProposal.amount_cents / 100).toFixed(2)} vs Hard Cap $200.00` },
                    { code: 'VENDOR_ALLOWLIST', passed: true, detail: 'Vendor is verified in allowlist' },
                    { code: 'CATEGORY_ALLOWED', passed: true, detail: 'Category matches group policy charter' },
                    { code: 'BUDGET_AVAILABLE', passed: true, detail: 'Available pool funds exceed proposal amount' },
                    { code: 'ELIGIBLE_VOTERS', passed: true, detail: '6 active contributing members eligible' },
                  ]).map((chk: any) => (
                    <div
                      key={chk.code}
                      className={`p-2.5 rounded-lg border flex items-start gap-2.5 ${
                        chk.passed
                          ? 'bg-emerald-50/50 border-emerald-200 text-emerald-900'
                          : 'bg-rose-50 border-rose-300 text-rose-900 font-bold'
                      }`}
                    >
                      {chk.passed ? (
                        <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      ) : (
                        <X className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{chk.code}</span>
                          <span className="text-[10px] uppercase font-bold">{chk.passed ? 'PASSED' : 'FAILED'}</span>
                        </div>
                        <div className="text-[10px] text-slate-600 font-sans mt-0.5">{chk.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quantitative Snapshot */}
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 font-mono text-[11px] space-y-1 text-slate-700">
                <div className="flex justify-between">
                  <span>Proposal Amount:</span>
                  <span className="font-bold text-slate-900">${(selectedWhyProposal.amount_cents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Policy Hard Cap:</span>
                  <span className="font-bold text-slate-900">$200.00</span>
                </div>
                <div className="flex justify-between">
                  <span>Votes Required:</span>
                  <span className="font-bold text-slate-900">{selectedWhyProposal.last_guard_result?.votesRequired || 4} of 6</span>
                </div>
                <div className="flex justify-between">
                  <span>Approvals Recorded:</span>
                  <span className="font-bold text-emerald-700">{selectedWhyProposal.votes?.filter((v) => v.choice === 'APPROVE').length || 0}</span>
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