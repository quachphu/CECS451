import { InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={id} className="block text-sm font-medium text-slate-700">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={cn(
            'block w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400',
            'transition-all duration-150',
            'border-slate-200 hover:border-slate-300',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500',
            'disabled:opacity-50 disabled:bg-slate-50 disabled:cursor-not-allowed',
            error && 'border-red-400 hover:border-red-400 focus:ring-red-500/25 focus:border-red-500',
            className
          )}
          {...props}
        />
        {hint && !error && <p className="text-xs text-slate-400">{hint}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
export default Input;
