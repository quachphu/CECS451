import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Invoice from '@/models/Invoice';
import '@/models/Client';
import { getAuthUser } from '@/lib/auth';
import { generateInvoiceNumber } from '@/lib/utils';

const LineItemSchema = z.object({
  description: z.string().min(1).trim(),
  quantity: z.number().min(0),
  rate: z.number().min(0),
  amount: z.number().min(0),
});

const InvoiceSchema = z.object({
  clientId: z.string().min(1),
  title: z.string().min(1).max(200).trim(),
  description: z.string().trim().optional(),
  lineItems: z.array(LineItemSchema).min(1),
  taxRate: z.number().min(0).max(100).default(0),
  status: z.enum(['draft', 'sent', 'paid', 'overdue']).default('draft'),
  dueDate: z.string().min(1),
  notes: z.string().trim().optional(),
});

export async function GET(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const clientId = searchParams.get('clientId');

  const filter: Record<string, unknown> = { userId: auth.userId };
  if (status) filter.status = status;
  if (clientId) filter.clientId = clientId;

  await connectDB();
  const invoices = await Invoice.find(filter)
    .populate('clientId', 'name email company')
    .sort({ createdAt: -1 });

  return NextResponse.json({ success: true, data: invoices });
}

export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = InvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { lineItems, taxRate, ...rest } = parsed.data;

  // Recalculate amounts server-side to prevent manipulation
  const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const tax = (subtotal * taxRate) / 100;
  const total = subtotal + tax;

  await connectDB();
  const invoice = await Invoice.create({
    ...rest,
    userId: auth.userId,
    invoiceNumber: generateInvoiceNumber(),
    lineItems: lineItems.map((item) => ({
      ...item,
      amount: item.quantity * item.rate,
    })),
    subtotal,
    taxRate,
    tax,
    total,
    dueDate: new Date(rest.dueDate),
  });

  const populated = await invoice.populate('clientId', 'name email company');
  return NextResponse.json({ success: true, data: populated }, { status: 201 });
}
