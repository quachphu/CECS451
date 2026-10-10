'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import InvoiceForm from '@/components/invoices/InvoiceForm';
import { IClient } from '@/types';

export default function NewInvoicePage() {
  const router = useRouter();
  const [clients, setClients] = useState<IClient[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/clients')
      .then((r) => r.json())
      .then((d) => { if (d.success) setClients(d.data); })
      .finally(() => setLoadingClients(false));
  }, []);

  async function handleSubmit(data: Parameters<typeof InvoiceForm>[0]['onSubmit'] extends (d: infer D) => unknown ? D : never) {
    setError('');
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.error ?? 'Failed to create invoice');
      return;
    }
    router.push(`/invoices/${json.data._id}`);
  }

  if (loadingClients) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/invoices" className="text-slate-400 hover:text-slate-700 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">New Invoice</h1>
          <p className="text-sm text-slate-500 mt-0.5">Fill in details or use AI to auto-fill</p>
        </div>
      </div>

      {clients.length === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          You have no clients yet.{' '}
          <Link href="/clients" className="font-semibold underline">
            Add a client first
          </Link>{' '}
          before creating an invoice.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
        <InvoiceForm clients={clients} onSubmit={handleSubmit} submitLabel="Create Invoice" />
      </div>
    </div>
  );
}
