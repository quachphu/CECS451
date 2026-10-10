import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import User from '@/models/User';
import { signToken, COOKIE_NAME_EXPORT } from '@/lib/auth';

const RegisterSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(6).max(100),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = RegisterSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    await connectDB();

    const existing = await User.findOne({ email: parsed.data.email });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    const user = await User.create(parsed.data);
    const token = signToken({ userId: user._id.toString(), email: user.email, name: user.name });

    const response = NextResponse.json(
      { success: true, data: { _id: user._id, name: user.name, email: user.email } },
      { status: 201 }
    );

    response.cookies.set(COOKIE_NAME_EXPORT, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
    });

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[register]', message);
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === 'development' ? message : 'Internal server error' },
      { status: 500 }
    );
  }
}
