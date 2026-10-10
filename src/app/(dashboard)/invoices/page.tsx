'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, Search, FileText, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import Button from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { IInvoice, IClient } from '@/types';
import { formatCurrency, formatDate } from '@/lib/utils';

const STATUS_TABS = [
  { value: '',        label: 'All' },
  { value: 'draft',   label: 'Draft' },
  { value: 'sent',    label: 'Sent' },
  { value: 'paid',    label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
];

function InvoicesContent() {
  const searchParams  = useSearchParams();
  const router        = useRouter();
  const statusFilter  = searchParams.get('status') ?? '';

  const [invoices, setInvoices] = useState<IInvoice[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = statusFilter ? `?status=${statusFilter}` : '';
    fetch(`/api/invoices${params}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setInvoices(d.data); })
      .finally(() => setLoading(false));
  }, [statusFilter]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this invoice? This cannot be undone.')) return;
    setDeleting(id);
    await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
    setInvoices((prev) => prev.filter((inv) => inv._id !== id));
    setDeleting(null);
  }

  const filtered = invoices.filter((inv) => {
    const client = typeof inv.clientId === 'object' ? inv.clientId as IClient : null;
    const q = search.toLowerCase();
    return (
      inv.title.toLowerCase().includes(q) ||
      inv.invoiceNumber.toLowerCase().includes(q) ||
      (client?.name.toLowerCase().includes(q) ?? false)
    );
  });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="text-sm text-slate-400 mt-0.5">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''} total</p>
        </div>
        <Link href="/invoices/new">
          <Button>
            <Plus size={15} /> New Invoice
          </Button>
        </Link>
      </div>

      {/* Tabs + Search row */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Status tabs */}
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl overflow-x-auto flex-shrink-0">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => router.push(tab.value ? `/invoices?status=${tab.value}` : '/invoices')}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-150 ${
                statusFilter === tab.value
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search by title, number, or client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 transition-all hover:border-slate-300"
          />
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 border-b border-slate-50">
              <div className="skeleton h-4 w-32 rounded" />
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-4 w-20 rounded ml-auto" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 bg-white rounded-2xl border border-slate-100 text-center px-6">
          <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center mb-4">
            <FileText size={26} className="text-slate-300" />
          </div>
          <p className="font-semibold text-slate-700 mb-1">No invoices found</p>
          <p className="text-sm text-slate-400 mb-6">
            {search ? 'Try a different search term' : 'Create your first invoice to get started'}
          </p>
          {!search && (
            <Link href="/invoices/new">
              <Button size="sm"><Plus size={14} /> New Invoice</Button>
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Invoice</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Client</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Amount</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Status</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Due Date</th>
                  <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((inv) => {
                  const client = typeof inv.clientId === 'object' ? inv.clientId as IClient : null;
                  return (
                    <tr key={inv._id} className="hover:bg-slate-50/70 transition-colors group">
                      <td className="px-5 py-4">
                        <p className="text-sm font-semibold text-slate-800 group-hover:text-blue-600 transition-colors">
                          {inv.title}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5 font-mono">{inv.invoiceNumber}</p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm text-slate-700 font-medium">{client?.name ?? '—'}</p>
                        {client?.company && (
                          <p className="text-xs text-slate-400">{client.company}</p>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm font-bold text-slate-900">{formatCurrency(inv.total)}</p>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={inv.status} />
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm text-slate-500">{formatDate(inv.dueDate)}</p>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <Link href={`/invoices/${inv._id}`}>
                            <Button variant="ghost" size="sm" className="flex items-center gap-1">
                              View <ChevronRight size={13} />
                            </Button>
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                            loading={deleting === inv._id}
                            onClick={() => handleDelete(inv._id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <InvoicesContent />
    </Suspense>
  );
}
