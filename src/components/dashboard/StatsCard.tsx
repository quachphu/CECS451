import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface StatsCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: ReactNode;
  color: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
  trend?: { value: string; positive: boolean };
}

const COLOR_MAP = {
  blue:   { border: 'border-t-blue-500',   iconBg: 'bg-blue-50',   iconText: 'text-blue-600',   dot: 'bg-blue-500' },
  green:  { border: 'border-t-emerald-500', iconBg: 'bg-emerald-50', iconText: 'text-emerald-600', dot: 'bg-emerald-500' },
  yellow: { border: 'border-t-amber-500',  iconBg: 'bg-amber-50',  iconText: 'text-amber-600',  dot: 'bg-amber-500' },
  red:    { border: 'border-t-red-500',    iconBg: 'bg-red-50',    iconText: 'text-red-600',    dot: 'bg-red-500' },
  purple: { border: 'border-t-violet-500', iconBg: 'bg-violet-50', iconText: 'text-violet-600', dot: 'bg-violet-500' },
};

export default function StatsCard({ title, value, subtitle, icon, color, trend }: StatsCardProps) {
  const c = COLOR_MAP[color];
  return (
    <div className={cn('bg-white rounded-xl border-t-2 border border-slate-100 shadow-sm p-5 hover:shadow-md transition-shadow', c.border)}>
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{title}</p>
          <p className="text-2xl font-bold text-slate-900 mt-1.5 leading-none">{value}</p>
          {subtitle && (
            <p className="text-xs text-slate-400 mt-1.5">{subtitle}</p>
          )}
          {trend && (
            <div className={cn('flex items-center gap-1 mt-2 text-xs font-semibold', trend.positive ? 'text-emerald-600' : 'text-red-500')}>
              {trend.positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {trend.value}
            </div>
          )}
        </div>
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ml-3', c.iconBg, c.iconText)}>
          {icon}
        </div>
      </div>
    </div>
  );
}
