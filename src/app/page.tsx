import Link from 'next/link';
import {
  TrendingUp,
  FileText,
  Users,
  Receipt,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  BarChart3,
  Shield,
  Zap,
} from 'lucide-react';

const FEATURES = [
  {
    icon: FileText,
    title: 'Smart Invoicing',
    desc: 'Create professional invoices in seconds. Add line items, set tax rates, and track payment status effortlessly.',
    color: 'from-blue-500 to-indigo-600',
    bg: 'bg-blue-50',
  },
  {
    icon: Users,
    title: 'Client Management',
    desc: 'Keep all your client details organised. View the full history of every invoice per client in one place.',
    color: 'from-violet-500 to-purple-600',
    bg: 'bg-violet-50',
  },
  {
    icon: Receipt,
    title: 'Expense Tracking',
    desc: 'Log and categorise business expenses. Understand exactly where your money is going at a glance.',
    color: 'from-amber-500 to-orange-600',
    bg: 'bg-amber-50',
  },
  {
    icon: Sparkles,
    title: 'AI-Powered',
    desc: 'Describe your project and let Groq AI auto-generate invoice titles, descriptions, and line items instantly.',
    color: 'from-emerald-500 to-teal-600',
    bg: 'bg-emerald-50',
  },
];

const HIGHLIGHTS = [
  'Secure JWT authentication',
  'Real-time revenue dashboard',
  'Revenue vs Expense charts',
  'Invoice status management',
  'Category-based expense breakdown',
  'Mobile-responsive design',
];

const STATS = [
  { value: 'AI-Powered', label: 'Groq AI Integration', icon: Sparkles },
  { value: 'JWT Secure', label: 'Authentication', icon: Shield },
  { value: 'Real-time', label: 'Dashboard Analytics', icon: BarChart3 },
  { value: 'Instant', label: 'Invoice Generation', icon: Zap },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">

      {/* Nav */}
      <nav className="sticky top-0 z-20 border-b border-slate-100 bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between h-16">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-md shadow-blue-500/25">
              <TrendingUp size={16} className="text-white" />
            </div>
            <span className="font-bold text-slate-900 text-lg tracking-tight">FinFlow</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className="text-sm font-medium bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-4 py-2 rounded-lg hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md shadow-blue-500/20"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 dot-grid opacity-40" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-gradient-to-b from-blue-50 via-indigo-50/50 to-transparent rounded-full blur-3xl opacity-60 pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 text-xs font-semibold px-4 py-2 rounded-full mb-8 border border-blue-200/60 shadow-sm">
            <Sparkles size={13} />
            AI-Powered with Groq + Llama 3.3
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold text-slate-900 leading-[1.08] tracking-tight mb-6">
            Invoice smarter,{' '}
            <span className="gradient-text">grow faster</span>
          </h1>

          <p className="text-lg sm:text-xl text-slate-500 max-w-2xl mx-auto mb-10 leading-relaxed">
            The all-in-one finance manager for freelancers and small businesses.
            Create invoices, track expenses, and monitor revenue — all in one place.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-7 py-3.5 rounded-xl font-semibold text-sm hover:from-blue-700 hover:to-indigo-700 transition-all shadow-xl shadow-blue-500/30 active:scale-[0.98]"
            >
              Start for free <ArrowRight size={16} />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 border border-slate-200 bg-white text-slate-700 px-7 py-3.5 rounded-xl font-semibold text-sm hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm"
            >
              Sign in to account
            </Link>
          </div>

          {/* Mini stats */}
          <div className="mt-16 grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {STATS.map(({ value, label, icon: Icon }) => (
              <div
                key={label}
                className="bg-white border border-slate-100 rounded-2xl px-4 py-4 text-center shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="w-8 h-8 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg flex items-center justify-center mx-auto mb-2">
                  <Icon size={16} className="text-blue-600" />
                </div>
                <p className="text-sm font-bold text-slate-900">{value}</p>
                <p className="text-xs text-slate-400 mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-3">
            Everything you need
          </h2>
          <p className="text-slate-500 text-lg max-w-xl mx-auto">
            Built for freelancers, consultants, and small business owners who want simplicity without compromise.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {FEATURES.map(({ icon: Icon, title, desc, color, bg }) => (
            <div
              key={title}
              className="group bg-white rounded-2xl p-6 border border-slate-100 hover:border-slate-200 hover:shadow-xl hover:-translate-y-1 transition-all duration-200"
            >
              <div className={`w-11 h-11 ${bg} rounded-xl flex items-center justify-center mb-5`}>
                <div className={`w-6 h-6 bg-gradient-to-br ${color} rounded-lg flex items-center justify-center`}>
                  <Icon size={14} className="text-white" />
                </div>
              </div>
              <h3 className="font-semibold text-slate-900 mb-2 text-sm">{title}</h3>
              <p className="text-sm text-slate-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Highlights — dark section */}
      <section className="bg-gradient-to-br from-slate-900 to-slate-800 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">
              Built for the real world
            </h2>
            <p className="text-slate-400 text-lg">Production-grade features ready out of the box</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {HIGHLIGHTS.map((h) => (
              <div
                key={h}
                className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-5 py-3.5 hover:bg-white/8 transition-colors"
              >
                <div className="w-5 h-5 bg-gradient-to-br from-blue-500 to-indigo-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 size={12} className="text-white" />
                </div>
                <span className="text-sm text-slate-300 font-medium">{h}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-6xl mx-auto px-6 py-24 text-center">
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-3xl px-8 py-16">
          <h2 className="text-4xl sm:text-5xl font-extrabold text-slate-900 mb-4 tracking-tight">
            Ready to take control?
          </h2>
          <p className="text-slate-500 mb-10 text-lg max-w-lg mx-auto">
            Start managing your invoices and expenses today — completely free, no credit card required.
          </p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-8 py-4 rounded-xl font-semibold text-base hover:from-blue-700 hover:to-indigo-700 transition-all shadow-xl shadow-blue-500/30 active:scale-[0.98]"
          >
            Get Started Free <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-lg flex items-center justify-center">
              <TrendingUp size={12} className="text-white" />
            </div>
            <span>
              <span className="font-semibold text-slate-700">FinFlow</span>
              {' '}— Built by{' '}
              <span className="font-semibold text-slate-700">Koyal Mohadikar</span>
            </span>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/koyalmohadikar"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-slate-900 transition-colors"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              GitHub
            </a>
            <a
              href="https://www.linkedin.com/in/koyal-mohadikar"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-slate-900 transition-colors"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
              </svg>
              LinkedIn
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
