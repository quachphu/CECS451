'use client';

import { useEffect, useState } from 'react';
import { Plus, Receipt, Search, Trash2, Edit2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { CategoryBadge } from '@/components/ui/Badge';
import ExpenseForm from '@/components/expenses/ExpenseForm';
import { IExpense } from '@/types';
import { formatCurrency, formatDate } from '@/lib/utils';

const CATEGORIES = ['All', 'Tools', 'Marketing', 'Utilities', 'Travel', 'Food', 'Office', 'Other'];

const CAT_ICONS: Record<string, string> = {
  Tools: '🔧', Marketing: '📣', Utilities: '💡', Travel: '✈️',
  Food: '🍽️', Office: '🏢', Other: '📦',
};

export default function ExpensesPage() {
  const [expenses, setExpenses]     = useState<IExpense[]>([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [addOpen, setAddOpen]       = useState(false);
  const [editExpense, setEditExpense] = useState<IExpense | null>(null);
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [error, setError]           = useState('');

  useEffect(() => {
    fetch('/api/expenses')
      .then((r) => r.json())
      .then((d) => { if (d.success) setExpenses(d.data); })
      .finally(() => setLoading(false));
  }, []);

  async function handleAdd(data: Omit<IExpense, '_id' | 'userId' | 'createdAt'>) {
    setError('');
    const res  = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.success) { setError(json.error ?? 'Failed to add'); return; }
    setExpenses((prev) => [json.data, ...prev]);
    setAddOpen(false);
  }

  async function handleEdit(data: Omit<IExpense, '_id' | 'userId' | 'createdAt'>) {
    if (!editExpense) return;
    setError('');
    const res  = await fetch(`/api/expenses/${editExpense._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.success) { setError(json.error ?? 'Failed to update'); return; }
    setExpenses((prev) => prev.map((e) => (e._id === editExpense._id ? json.data : e)));
    setEditExpense(null);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this expense?')) return;
    setDeleting(id);
    await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    setExpenses((prev) => prev.filter((e) => e._id !== id));
    setDeleting(null);
  }

  const filtered = expenses.filter((e) => {
    const matchesSearch   = e.title.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'All' || e.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const totalAll      = expenses.reduce((s, e) => s + e.amount, 0);
  const totalFiltered = filtered.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expenses</h1>
          <p className="text-sm text-slate-400 mt-0.5">Total: {formatCurrency(totalAll)}</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={15} /> Add Expense
        </Button>
      </div>

      {/* Category summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {['Tools', 'Marketing', 'Utilities', 'Other'].map((cat) => {
          const catTotal = expenses.filter((e) => e.category === cat).reduce((s, e) => s + e.amount, 0);
          return (
            <button
              key={cat}
              onClick={() => setCategoryFilter(categoryFilter === cat ? 'All' : cat)}
              className={`bg-white border rounded-xl p-4 text-left hover:shadow-md transition-all duration-150 ${
                categoryFilter === cat
                  ? 'border-blue-200 ring-1 ring-blue-200 shadow-sm'
                  : 'border-slate-100 hover:border-slate-200'
              }`}
            >
              <p className="text-lg mb-0.5">{CAT_ICONS[cat]}</p>
              <p className="text-sm font-bold text-slate-900">{formatCurrency(catTotal)}</p>
              <p className="text-xs text-slate-400 mt-0.5">{cat}</p>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search expenses…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 transition-all hover:border-slate-300"
          />
        </div>
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl overflow-x-auto flex-shrink-0">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                categoryFilter === cat
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 border-b border-slate-50">
              <div className="skeleton h-4 w-40 rounded" />
              <div className="skeleton h-4 w-20 rounded ml-auto" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 bg-white rounded-2xl border border-slate-100 text-center px-6">
          <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center mb-4">
            <Receipt size={26} className="text-slate-300" />
          </div>
          <p className="font-semibold text-slate-700 mb-1">No expenses found</p>
          <p className="text-sm text-slate-400 mb-6">
            {search || categoryFilter !== 'All' ? 'Try adjusting your filters' : 'Start tracking your business expenses'}
          </p>
          {!search && categoryFilter === 'All' && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Add Expense
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          {/* Showing bar */}
          <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-100">
            <p className="text-xs text-slate-500">
              Showing <span className="font-semibold text-slate-700">{filtered.length}</span> expense{filtered.length !== 1 ? 's' : ''}
            </p>
            <p className="text-sm font-bold text-red-600">{formatCurrency(totalFiltered)}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Title</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Category</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Amount</th>
                  <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Date</th>
                  <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-5 py-3.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((expense) => (
                  <tr key={expense._id} className="hover:bg-slate-50/70 transition-colors group">
                    <td className="px-5 py-4">
                      <p className="text-sm font-semibold text-slate-800">{expense.title}</p>
                      {expense.notes && (
                        <p className="text-xs text-slate-400 truncate max-w-xs mt-0.5">{expense.notes}</p>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <CategoryBadge category={expense.category} />
                    </td>
                    <td className="px-5 py-4">
                      <p className="text-sm font-bold text-red-600">{formatCurrency(expense.amount)}</p>
                    </td>
                    <td className="px-5 py-4">
                      <p className="text-sm text-slate-500">{formatDate(expense.date)}</p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditExpense(expense)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={14} />
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          loading={deleting === expense._id}
                          onClick={() => handleDelete(expense._id)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setError(''); }} title="Add Expense">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
        )}
        <ExpenseForm onSubmit={handleAdd} />
      </Modal>

      <Modal open={!!editExpense} onClose={() => { setEditExpense(null); setError(''); }} title="Edit Expense">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
        )}
        {editExpense && (
          <ExpenseForm initial={editExpense} onSubmit={handleEdit} submitLabel="Save Changes" />
        )}
      </Modal>
    </div>
  );
}
