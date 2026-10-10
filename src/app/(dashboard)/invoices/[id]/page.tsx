'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Edit2, Trash2, CheckCircle, Clock, Send, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import Button from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import InvoiceForm from '@/components/invoices/InvoiceForm';
import { IInvoice, IClient } from '@/types';
import { formatCurrency, formatDate } from '@/lib/utils';

const STATUS_ACTIONS: { status: IInvoice['status']; label: string; icon: typeof CheckCircle }[] = [
  { status: 'draft',   label: 'Draft',   icon: Clock },
  { status: 'sent',    label: 'Sent',    icon: Send },
  { status: 'paid',    label: 'Paid',    icon: CheckCircle },
  { status: 'overdue', label: 'Overdue', icon: AlertCircle },
];

export default function InvoiceDetailPage() {
  const { id }   = useParams<{ id: string }>();
  const router   = useRouter();
  const [invoice, setInvoice]   = useState<IInvoice | null>(null);
  const [clients, setClients]   = useState<IClient[]>([]);
  const [loading, setLoading]   = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    Promise.all([fetch(`/api/invoices/${id}`), fetch('/api/clients')])
      .then(([r1, r2]) => Promise.all([r1.json(), r2.json()]))
      .then(([d1, d2]) => {
        if (d1.success) setInvoice(d1.data);
        if (d2.success) setClients(d2.data);
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleStatusChange(status: IInvoice['status']) {
    const res  = await fetch(`/api/invoices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.success) setInvoice(data.data);
  }

  async function handleEdit(formData: Parameters<typeof InvoiceForm>[0]['onSubmit'] extends (d: infer D) => unknown ? D : never) {
    setEditError('');
    const res  = await fetch(`/api/invoices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
    const data = await res.json();
    if (!data.success) { setEditError(data.error ?? 'Failed to update'); return; }
    setInvoice(data.data);
    setEditOpen(false);
  }

  async function handleDelete() {
    if (!confirm('Delete this invoice? This cannot be undone.')) return;
    setDeleting(true);
    await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
    router.push('/invoices');
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="skeleton h-10 w-64 rounded-xl" />
        <div className="skeleton h-96 rounded-2xl" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-slate-500 font-medium mb-3">Invoice not found</p>
        <Link href="/invoices" className="text-sm text-blue-600 hover:underline">Back to invoices</Link>
      </div>
    );
  }

  const client = typeof invoice.clientId === 'object' ? invoice.clientId as IClient : null;

  return (
    <div className="max-w-3xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link
            href="/invoices"
            className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-tight">{invoice.title}</h1>
            <p className="text-xs text-slate-400 font-mono mt-0.5">{invoice.invoiceNumber}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Edit2 size={13} /> Edit
          </Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
            <Trash2 size={13} /> Delete
          </Button>
        </div>
      </div>

      {/* Invoice card */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">

        {/* Status bar */}
        <div className="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusBadge status={invoice.status} />
            <span className="text-sm text-slate-500">Due {formatDate(invoice.dueDate)}</span>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {STATUS_ACTIONS.filter((a) => a.status !== invoice.status).map(({ status, label, icon: Icon }) => (
              <button
                key={status}
                onClick={() => handleStatusChange(status)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all"
              >
                <Icon size={12} />
                Mark {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-6">

          {/* From / To */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">From</p>
              <p className="text-sm font-semibold text-slate-800">Your Business</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">To</p>
              {client ? (
                <div>
                  <p className="text-sm font-semibold text-slate-800">{client.name}</p>
                  {client.company && <p className="text-xs text-slate-500 mt-0.5">{client.company}</p>}
                  <p className="text-xs text-slate-500">{client.email}</p>
                  {client.phone && <p className="text-xs text-slate-500">{client.phone}</p>}
                </div>
              ) : (
                <p className="text-sm text-slate-400">Client not found</p>
              )}
            </div>
          </div>

          {invoice.description && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Description</p>
              <p className="text-sm text-slate-700 leading-relaxed">{invoice.description}</p>
            </div>
          )}

          {/* Line items */}
          <div>
            <div className="rounded-xl border border-slate-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-3">Description</th>
                    <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-3">Qty</th>
                    <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-3">Rate</th>
                    <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-3">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {invoice.lineItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-4 py-3 text-slate-700">{item.description}</td>
                      <td className="px-4 py-3 text-right text-slate-500">{item.quantity}</td>
                      <td className="px-4 py-3 text-right text-slate-500">{formatCurrency(item.rate)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-800">{formatCurrency(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="mt-4 ml-auto max-w-xs space-y-2">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal</span>
                <span>{formatCurrency(invoice.subtotal)}</span>
              </div>
              {invoice.taxRate > 0 && (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Tax ({invoice.taxRate}%)</span>
                  <span>{formatCurrency(invoice.tax)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-900 border-t border-slate-200 pt-2">
                <span>Total</span>
                <span className="text-lg">{formatCurrency(invoice.total)}</span>
              </div>
            </div>
          </div>

          {invoice.notes && (
            <div className="bg-slate-50 border border-slate-100 rounded-xl p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Notes</p>
              <p className="text-sm text-slate-700 leading-relaxed">{invoice.notes}</p>
            </div>
          )}

          <p className="text-xs text-slate-400 text-right">
            Created {formatDate(invoice.createdAt)}
          </p>
        </div>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Invoice" size="xl">
        {editError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            {editError}
          </div>
        )}
        <InvoiceForm clients={clients} initial={invoice} onSubmit={handleEdit} submitLabel="Save Changes" />
      </Modal>
    </div>
  );
}
