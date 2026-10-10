import { cn } from '@/lib/utils';
import { InvoiceStatus } from '@/types';
import { STATUS_LABELS } from '@/lib/utils';

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft:   'bg-slate-100 text-slate-600 border border-slate-200',
  sent:    'bg-blue-50 text-blue-700 border border-blue-200',
  paid:    'bg-emerald-50 text-emerald-700 border border-emerald-200',
  overdue: 'bg-red-50 text-red-700 border border-red-200',
};

const STATUS_DOT: Record<InvoiceStatus, string> = {
  draft:   'bg-slate-400',
  sent:    'bg-blue-500',
  paid:    'bg-emerald-500',
  overdue: 'bg-red-500',
};

interface BadgeProps {
  status: InvoiceStatus;
  className?: string;
}

export function StatusBadge({ status, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold',
        STATUS_STYLES[status],
        className
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_DOT[status])} />
      {STATUS_LABELS[status]}
    </span>
  );
}

const CATEGORY_STYLES: Record<string, string> = {
  Tools:      'bg-violet-50 text-violet-700 border border-violet-200',
  Marketing:  'bg-pink-50 text-pink-700 border border-pink-200',
  Utilities:  'bg-amber-50 text-amber-700 border border-amber-200',
  Travel:     'bg-orange-50 text-orange-700 border border-orange-200',
  Food:       'bg-emerald-50 text-emerald-700 border border-emerald-200',
  Office:     'bg-cyan-50 text-cyan-700 border border-cyan-200',
  Other:      'bg-slate-100 text-slate-600 border border-slate-200',
};

interface CategoryBadgeProps {
  category: string;
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
        CATEGORY_STYLES[category] ?? 'bg-slate-100 text-slate-600 border border-slate-200',
        className
      )}
    >
      {category}
    </span>
  );
}
