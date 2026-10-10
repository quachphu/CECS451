import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Expense from '@/models/Expense';
import { getAuthUser } from '@/lib/auth';

const ExpenseSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  amount: z.number().min(0),
  category: z.enum(['Tools', 'Marketing', 'Utilities', 'Travel', 'Food', 'Office', 'Other']),
  date: z.string().min(1),
  notes: z.string().trim().optional(),
});

export async function GET(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');

  const filter: Record<string, unknown> = { userId: auth.userId };
  if (category) filter.category = category;

  await connectDB();
  const expenses = await Expense.find(filter).sort({ date: -1 });
  return NextResponse.json({ success: true, data: expenses });
}

export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = ExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();
  const expense = await Expense.create({
    ...parsed.data,
    userId: auth.userId,
    date: new Date(parsed.data.date),
  });

  return NextResponse.json({ success: true, data: expense }, { status: 201 });
}
