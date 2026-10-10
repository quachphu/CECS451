'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp } from 'lucide-react';

interface DataPoint {
  month: string;
  revenue: number;
  expenses: number;
}

interface RevenueChartProps {
  data: DataPoint[];
}

function formatINR(value: number) {
  if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
  if (value >= 1000) return `₹${(value / 1000).toFixed(0)}K`;
  return `₹${value}`;
}

export default function RevenueChart({ data }: RevenueChartProps) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg flex items-center justify-center">
            <TrendingUp size={15} className="text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">Revenue vs Expenses</p>
            <p className="text-xs text-slate-400">Last 6 months</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
            Revenue
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
            Expenses
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="p-5 pt-4">
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.18} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="expGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatINR}
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              formatter={(value) => [`₹${Number(value ?? 0).toLocaleString('en-IN')}`, '']}
              contentStyle={{
                borderRadius: '10px',
                border: '1px solid #e2e8f0',
                fontSize: '12px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              }}
              cursor={{ stroke: '#e2e8f0', strokeWidth: 1 }}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#revGradient)"
              dot={false}
              activeDot={{ r: 4, fill: '#3b82f6', strokeWidth: 0 }}
            />
            <Area
              type="monotone"
              dataKey="expenses"
              name="Expenses"
              stroke="#f59e0b"
              strokeWidth={2}
              fill="url(#expGradient)"
              dot={false}
              activeDot={{ r: 4, fill: '#f59e0b', strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
