import React from 'react';

export default function HomePage() {
  return (
    <main className="max-w-5xl mx-auto px-4 py-12">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-8 mb-8 shadow-xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-4 h-4 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-semibold tracking-wider uppercase text-emerald-400">
            PayPal AI Hackathon 2026
          </span>
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight mb-3">
          Quorum <span className="text-indigo-400">Governance Engine</span>
        </h1>
        <p className="text-slate-300 text-lg max-w-2xl">
          Deterministic multi-agent group purchasing & governance agent on PayPal Sandbox.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href="/api/health"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition"
          >
            Check API Health (/api/health) &rarr;
          </a>
          <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm border border-slate-700">
            Pooled Mode: Active ($480.00 Sandbox Balance)
          </span>
        </div>
      </div>

      {/* Core Architectural Promise */}
      <div className="bg-white rounded-xl p-6 border border-slate-200 shadow-sm mb-8">
        <h2 className="text-xl font-bold text-slate-900 mb-2">
          Non-Negotiable Product Promise
        </h2>
        <blockquote className="text-slate-700 italic border-l-4 border-indigo-600 pl-4 py-1 text-base">
          &ldquo;No individual member can independently authorize a purchase. Every expenditure must satisfy the group&rsquo;s agreed policy and approval requirements.&rdquo;
        </blockquote>
      </div>

      {/* Grid of Verified Core Subsystems */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="text-indigo-600 font-bold text-sm uppercase tracking-wide mb-1">Subsystem 1</div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Quorum Guard Core</h3>
          <p className="text-slate-600 text-sm leading-relaxed mb-3">
            100% pure deterministic evaluator (zero I/O, no DB, no LLM). 49/49 unit & fast-check property tests passing.
          </p>
          <div className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-md inline-block">
            Verified (100% Green)
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="text-indigo-600 font-bold text-sm uppercase tracking-wide mb-1">Subsystem 2</div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Payment Concurrency</h3>
          <p className="text-slate-600 text-sm leading-relaxed mb-3">
            Direct interactive PostgreSQL row-locking (`SELECT ... FOR UPDATE SKIP LOCKED`), reservation before payout, idempotent batch IDs.
          </p>
          <div className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-md inline-block">
            Verified (100% Green)
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="text-indigo-600 font-bold text-sm uppercase tracking-wide mb-1">Subsystem 3</div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Gemini Adapt Loop</h3>
          <p className="text-slate-600 text-sm leading-relaxed mb-3">
            Multi-turn structured tool calling (`gemini-3.8-flash`). Visible $350 blocked proposal followed by $145 compliant proposal.
          </p>
          <div className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-md inline-block">
            Verified (100% Green)
          </div>
        </div>
      </div>

      {/* REST API Endpoints Overview */}
      <div className="bg-slate-100 rounded-xl p-6 border border-slate-200">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700 mb-3">
          Live REST API Endpoints
        </h3>
        <div className="space-y-2 font-mono text-xs text-slate-800">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold">GET</span>
            <span>/api/health &mdash; System heartbeat & keep-alive</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold">POST</span>
            <span>/api/agent/chat &mdash; AI purchasing agent with Adapt Loop</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold">POST</span>
            <span>/api/webhooks/paypal &mdash; Ingest & verify live PayPal webhooks</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold">POST</span>
            <span>/api/proposals/[id]/vote &mdash; Member voting & veto window</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-semibold">POST</span>
            <span>/api/proposals/[id]/execute &mdash; Direct pg locked payout</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold">GET</span>
            <span>/api/groups/[id]/state &mdash; Full state & financial ledger</span>
          </div>
        </div>
      </div>
    </main>
  );
}
