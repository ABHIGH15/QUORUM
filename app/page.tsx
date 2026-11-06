'use client';

import React, { useEffect, useState } from 'react';

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
  const [fetchError, setFetchError] = useState<string | null>(null);

  const checkHealth = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHealth(data);
    } catch (err: any) {
      setFetchError(err.message || 'Failed to connect to health endpoint');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
  }, []);

  return (
    <main className="max-w-5xl mx-auto px-4 py-12">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-8 mb-8 shadow-xl">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold tracking-wider uppercase text-emerald-400">
              PayPal AI Hackathon 2026
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={checkHealth}
              disabled={loading}
              className="text-slate-400 hover:text-white transition underline cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Checking status...' : 'Refresh Health'}
            </button>
          </div>
        </div>

        <h1 className="text-4xl font-extrabold tracking-tight mb-3">
          Quorum <span className="text-indigo-400">Governance Engine</span>
        </h1>
        <p className="text-slate-300 text-lg max-w-2xl mb-6">
          Deterministic multi-agent group purchasing & governance agent on PayPal Sandbox.
        </p>

        {/* Dynamic System Heartbeat Banner */}
        <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`w-3.5 h-3.5 rounded-full ${
                health?.status === 'healthy'
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
                  <span className="text-slate-400">Querying /api/health...</span>
                ) : health?.status === 'healthy' ? (
                  <span className="text-emerald-400">Healthy (PostgreSQL Connected)</span>
                ) : (
                  <span className="text-amber-400">Degraded (Database Disconnected)</span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {health?.database.status === 'connected'
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
            onClick={async () => {
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
            }}
            className="w-full md:w-auto inline-flex items-center justify-center px-6 py-3.5 rounded-xl bg-emerald-800 hover:bg-emerald-700 text-white font-semibold text-sm shadow-md hover:shadow-lg transition cursor-pointer gap-2"
          >
            <span>Open Demo Workspace</span>
            <span className="text-emerald-300 font-mono text-xs">(as Asha Patel)</span>
            <span>&rarr;</span>
          </button>
        </div>
      </div>

      {/* Grid of Core Architectural Subsystems */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="text-indigo-600 font-bold text-xs uppercase tracking-wider mb-1">Subsystem 1</div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Quorum Guard Core</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-4">
              100% pure deterministic evaluator (§6). Zero I/O, zero database access, and zero LLM calls. Governs approval thresholds, quorum requirements, and mandatory veto windows.
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
            <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">Race-Proof</span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="text-indigo-600 font-bold text-xs uppercase tracking-wider mb-1">Subsystem 3</div>
            <h3 className="text-base font-bold text-slate-900 mb-2">Gemini Adapt Loop</h3>
            <p className="text-slate-600 text-sm leading-relaxed mb-4">
              Multi-turn structured tool calling (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded">gemini-3.8-flash</code>). Explores catalog options, handles Guard policy rejections transparently, and adapts autonomously.
            </p>
          </div>
          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Structured Tool Use</span>
            <span className="font-mono font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">Autonomous</span>
          </div>
        </div>
      </div>

      {/* REST API Endpoints Overview */}
      <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">
          Live Backend Endpoints
        </h3>
        <div className="space-y-2.5 font-mono text-xs text-slate-800">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold text-[10px]">GET</span>
            <span className="font-semibold text-slate-900">/api/health</span>
            <span className="text-slate-500 font-sans">&mdash; Zero-cost keep-alive & database connectivity check</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/agent/chat</span>
            <span className="text-slate-500 font-sans">&mdash; Gemini purchasing agent with multi-turn Adapt Loop</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold text-[10px]">POST</span>
            <span className="font-semibold text-slate-900">/api/webhooks/paypal</span>
            <span className="text-slate-500 font-sans">&mdash; Ingest & cryptographic verification of PayPal Sandbox webhooks</span>
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
      </div>
    </main>
  );
}