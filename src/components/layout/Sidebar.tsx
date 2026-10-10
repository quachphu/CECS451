'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  Users,
  Receipt,
  LogOut,
  TrendingUp,
  Menu,
  X,
  ChevronRight,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/invoices',  label: 'Invoices',  icon: FileText },
  { href: '/clients',   label: 'Clients',   icon: Users },
  { href: '/expenses',  label: 'Expenses',  icon: Receipt },
];

interface SidebarProps { userName: string; }

export default function Sidebar({ userName }: SidebarProps) {
  const pathname = usePathname();
  const router   = useRouter();
  const [open, setOpen] = useState(false);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const NavLinks = () => (
    <nav className="flex-1 px-3 space-y-0.5 py-2">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group',
              active
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/25'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
            )}
          >
            <Icon
              size={17}
              className={cn(
                'flex-shrink-0 transition-colors',
                active ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'
              )}
            />
            <span className="flex-1">{label}</span>
            {active && <ChevronRight size={13} className="text-blue-200 opacity-70" />}
          </Link>
        );
      })}
    </nav>
  );

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-white/5">
        <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/30 flex-shrink-0">
          <TrendingUp size={17} className="text-white" />
        </div>
        <div>
          <p className="font-bold text-white text-sm leading-none">FinFlow</p>
          <p className="text-xs text-slate-500 mt-0.5">Finance Manager</p>
        </div>
      </div>

      {/* Nav items */}
      <NavLinks />

      {/* User + logout */}
      <div className="px-3 pb-4 border-t border-white/5 pt-3">
        <div className="flex items-center gap-3 px-3 py-2 mb-1 rounded-xl">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-200 font-medium truncate leading-none">{userName}</p>
            <p className="text-xs text-slate-500 mt-0.5">Your account</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl text-sm font-medium text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-all duration-150"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-64 bg-slate-900 min-h-screen fixed left-0 top-0 z-30 border-r border-white/5">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-4 h-14">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center shadow-md shadow-blue-500/25">
            <TrendingUp size={14} className="text-white" />
          </div>
          <span className="font-bold text-white text-sm">FinFlow</span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-slate-900 flex flex-col border-r border-white/5 shadow-2xl">
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              <X size={16} />
            </button>
            <SidebarContent />
          </aside>
        </div>
      )}
    </>
  );
}
