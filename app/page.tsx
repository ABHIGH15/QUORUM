'use client';

import React, { useEffect, useState, useRef } from 'react';

interface HealthData {
  status: 'healthy' | 'degraded';
  service: string;
  timestamp: string;
  uptimeSeconds: number;
  latencyMs: number;
  database: {
    status: string;
    activeGroups: number;
    error?: string | null;
  };
  version: string;
}

export default function HomePage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [wakingUp, setWakingUp] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const checkHealth = async () => {
    setLoading(true);
    setWakingUp(false);
    setFetchError(null);

    // If health check takes > 4s, notify user that server is waking up
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setWakingUp(true);
    }, 4000);

    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHealth(data);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to connect to health endpoint');
    } finally {
      if (timerRef.current) clearTimeout(timerRef.current);
      setLoading(false);
      setWakingUp(false);
    }
  };

  useEffect(() => {
    checkHealth();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleLaunch = async () => {
    const ashaId = '20000000-0000-0000-0000-000000000001';
    document.cookie = `quorum_member_id=${ashaId}; path=/; max-age=2592000`;
    try {
      await fetch('/api/auth/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: ashaId }),
      });
    } catch {}
    window.location.href = '/g/00000000-0000-0000-0000-000000000001';
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-12">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-8 mb-8 shadow-xl">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold tracking-wider uppercase text-emerald-400">
              Governed Purchasing
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={checkHealth}
              disabled={loading}
              className="text-slate-400 hover:text-white transition underline cursor-pointer disabled:opacity-50"
            >
              {loading ? (wakingUp ? 'Waking up server...' : 'Checking status...') : 'Refresh Health'}
            </button>
          </div>
        </div>

        <h1 className="text-4xl font-extrabold tracking-tight mb-3">Quorum</h1>
        <p className="text-slate-300 text-lg max-w-2xl mb-6">
          Group purchases that follow the group&apos;s rules. AI proposes, members vote or veto, a rules engine decides, PayPal pays.
        </p>

        {/* Dynamic System Heartbeat Banner */}
        <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-3.5 h-3.5 rounded-full ${
                loading && wakingUp
                  ? 'bg-amber-400 animate-pulse'
                  : health?.status === 'healthy'
                  ? 'bg-emerald-400 ring-4 ring-emerald-500/20'
                  : health?.status === 'degraded'
                  ? 'bg-amber-400 ring-4 ring-amber-500/20'
                  : 'bg-slate-500'
              }`}
            />
            <div>
              <div className="text-sm font-semibold text-white flex items-center gap-2">
                System Status:{' '}
                {loading ? (
                  wakingUp ? (
                    <span className="text-amber-300">Waking up the server, this can take up to a minute…</span>
                  ) : (
                    <span className="text-slate-400">Checking status…</span>
                  )
                ) : health?.status === 'healthy' ? (
                  <span className="text-emerald-400">Healthy (PostgreSQL Connected)</span>
                ) : (
                  <span className="text-amber-400">Degraded (Database Disconnected)</span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {loading && wakingUp
                  ? 'Free tier web service is resuming from cold standby'
                  : health?.database.status === 'connected'
                  ? `Active Groups: ${health.database.activeGroups} | Latency: ${health.latencyMs}ms | Uptime: ${health.uptimeSeconds}s`
                  : health?.database.error
                  ? `Error: ${health.database.error}`
                  : 'Awaiting database connection string in deployment environment'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition"
            >
              Raw Health JSON &rarr;
            </a>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-2">
          <span>Demo Pool: <strong className="text-slate-200">$480.00</strong> (Simulated initial contribution ledger: 6 members &times; $80.00)</span>
          <span className="text-slate-400">Live payouts draw directly on PayPal Sandbox business balance</span>
        </div>
      </div>

      {/* Core Architectural Promise & Quick Demo Launch */}
      <div className="bg-white rounded-xl p-6 border border-slate-200 shadow-sm mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="max-w-2xl">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            Non-Negotiable Product Promise
          </h2>
          <blockquote className="text-slate-800 italic border-l-4 border-emerald-800 pl-4 py-1 text-lg font-serif">
            &ldquo;No individual member can independently authorize a purchase. Every expenditure must satisfy the group&rsquo;s agreed policy and approval requirements.&rdquo;
          </blockquote>
        </div>
        <div className="flex-shrink-0">
          <button
            onClick={handleLaunch}
            className="w-full md:w-auto inline-flex items-center justify-center px-6 py-3.5 rounded-xl bg-emerald-800 hover:bg-emerald-700 text-white font-semibold text-sm shadow-md hover:shadow-lg transition cursor-pointer gap-2"
          >
            <span>Open Demo Workspace</span>
            <span>&rarr;</span>
          </button>
        </div>
      </div>

      {/* Try It in 60 Seconds: Quick Tour */}
      <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-2xl p-6 sm:p-8 mb-8 shadow-xl border border-slate-700/60">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-slate-700/80">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono font-bold uppercase tracking-wider">
                Quick tour
              </span>
              <h2 className="text-xl font-bold font-serif text-white">
                Try Quorum in 60 Seconds
              </h2>
            </div>
            <p className="text-xs text-slate-300">
              Run the complete governance loop from purchasing prompt to row-locked PayPal payout in five simple steps. <span className="text-amber-300 font-medium">Note: State is shared; use &ldquo;Reset Demo Pool&rdquo; if the feed looks unfamiliar.</span>
            </p>
          </div>
          <button
            onClick={handleLaunch}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-xl transition shadow-xs cursor-pointer flex items-center gap-1.5"
          >
            <span>Open Demo Workspace</span>
            <span>&rarr;</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-slate-800/90 rounded-xl p-4 border border-slate-700 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center mb-2 border border-emerald-500/30">
                1
              </div>
              <h3 className="font-semibold text-sm text-white mb-1">Ask Agent</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Click sample prompt <em>&ldquo;Movie night projector&rdquo;</em> in the AI agent panel.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-emerald-400">
              Prompt &rarr; Search
            </div>
          </div>

          <div className="bg-slate-800/90 rounded-xl p-4 border border-slate-700 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center mb-2 border border-emerald-500/30">
                2
              </div>
              <h3 className="font-semibold text-sm text-white mb-1">See Policy Block</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                $350 item blocked by $200 cap; agent adapts down to $145 OptiView HD.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-rose-400">
              Blocked &rarr; Adapted
            </div>
          </div>

          <div className="bg-slate-800/90 rounded-xl p-4 border border-slate-700 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center mb-2 border border-emerald-500/30">
                3
              </div>
              <h3 className="font-semibold text-sm text-white mb-1">Approve as Members</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Click <em>&ldquo;Approve as 4 members (demo)&rdquo;</em> to cast votes for Asha, Ben, Chloe, Dev.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-amber-400">
              4 of 4 Approvals
            </div>
          </div>

          <div className="bg-slate-800/90 rounded-xl p-4 border border-slate-700 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center mb-2 border border-emerald-500/30">
                4
              </div>
              <h3 className="font-semibold text-sm text-white mb-1">Watch Veto Window</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Live 2-minute countdown starts. Any member (e.g. Elena) can veto.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-indigo-400">
              02:00 Countdown
            </div>
          </div>

          <div className="bg-slate-800/90 rounded-xl p-4 border border-slate-700 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center mb-2 border border-emerald-500/30">
                5
              </div>
              <h3 className="font-semibold text-sm text-white mb-1">Execute Payment</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Click <em>&ldquo;Execute Payment&rdquo;</em>. Interactive row-lock reserves funds &amp; submits PayPal Payout.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-700/60 text-[11px] font-mono text-emerald-400">
              PayPal Batch ID
            </div>
          </div>
        </div>
      </div>

      {/* Grid of Core Architectural Subsystems */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="text-indigo-600 font-bold text-xs uppercase tracking-wider mb-1">Subsystem 1</div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Quorum Guard Core</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-4">
              Pure function: no database, network or AI calls. Enforces approval thresholds, quorum requirements, and mandatory veto windows.
            </p>
          </div>
          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Fast-check Property Suite</span>
            <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">49 Tests</span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="text-indigo-600 font-bold text-xs uppercase tracking-wider mb-1">Subsystem 2</div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Payment Concurrency</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-4">
              Direct interactive PostgreSQL row-locking (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded">FOR UPDATE</code>). Two-phase funds reservation before external PayPal Payouts API calls with idempotent batch IDs.
            </p>
          </div>
          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Partial Unique Index</span>
            <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">One live payment per proposal</span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="text-indigo-600 font-bold text-xs uppercase tracking-wider mb-1">Subsystem 3</div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Gemini Adapt Loop</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-4">
              Multi-turn structured tool calling (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded">gemini-3.5-flash</code>). Explores catalog options, handles Guard policy rejections transparently, and adapts autonomously.
            </p>
          </div>
          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Structured Tool Use</span>
            <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">Tool-using agent</span>
          </div>
        </div>
      </div>

      {/* REST API Endpoints: Collapsible For Developers Section */}
      <details className="group bg-slate-50 rounded-xl p-5 border border-slate-200 mb-8 cursor-pointer">
        <summary className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center justify-between select-none">
          <span>For developers: Live Backend Endpoints</span>
          <span className="font-mono text-slate-400 group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <div className="mt-4 pt-3 border-t border-slate-200 space-y-2.5 font-mono text-xs text-slate-800 cursor-default">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold text-[10px]">GET</span>
            <span className="font-semibold text-slate-900">/api/health</span>
            <span className="text-slate-500 font-sans">&mdash; Zero-cost keep-alive &amp; database connectivity check</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/agent/chat</span>
            <span className="text-slate-500 font-sans">&mdash; Gemini purchasing agent with structured tool execution</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/webhooks/paypal</span>
            <span className="text-slate-500 font-sans">&mdash; Ingest &amp; cryptographic verification of PayPal Sandbox webhooks</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/proposals/[id]/vote</span>
            <span className="text-slate-500 font-sans">&mdash; Member voting, approval threshold check, and veto window</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/proposals/[id]/execute</span>
            <span className="text-slate-500 font-sans">&mdash; Row-locked payment execution via PayPal Sandbox Payouts</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold text-[10px]">GET</span>
            <span className="font-semibold text-slate-900">/api/groups/[id]/state</span>
            <span className="text-slate-500 font-sans">&mdash; Complete group state, financial ledger, and proposals</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-amber-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/demo/reset</span>
            <span className="text-slate-500 font-sans">&mdash; Protected administrative seed for demo group (simulated $480 initial contribution ledger)</span>
          </div>
        </div>
      </details>

      {/* Footer */}
      <footer className="pt-6 border-t border-slate-200 text-xs text-slate-500 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
        <div>
          <p>
            Quorum enforces group policy. It is not escrow.
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Built for the PayPal AI Hackathon 2026 &middot; PayPal sandbox, no real money.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs font-medium">
          <a
            href="https://github.com/ABHIGH15/QUORUM"
            target="_blank"
            rel="noreferrer"
            className="text-slate-600 hover:text-slate-900 underline transition"
          >
            GitHub
          </a>
          <span className="text-slate-300">&bull;</span>
          <span className="text-slate-600">MIT License</span>
        </div>
      </footer>
    </main>
  );
}
