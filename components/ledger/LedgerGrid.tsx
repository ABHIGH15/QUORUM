'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  AllCommunityModule,
  ColDef,
  RowClickedEvent,
  GridReadyEvent,
} from 'ag-grid-community';
import {
  Activity,
  Search,
  SlidersHorizontal,
  Eye,
  Copy,
  Check,
  ShieldCheck,
  X,
  FileText,
  DollarSign,
  Clock,
  UserCheck,
} from 'lucide-react';

// Register AG Grid Community modules
ModuleRegistry.registerModules([AllCommunityModule]);

export interface LedgerEvent {
  id: number;
  group_id: string;
  sequence_num?: number;
  type: string;
  actor_kind: string;
  actor_id?: string;
  amount_cents?: number | null;
  reference_type?: string;
  reference_id?: string;
  data: any;
  created_at: string;
}

interface LedgerGridProps {
  ledger: LedgerEvent[];
  currency?: string;
}

export default function LedgerGrid({ ledger, currency = 'USD' }: LedgerGridProps) {
  const [quickFilterText, setQuickFilterText] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<LedgerEvent | null>(null);
  const [copied, setCopied] = useState(false);

  // Column Definitions
  const columnDefs = useMemo<ColDef<LedgerEvent>[]>(() => {
    return [
      {
        field: 'id',
        headerName: 'Event ID',
        width: 105,
        pinned: 'left',
        sortable: true,
        filter: true,
        cellRenderer: (params: any) => {
          return (
            <span className="font-mono text-xs font-semibold text-slate-500">
              #{params.value}
            </span>
          );
        },
      },
      {
        field: 'created_at',
        headerName: 'Timestamp',
        width: 140,
        sortable: true,
        filter: true,
        valueFormatter: (params: any) => {
          if (!params.value) return '—';
          const d = new Date(params.value);
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        },
        cellRenderer: (params: any) => {
          return (
            <span className="font-mono text-xs text-slate-600" title={params.value}>
              {params.valueFormatted}
            </span>
          );
        },
      },
      {
        field: 'type',
        headerName: 'Event Type',
        width: 220,
        sortable: true,
        filter: true,
        cellRenderer: (params: any) => {
          const type = String(params.value || '');
          let style = 'bg-slate-100 text-slate-800 border-slate-300';

          if (type.includes('CAPTURED')) {
            style = 'bg-emerald-50 text-emerald-800 border-emerald-300 font-semibold';
          } else if (type.includes('RESERVED')) {
            style = 'bg-amber-50 text-amber-900 border-amber-300 font-semibold';
          } else if (type.includes('PAYOUT_INITIATED')) {
            style = 'bg-blue-50 text-blue-900 border-blue-300 font-semibold';
          } else if (type.includes('PAYOUT_SUCCEEDED') || type.includes('PAYMENT_EXECUTED')) {
            style = 'bg-emerald-800 text-white font-bold';
          } else if (type.includes('RELEASED')) {
            style = 'bg-teal-50 text-teal-800 border-teal-300';
          } else if (type.includes('BLOCKED') || type.includes('FAILED') || type.includes('VETO')) {
            style = 'bg-rose-50 text-rose-800 border-rose-300 font-semibold';
          }

          return (
            <span
              className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono border ${style}`}
            >
              {type}
            </span>
          );
        },
      },
      {
        field: 'actor_kind',
        headerName: 'Actor',
        width: 110,
        sortable: true,
        filter: true,
        cellRenderer: (params: any) => {
          return (
            <span className="font-mono text-xs text-slate-700 capitalize">
              {params.value || 'SYSTEM'}
            </span>
          );
        },
      },
      {
        field: 'amount_cents',
        headerName: 'Amount',
        width: 120,
        sortable: true,
        filter: true,
        cellClass: 'text-right font-mono',
        cellRenderer: (params: any) => {
          if (params.value === null || params.value === undefined) {
            return <span className="text-slate-400 font-mono">—</span>;
          }
          return (
            <span className="font-mono font-semibold text-slate-900">
              ${(params.value / 100).toFixed(2)}
            </span>
          );
        },
      },
      {
        field: 'reference_type',
        headerName: 'Reference',
        width: 130,
        sortable: true,
        filter: true,
        cellRenderer: (params: any) => {
          if (!params.value) return <span className="text-slate-400 font-mono">—</span>;
          return (
            <span className="font-mono text-[11px] text-slate-600">
              {params.value}
            </span>
          );
        },
      },
      {
        field: 'data',
        headerName: 'Details / Metadata',
        flex: 1,
        minWidth: 220,
        sortable: false,
        filter: false,
        cellRenderer: (params: any) => {
          const str = JSON.stringify(params.value || {});
          return (
            <span
              className="font-mono text-xs text-slate-500 truncate block cursor-pointer hover:text-slate-900"
              title="Click row to inspect full JSON payload"
            >
              {str}
            </span>
          );
        },
      },
      {
        headerName: 'Audit',
        width: 85,
        pinned: 'right',
        sortable: false,
        filter: false,
        cellRenderer: (params: any) => {
          return (
            <button
              onClick={() => setSelectedEvent(params.data)}
              className="px-2 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded border border-emerald-300 transition cursor-pointer flex items-center gap-1"
              title="Inspect Full Audit Record"
            >
              <Eye className="w-3 h-3" />
              <span>View</span>
            </button>
          );
        },
      },
    ];
  }, []);

  const defaultColDef = useMemo<ColDef>(() => {
    return {
      resizable: true,
    };
  }, []);

  const onRowClicked = useCallback((event: RowClickedEvent<LedgerEvent>) => {
    if (event.data) {
      setSelectedEvent(event.data);
    }
  }, []);

  const handleCopyJson = () => {
    if (!selectedEvent) return;
    navigator.clipboard.writeText(JSON.stringify(selectedEvent, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white rounded-2xl p-5 border border-[#e4e2dd] shadow-sm space-y-4">
      {/* Top Header & Search Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#064e3b]" />
            <h2 className="font-serif text-base font-bold text-slate-900">
              Interactive Audit Ledger (AG Grid)
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-300 rounded font-semibold">
              Immutable PostgreSQL
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 font-sans">
            Cryptographically sound, append-only financial and governance transaction log with live filtering and inspection.
          </p>
        </div>

        {/* Quick Filter Input */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={quickFilterText}
              onChange={(e) => setQuickFilterText(e.target.value)}
              placeholder="Search ledger events..."
              className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-300 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700 bg-slate-50/50"
            />
          </div>
          <span className="text-[11px] font-mono text-slate-500 px-2 py-1 bg-slate-100 rounded border border-slate-200 whitespace-nowrap">
            {ledger.length} Events
          </span>
        </div>
      </div>

      {/* AG Grid Table Container */}
      <div className="ag-theme-quartz w-full h-[360px] rounded-xl overflow-hidden border border-slate-200 text-xs">
        <AgGridReact
          rowData={ledger}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          quickFilterText={quickFilterText}
          onRowClicked={onRowClicked}
          rowSelection="single"
          animateRows={true}
          pagination={true}
          paginationPageSize={10}
          paginationPageSizeSelector={[10, 20, 50]}
        />
      </div>

      {/* Ledger Event Inspection Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#064e3b]" />
                <h3 className="font-serif font-bold text-base text-slate-900">
                  Ledger Record #{selectedEvent.id} Details
                </h3>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-800">
              {/* Event Type & Amount Summary */}
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
                <div>
                  <span className="text-[10px] uppercase font-mono text-slate-500 block font-semibold">
                    Event Type
                  </span>
                  <span className="font-mono text-sm font-bold text-slate-900">
                    {selectedEvent.type}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] uppercase font-mono text-slate-500 block font-semibold">
                    Amount
                  </span>
                  <span className="font-mono text-lg font-bold text-emerald-800">
                    {selectedEvent.amount_cents
                      ? `$${(selectedEvent.amount_cents / 100).toFixed(2)}`
                      : '—'}
                  </span>
                </div>
              </div>

              {/* Event Metadata Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                  <span className="text-slate-400 block text-[10px] uppercase">Actor</span>
                  <span className="font-semibold text-slate-800">{selectedEvent.actor_kind}</span>
                  {selectedEvent.actor_id && (
                    <span className="text-[10px] text-slate-500 block truncate">
                      {selectedEvent.actor_id}
                    </span>
                  )}
                </div>
                <div className="p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                  <span className="text-slate-400 block text-[10px] uppercase">Timestamp</span>
                  <span className="font-semibold text-slate-800">
                    {new Date(selectedEvent.created_at).toLocaleString()}
                  </span>
                </div>
                {selectedEvent.reference_type && (
                  <div className="p-2.5 rounded-lg border border-slate-100 bg-slate-50/50 col-span-2">
                    <span className="text-slate-400 block text-[10px] uppercase">Reference</span>
                    <span className="font-semibold text-slate-800">
                      {selectedEvent.reference_type}: {selectedEvent.reference_id || 'N/A'}
                    </span>
                  </div>
                )}
              </div>

              {/* JSON Payload Inspection */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                    Payload Data (JSON)
                  </span>
                  <button
                    onClick={handleCopyJson}
                    className="text-[11px] font-mono text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span className="text-emerald-700">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy JSON</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="bg-slate-900 text-slate-100 p-3.5 rounded-xl font-mono text-[11px] overflow-x-auto max-h-56">
                  <pre>{JSON.stringify(selectedEvent.data, null, 2)}</pre>
                </div>
              </div>

              {/* Integrity Guarantee Footer */}
              <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200 text-[11px] text-emerald-950 flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-700 flex-shrink-0 mt-0.5" />
                <span>
                  Ledger event is committed in PostgreSQL table <code>public.ledger</code> with Row Level Security and strict append-only constraints.
                </span>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                onClick={() => setSelectedEvent(null)}
                className="px-4 py-1.5 bg-[#064e3b] text-white rounded-lg text-xs font-semibold hover:bg-[#053f30] transition cursor-pointer"
              >
                Close Audit Record
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
