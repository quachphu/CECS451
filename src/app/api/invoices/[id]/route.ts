import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Invoice from '@/models/Invoice';
import '@/models/Client';
import { getAuthUser } from '@/lib/auth';

const LineItemSchema = z.object({
  description: z.string().min(1).trim(),
  quantity: z.number().min(0),
  rate: z.number().min(0),
  amount: z.number().min(0),
});

const UpdateSchema = z.object({
  clientId: z.string().optional(),
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().trim().optional(),
  lineItems: z.array(LineItemSchema).min(1).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue']).optional(),
  dueDate: z.string().optional(),
  notes: z.string().trim().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  await connectDB();

  const invoice = await Invoice.findOne({ _id: id, userId: auth.userId }).populate(
    'clientId',
    'name email company phone address'
  );

  if (!invoice)
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: invoice });
}

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

  const { lineItems, taxRate, dueDate, ...rest } = parsed.data;

  const updates: Record<string, unknown> = { ...rest };

  if (lineItems !== undefined && taxRate !== undefined) {
    const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.rate, 0);
    const tax = (subtotal * taxRate) / 100;
    updates.lineItems = lineItems.map((item) => ({ ...item, amount: item.quantity * item.rate }));
    updates.subtotal = subtotal;
    updates.taxRate = taxRate;
    updates.tax = tax;
    updates.total = subtotal + tax;
  } else if (lineItems !== undefined) {
    // taxRate not changed; fetch existing
    const existing = await Invoice.findOne({ _id: id, userId: auth.userId });
    if (existing) {
      const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.rate, 0);
      const tax = (subtotal * existing.taxRate) / 100;
      updates.lineItems = lineItems.map((item) => ({
        ...item,
        amount: item.quantity * item.rate,
      }));
      updates.subtotal = subtotal;
      updates.tax = tax;
      updates.total = subtotal + tax;
    }
  } else if (taxRate !== undefined) {
    updates.taxRate = taxRate;
  }

  if (dueDate) updates.dueDate = new Date(dueDate);

  await connectDB();
  const invoice = await Invoice.findOneAndUpdate(
    { _id: id, userId: auth.userId },
    updates,
    { new: true, runValidators: true }
  ).populate('clientId', 'name email company');

  if (!invoice)
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: invoice });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  await connectDB();

  const invoice = await Invoice.findOneAndDelete({ _id: id, userId: auth.userId });
  if (!invoice)
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 });

  return NextResponse.json({ success: true, message: 'Invoice deleted' });
}
