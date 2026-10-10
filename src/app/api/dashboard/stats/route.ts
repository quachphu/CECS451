import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Invoice from '@/models/Invoice';
import Expense from '@/models/Expense';
import '@/models/Client';
import { getAuthUser } from '@/lib/auth';
import { subMonths, startOfMonth, endOfMonth, format } from 'date-fns';

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  await connectDB();

  const userId = auth.userId;

  const [invoices, expenses] = await Promise.all([
    Invoice.find({ userId }).populate('clientId', 'name'),
    Expense.find({ userId }),
  ]);

  const totalRevenue = invoices
    .filter((i) => i.status === 'paid')
    .reduce((sum, i) => sum + i.total, 0);

  const pendingAmount = invoices
    .filter((i) => i.status === 'sent')
    .reduce((sum, i) => sum + i.total, 0);

  const overdueAmount = invoices
    .filter((i) => i.status === 'overdue')
    .reduce((sum, i) => sum + i.total, 0);

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

  // Monthly data for last 6 months
  const monthlyRevenue = [];
  for (let i = 5; i >= 0; i--) {
    const date = subMonths(new Date(), i);
    const start = startOfMonth(date);
    const end = endOfMonth(date);

    const monthInvoices = invoices.filter(
      (inv) => inv.status === 'paid' && inv.updatedAt >= start && inv.updatedAt <= end
    );
    const monthExpenses = expenses.filter((exp) => exp.date >= start && exp.date <= end);

    monthlyRevenue.push({
      month: format(date, 'MMM yy'),
      revenue: monthInvoices.reduce((sum, inv) => sum + inv.total, 0),
      expenses: monthExpenses.reduce((sum, exp) => sum + exp.amount, 0),
    });
  }

  const recentInvoices = invoices
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5);

  return NextResponse.json({
    success: true,
    data: {
      totalRevenue,
      pendingAmount,
      overdueAmount,
      totalExpenses,
      invoiceCount: invoices.length,
      paidCount: invoices.filter((i) => i.status === 'paid').length,
      pendingCount: invoices.filter((i) => i.status === 'sent').length,
      overdueCount: invoices.filter((i) => i.status === 'overdue').length,
      recentInvoices,
      monthlyRevenue,
    },
  });
}
