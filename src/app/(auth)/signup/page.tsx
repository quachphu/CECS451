'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TrendingUp, User, Mail, Lock, ArrowRight, BarChart3, FileText, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

const BRAND_BULLETS = [
  { icon: FileText,  text: 'Create professional invoices in seconds' },
  { icon: BarChart3, text: 'Real-time revenue & expense dashboard' },
  { icon: Sparkles,  text: 'AI-powered invoice generation with Groq + Llama 3.3' },
];

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm]       = useState({ name: '', email: '', password: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res  = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error ?? 'Registration failed'); return; }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">

      {/* Left — brand panel */}
      <div className="hidden lg:flex lg:w-[45%] xl:w-1/2 flex-col justify-between bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 p-12 relative overflow-hidden">
        <div className="absolute top-[-80px] right-[-80px] w-64 h-64 bg-blue-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-[-60px] left-[-60px] w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl" />

        {/* Logo */}
        <div className="flex items-center gap-3 relative z-10">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-xl shadow-blue-500/30">
            <TrendingUp size={20} className="text-white" />
          </div>
          <span className="font-bold text-white text-xl tracking-tight">FinFlow</span>
        </div>

        {/* Headline */}
        <div className="relative z-10 space-y-6">
          <div>
            <h2 className="text-4xl font-extrabold text-white leading-tight mb-3">
              Start managing{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-300">
                smarter today
              </span>
            </h2>
            <p className="text-slate-400 text-base leading-relaxed">
              Everything you need to run your freelance business — invoices, expenses, clients, and insights.
            </p>
          </div>

          <div className="space-y-3">
            {BRAND_BULLETS.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Icon size={15} className="text-blue-300" />
                </div>
                <span className="text-sm text-slate-300">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-600 relative z-10">
          Free to use — no credit card required
        </p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 p-6 sm:p-10">
        {/* Mobile logo */}
        <div className="lg:hidden flex items-center gap-2.5 mb-10">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-md shadow-blue-500/25">
            <TrendingUp size={16} className="text-white" />
          </div>
          <span className="font-bold text-slate-900 text-lg tracking-tight">FinFlow</span>
        </div>

        <div className="w-full max-w-md">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-slate-900 mb-1">Create your account</h1>
            <p className="text-slate-500 text-sm">Start managing your finances for free</p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
            {error && (
              <div className="mb-5 flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                <span className="flex-shrink-0 mt-0.5">⚠</span>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="relative">
                <User size={15} className="absolute left-3.5 top-[2.6rem] text-slate-400 pointer-events-none" />
                <Input
                  id="name"
                  label="Full name"
                  placeholder="Jane Smith"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="pl-10"
                  required
                  autoComplete="name"
                />
              </div>

              <div className="relative">
                <Mail size={15} className="absolute left-3.5 top-[2.6rem] text-slate-400 pointer-events-none" />
                <Input
                  id="email"
                  label="Email address"
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="pl-10"
                  required
                  autoComplete="email"
                />
              </div>

              <div className="relative">
                <Lock size={15} className="absolute left-3.5 top-[2.6rem] text-slate-400 pointer-events-none" />
                <Input
                  id="password"
                  label="Password"
                  type="password"
                  placeholder="Min. 6 characters"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="pl-10"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>

              <Button type="submit" loading={loading} className="w-full justify-center" size="lg">
                Create Account <ArrowRight size={15} />
              </Button>
            </form>

            <div className="mt-6 pt-6 border-t border-slate-100 text-center">
              <p className="text-sm text-slate-500">
                Already have an account?{' '}
                <Link href="/login" className="font-semibold text-blue-600 hover:text-blue-700 transition-colors">
                  Sign in
                </Link>
              </p>
            </div>
          </div>

          <p className="text-center text-xs text-slate-400 mt-5">
            By creating an account, you agree to our Terms &amp; Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
