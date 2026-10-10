import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Expense from '@/models/Expense';
import { getAuthUser } from '@/lib/auth';

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  amount: z.number().min(0).optional(),
  category: z
    .enum(['Tools', 'Marketing', 'Utilities', 'Travel', 'Food', 'Office', 'Other'])
    .optional(),
  date: z.string().optional(),
  notes: z.string().trim().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const parsed = UpdateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.date) updates.date = new Date(parsed.data.date);

  await connectDB();
  const expense = await Expense.findOneAndUpdate(
    { _id: id, userId: auth.userId },
    updates,
    { new: true, runValidators: true }
  );

  if (!expense)
    return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: expense });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  await connectDB();

  const expense = await Expense.findOneAndDelete({ _id: id, userId: auth.userId });
  if (!expense)
    return NextResponse.json({ success: false, error: 'Expense not found' }, { status: 404 });

  return NextResponse.json({ success: true, message: 'Expense deleted' });
}
