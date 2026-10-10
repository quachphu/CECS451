'use client';

import { useEffect, useState } from 'react';
import { Plus, Users, Search, Mail, Phone, Building2, Edit2, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ClientForm from '@/components/clients/ClientForm';
import { IClient } from '@/types';

const AVATAR_COLORS = [
  'from-blue-500 to-indigo-600',
  'from-violet-500 to-purple-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-600',
  'from-cyan-500 to-blue-500',
];

function getAvatarColor(name: string) {
  const idx = name.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

export default function ClientsPage() {
  const [clients, setClients]       = useState<IClient[]>([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [addOpen, setAddOpen]       = useState(false);
  const [editClient, setEditClient] = useState<IClient | null>(null);
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [error, setError]           = useState('');

  useEffect(() => {
    fetch('/api/clients')
      .then((r) => r.json())
      .then((d) => { if (d.success) setClients(d.data); })
      .finally(() => setLoading(false));
  }, []);

  async function handleAdd(data: Omit<IClient, '_id' | 'userId' | 'createdAt'>) {
    setError('');
    const res  = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.success) { setError(json.error ?? 'Failed to add client'); return; }
    setClients((prev) => [json.data, ...prev]);
    setAddOpen(false);
  }

  async function handleEdit(data: Omit<IClient, '_id' | 'userId' | 'createdAt'>) {
    if (!editClient) return;
    setError('');
    const res  = await fetch(`/api/clients/${editClient._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.success) { setError(json.error ?? 'Failed to update'); return; }
    setClients((prev) => prev.map((c) => (c._id === editClient._id ? json.data : c)));
    setEditClient(null);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this client? Their invoices will remain.')) return;
    setDeleting(id);
    await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    setClients((prev) => prev.filter((c) => c._id !== id));
    setDeleting(null);
  }

  const filtered = clients.filter((c) => {
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.company ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
          <p className="text-sm text-slate-400 mt-0.5">{clients.length} client{clients.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={15} /> Add Client
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Search by name, email, or company…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 transition-all hover:border-slate-300"
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-slate-100 p-5 h-40 skeleton" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 bg-white rounded-2xl border border-slate-100 text-center px-6">
          <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center mb-4">
            <Users size={26} className="text-slate-300" />
          </div>
          <p className="font-semibold text-slate-700 mb-1">No clients found</p>
          <p className="text-sm text-slate-400 mb-6">
            {search ? 'Try a different search' : 'Add your first client to get started'}
          </p>
          {!search && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Add Client
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((client) => (
            <div
              key={client._id}
              className="bg-white rounded-2xl border border-slate-100 p-5 hover:shadow-lg hover:border-slate-200 hover:-translate-y-0.5 transition-all duration-200"
            >
              <div className="flex items-start justify-between mb-4">
                <div className={`w-11 h-11 bg-gradient-to-br ${getAvatarColor(client.name)} rounded-xl flex items-center justify-center text-white font-bold text-base shadow-md flex-shrink-0`}>
                  {client.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex gap-0.5">
                  <button
                    onClick={() => setEditClient(client)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                    title="Edit client"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(client._id)}
                    disabled={deleting === client._id}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    title="Delete client"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <h3 className="font-semibold text-slate-900 leading-tight">{client.name}</h3>
              {client.company && (
                <div className="flex items-center gap-1.5 mt-1">
                  <Building2 size={11} className="text-slate-400 flex-shrink-0" />
                  <span className="text-xs text-slate-500 truncate">{client.company}</span>
                </div>
              )}

              <div className="mt-3 space-y-1.5 pt-3 border-t border-slate-50">
                <div className="flex items-center gap-2">
                  <Mail size={12} className="text-slate-400 flex-shrink-0" />
                  <span className="text-xs text-slate-500 truncate">{client.email}</span>
                </div>
                {client.phone && (
                  <div className="flex items-center gap-2">
                    <Phone size={12} className="text-slate-400 flex-shrink-0" />
                    <span className="text-xs text-slate-500">{client.phone}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setError(''); }} title="Add Client">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
        )}
        <ClientForm onSubmit={handleAdd} />
      </Modal>

      <Modal open={!!editClient} onClose={() => { setEditClient(null); setError(''); }} title="Edit Client">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
        )}
        {editClient && (
          <ClientForm initial={editClient} onSubmit={handleEdit} submitLabel="Save Changes" />
        )}
      </Modal>
    </div>
  );
}
