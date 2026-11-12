'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  Bot,
  Send,
  Search,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  ArrowRight,
  Info,
  Zap,
} from 'lucide-react';

export interface AgentExecutionStep {
  step: number;
  action: 'SEARCH' | 'EVALUATE' | 'PROPOSE_BLOCKED' | 'ADAPT' | 'PROPOSE_SUCCESS';
  detail: string;
  data?: any;
}

export interface AgentRunResponse {
  success: boolean;
  userQuery: string;
  finalMessage: string;
  proposedItem?: {
    id: string;
    name: string;
    priceCents: number;
    proposalId: string;
  };
  steps: AgentExecutionStep[];
  adaptationOccurred: boolean;
  engine?: 'LIVE_GEMINI' | 'DETERMINISTIC_REPLAY';
  model?: string;
  rateLimited?: boolean;
}

interface AgentPanelProps {
  groupId: string;
  currentMemberId: string;
  onProposalCreated?: () => void;
}

const SAMPLE_PROMPTS = [
  {
    label: '🎬 Movie night projector',
    query: 'Find a 4K projector for movie night',
    desc: 'Demonstrates $350 item blocked by $200 cap, then adapts to $145 OptiView HD',
  },
  {
    label: '🔊 Audio upgrade',
    query: 'Find wireless surround speakers under $100',
    desc: 'Searches catalog for compliant audio options',
  },
  {
    label: '🖥️ Projection screen',
    query: 'Find a high-contrast projection screen',
    desc: 'Searches catalog and drafts compliant proposal',
  },
];

export default function AgentPanel({ groupId, currentMemberId, onProposalCreated }: AgentPanelProps) {
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AgentRunResponse | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const handleSend = async (messageText?: string) => {
    const query = (messageText || inputMessage).trim();
    if (!query) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-quorum-member-id': currentMemberId,
        },
        body: JSON.stringify({
          groupId,
          message: query,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Agent failed to process query');
      }

      setLastResult(data);
      if (messageText) {
        setInputMessage(messageText);
      }

      // Notify parent to refetch proposals feed
      if (data.proposedItem || data.success) {
        if (onProposalCreated) {
          onProposalCreated();
        }
      }
    } catch (err: any) {
      console.error('[Agent Panel Error]', err);
      setError(err.message || 'Failed to communicate with AI agent');
    } finally {
      setLoading(false);
    }
  };

  const getActionBadge = (action: AgentExecutionStep['action']) => {
    switch (action) {
      case 'SEARCH':
        return {
          icon: <Search className="w-3.5 h-3.5 text-blue-600" />,
          bg: 'bg-blue-50 border-blue-200 text-blue-900',
          label: 'CATALOG SEARCH',
        };
      case 'EVALUATE':
        return {
          icon: <ShieldCheck className="w-3.5 h-3.5 text-purple-600" />,
          bg: 'bg-purple-50 border-purple-200 text-purple-900',
          label: 'POLICY EVALUATION',
        };
      case 'PROPOSE_BLOCKED':
        return {
          icon: <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />,
          bg: 'bg-rose-50 border-rose-300 text-rose-950 font-bold',
          label: 'QUORUM GUARD BLOCKED',
        };
      case 'ADAPT':
        return {
          icon: <Zap className="w-3.5 h-3.5 text-amber-600" />,
          bg: 'bg-amber-50 border-amber-300 text-amber-950 font-bold',
          label: 'GUARD-GUIDED ADAPTATION',
        };
      case 'PROPOSE_SUCCESS':
        return {
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          bg: 'bg-emerald-50 border-emerald-300 text-emerald-950 font-bold',
          label: 'PROPOSAL CREATED (OPEN)',
        };
      default:
        return {
          icon: <Info className="w-3.5 h-3.5 text-slate-500" />,
          bg: 'bg-slate-50 border-slate-200 text-slate-800',
          label: 'STEP',
        };
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-[#e4e2dd] shadow-sm overflow-hidden flex flex-col h-full">
      {/* Panel Header */}
      <div className="p-4 sm:p-5 border-b border-slate-100 bg-slate-50/70">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-900 text-emerald-100 flex items-center justify-center shadow-xs">
              <Bot className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-serif text-base font-bold text-slate-900 leading-tight">
                Purchasing Agent
              </h3>
            </div>
          </div>

          {/* Engine Status Badge: Shows real live state */}
          <div>
            {lastResult?.engine === 'LIVE_GEMINI' ? (
              <span
                title={`Executed via live Google Gemini API (${lastResult.model || 'Flash'}) with structured function calling`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-ping" />
                Live Gemini
              </span>
            ) : lastResult?.engine === 'DETERMINISTIC_REPLAY' ? (
              <span
                title="Runs real tools, catalog search, and Quorum Guard via rule-based fallback when Gemini API is unavailable or rate-limited"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-amber-50 text-amber-900 border border-amber-300"
              >
                <Sparkles className="w-3 h-3 text-amber-600" />
                Rule-based fallback (Gemini rate-limited)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-900 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                Live Gemini
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed font-sans">
          Researches items in the curated catalog, verifies against Quorum Guard limits, and auto-adapts if blocked.
        </p>
      </div>

      {/* Main Body */}
      <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-4 overflow-y-auto max-h-[620px]">
        {/* Sample Prompt Chips */}
        <div>
          <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400 block mb-2 font-semibold">
            Try a demo purchasing request:
          </span>
          <div className="space-y-1.5">
            {SAMPLE_PROMPTS.map((p, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(p.query)}
                disabled={loading}
                className="w-full text-left p-2 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-slate-100 hover:border-slate-300 transition cursor-pointer text-xs group disabled:opacity-50"
              >
                <div className="font-semibold text-slate-800 flex items-center justify-between">
                  <span>{p.label}</span>
                  <ArrowRight className="w-3 h-3 text-slate-400 group-hover:translate-x-0.5 transition" />
                </div>
                <div className="text-[11px] text-slate-500 font-sans mt-0.5 truncate">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Typing / Thinking Indicator while agent works */}
        {loading && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 flex items-center gap-3 animate-pulse">
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-[11px] text-slate-600 font-medium">
              Agent is researching catalog, evaluating policy rules, and preparing proposal…
            </span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-semibold block">Agent Request Failed</span>
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Execution Steps Timeline */}
        {lastResult && (
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase font-mono tracking-wider text-slate-500 font-bold">
                Adapt Loop Timeline ({lastResult.steps.length} Steps)
              </span>
              {lastResult.adaptationOccurred && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 font-bold">
                  Adaptation Succeeded
                </span>
              )}
            </div>

            <div className="space-y-2">
              {lastResult.steps.map((st) => {
                const badge = getActionBadge(st.action);
                const isExpanded = expandedStep === st.step;
                return (
                  <div
                    key={st.step}
                    className={`rounded-xl border p-2.5 transition text-xs ${badge.bg}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <span className="flex-shrink-0 mt-0.5">{badge.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                            <span className="font-mono text-[10px] font-bold uppercase tracking-wider">
                              Step {st.step}: {badge.label}
                            </span>
                          </div>
                          <p className="text-[11px] leading-snug font-sans">{st.detail}</p>
                        </div>
                      </div>

                      {st.data && (
                        <button
                          onClick={() => setExpandedStep(isExpanded ? null : st.step)}
                          className="text-[10px] font-mono underline text-slate-500 hover:text-slate-800 flex-shrink-0 cursor-pointer ml-1"
                        >
                          {isExpanded ? 'Hide' : 'Inspect'}
                        </button>
                      )}
                    </div>

                    {/* Step Raw Data payload */}
                    {isExpanded && st.data && (
                      <div className="mt-2 pt-2 border-t border-slate-200/60 font-mono text-[10px] bg-white/70 p-2 rounded overflow-x-auto max-h-36">
                        <pre>{JSON.stringify(st.data, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Final Agent Response Message */}
            <div className="p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-xl text-xs text-slate-800 space-y-2">
              <div className="flex items-center gap-1.5 text-emerald-900 font-bold">
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                <span>Agent Outcome</span>
              </div>
              <p className="text-slate-700 leading-relaxed font-sans">{lastResult.finalMessage}</p>

              {lastResult.proposedItem && (
                <div className="pt-2 border-t border-emerald-200/60 flex items-center justify-between text-[11px]">
                  <span className="font-mono text-emerald-950 font-semibold">
                    Proposal #{lastResult.proposedItem.proposalId.slice(0, 8)}: $
                    {(lastResult.proposedItem.priceCents / 100).toFixed(2)}
                  </span>
                  <span className="text-emerald-700 font-semibold">
                    Submitted to Feed &rarr;
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="p-4 border-t border-slate-200 bg-white">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            disabled={loading}
            placeholder="Ask agent: e.g. 'Find a 4K projector'..."
            className="flex-1 px-3.5 py-2 rounded-xl border border-slate-300 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 bg-slate-50/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !inputMessage.trim()}
            className="px-4 py-2 bg-[#064e3b] hover:bg-[#053f30] text-white rounded-xl text-xs font-semibold shadow-xs transition disabled:opacity-40 cursor-pointer flex items-center gap-1.5 flex-shrink-0"
          >
            {loading ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Thinking...</span>
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                <span>Send</span>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
