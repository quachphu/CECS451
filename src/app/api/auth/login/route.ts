import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import User from '@/models/User';
import { signToken, COOKIE_NAME_EXPORT } from '@/lib/auth';

const LoginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 400 }
      );
    }

    await connectDB();

    const user = await User.findOne({ email: parsed.data.email }).select('+password');
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const valid = await user.comparePassword(parsed.data.password);
    if (!valid) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const token = signToken({ userId: user._id.toString(), email: user.email, name: user.name });

    const response = NextResponse.json({
      success: true,
      data: { _id: user._id, name: user.name, email: user.email },
    });

    response.cookies.set(COOKIE_NAME_EXPORT, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch {
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
