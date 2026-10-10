import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Client from '@/models/Client';
import { getAuthUser } from '@/lib/auth';

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  email: z.string().email().toLowerCase().trim().optional(),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  company: z.string().trim().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  await connectDB();

  const client = await Client.findOne({ _id: id, userId: auth.userId });
  if (!client) return NextResponse.json({ success: false, error: 'Client not found' }, { status: 404 });

  return NextResponse.json({ success: true, data: client });
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

  await connectDB();
  const client = await Client.findOneAndUpdate(
    { _id: id, userId: auth.userId },
    parsed.data,
    { new: true, runValidators: true }
  );

  if (!client) return NextResponse.json({ success: false, error: 'Client not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: client });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  await connectDB();

  const client = await Client.findOneAndDelete({ _id: id, userId: auth.userId });
  if (!client) return NextResponse.json({ success: false, error: 'Client not found' }, { status: 404 });

  return NextResponse.json({ success: true, message: 'Client deleted' });
}
