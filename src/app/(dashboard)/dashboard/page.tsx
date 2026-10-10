'use client';

import { useEffect, useState } from 'react';
import {
  TrendingUp,
  DollarSign,
  AlertCircle,
  Receipt,
  FileText,
  Plus,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import StatsCard from '@/components/dashboard/StatsCard';
import RevenueChart from '@/components/dashboard/RevenueChart';
import { StatusBadge } from '@/components/ui/Badge';
import { IDashboardStats, IInvoice } from '@/types';
import { formatCurrency, formatDate } from '@/lib/utils';
import Link from 'next/link';

const STATUS_QUICK = [
  { href: '/invoices',              label: 'All',     key: 'invoiceCount',  color: 'text-slate-900' },
  { href: '/invoices?status=paid',  label: 'Paid',    key: 'paidCount',     color: 'text-emerald-600' },
  { href: '/invoices?status=sent',  label: 'Pending', key: 'pendingCount',  color: 'text-blue-600' },
  { href: '/invoices?status=overdue', label: 'Overdue', key: 'overdueCount', color: 'text-red-600' },
] as const;

export default function DashboardPage() {
  const [stats, setStats]       = useState<IDashboardStats | null>(null);
  const [loading, setLoading]   = useState(true);
  const [seeding, setSeeding]   = useState(false);
  const [seedError, setSeedError] = useState('');

  async function loadSampleData() {
    setSeeding(true);
    setSeedError('');
    try {
      const seedRes = await fetch('/api/seed', { method: 'POST' });
      const seedData = await seedRes.json().catch(() => ({}));
      if (!seedRes.ok) {
        setSeedError(seedData.error ?? `Seed failed (${seedRes.status})`);
        return;
      }
      const res = await fetch('/api/dashboard/stats');
      const d   = await res.json();
      if (d.success) setStats(d.data);
    } catch (e) {
      setSeedError('Network error — please try again.');
    } finally {
      setSeeding(false);
    }
  }

  useEffect(() => {
    fetch('/api/dashboard/stats')
      .then((r) => r.json())
      .then((d) => { if (d.success) setStats(d.data); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-100 p-5 h-28 skeleton" />
          ))}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-100 h-72 skeleton" />
          <div className="bg-white rounded-xl border border-slate-100 h-72 skeleton" />
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-slate-500 font-medium">Failed to load dashboard.</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 text-sm text-blue-600 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const isEmpty = stats.invoiceCount === 0 && stats.totalExpenses === 0;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* Empty-state banner — load sample data */}
      {isEmpty && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col sm:flex-row items-center gap-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl px-6 py-5">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-500/20">
              <Sparkles size={18} className="text-white" />
            </div>
            <div className="flex-1 text-center sm:text-left">
              <p className="font-semibold text-slate-800 text-sm">No data yet — load a demo dataset</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Populate your account with 6 clients, 15 invoices, and 23 expenses so you can explore every feature.
              </p>
            </div>
            <button
              onClick={loadSampleData}
              disabled={seeding}
              className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-md shadow-blue-500/20 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 transition-all active:scale-[0.97] flex-shrink-0"
            >
              {seeding ? (
                <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Loading…</>
              ) : (
                <><Sparkles size={14} /> Load Sample Data</>
              )}
            </button>
          </div>
          {seedError && (
            <p className="text-xs text-red-600 font-medium px-1">{seedError}</p>
          )}
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Your financial overview at a glance</p>
        </div>
        <Link
          href="/invoices/new"
          className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-md shadow-blue-500/20 hover:from-blue-700 hover:to-indigo-700 transition-all w-fit"
        >
          <Plus size={15} /> New Invoice
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatsCard
          title="Total Revenue"
          value={formatCurrency(stats.totalRevenue)}
          subtitle={`${stats.paidCount} paid invoice${stats.paidCount !== 1 ? 's' : ''}`}
          icon={<TrendingUp size={18} />}
          color="blue"
        />
        <StatsCard
          title="Pending"
          value={formatCurrency(stats.pendingAmount)}
          subtitle={`${stats.pendingCount} awaiting payment`}
          icon={<DollarSign size={18} />}
          color="yellow"
        />
        <StatsCard
          title="Overdue"
          value={formatCurrency(stats.overdueAmount)}
          subtitle={`${stats.overdueCount} overdue invoice${stats.overdueCount !== 1 ? 's' : ''}`}
          icon={<AlertCircle size={18} />}
          color="red"
        />
        <StatsCard
          title="Total Expenses"
          value={formatCurrency(stats.totalExpenses)}
          subtitle="All time"
          icon={<Receipt size={18} />}
          color="purple"
        />
      </div>

      {/* Chart + Recent invoices */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <RevenueChart data={stats.monthlyRevenue} />
        </div>

        {/* Recent invoices */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-50">
            <p className="text-sm font-semibold text-slate-800">Recent Invoices</p>
            <Link
              href="/invoices"
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium transition-colors"
            >
              View all <ArrowRight size={12} />
            </Link>
          </div>

          {stats.recentInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-5 text-center">
              <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center mb-3">
                <FileText size={22} className="text-slate-300" />
              </div>
              <p className="text-sm font-medium text-slate-500 mb-1">No invoices yet</p>
              <Link
                href="/invoices/new"
                className="text-xs text-blue-600 hover:underline"
              >
                Create your first invoice
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {stats.recentInvoices.map((inv: IInvoice) => {
                const client = typeof inv.clientId === 'object' ? inv.clientId : null;
                return (
                  <Link
                    key={inv._id}
                    href={`/invoices/${inv._id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate group-hover:text-blue-600 transition-colors">
                        {inv.title}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">{client?.name ?? inv.invoiceNumber}</p>
                    </div>
                    <div className="text-right ml-3 flex-shrink-0 space-y-1">
                      <p className="text-sm font-semibold text-slate-900">{formatCurrency(inv.total)}</p>
                      <StatusBadge status={inv.status} />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Quick status links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STATUS_QUICK.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="bg-white border border-slate-100 rounded-xl p-4 text-center hover:shadow-md hover:border-slate-200 transition-all group"
          >
            <p className={`text-2xl font-extrabold ${item.color} leading-none`}>
              {stats[item.key]}
            </p>
            <p className="text-xs text-slate-400 mt-1.5 font-medium">{item.label}</p>
          </Link>
        ))}
      </div>

    </div>
  );
}
