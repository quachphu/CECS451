import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Client from '@/models/Client';
import { getAuthUser } from '@/lib/auth';

const ClientSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  company: z.string().trim().optional(),
});

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  await connectDB();
  const clients = await Client.find({ userId: auth.userId }).sort({ createdAt: -1 });
  return NextResponse.json({ success: true, data: clients });
}

export async function POST(req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parsed = ClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();
  const client = await Client.create({ ...parsed.data, userId: auth.userId });
  return NextResponse.json({ success: true, data: client }, { status: 201 });
}
