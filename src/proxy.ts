import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';

const PUBLIC_PATHS = ['/', '/login', '/signup'];
const AUTH_PATHS = ['/dashboard', '/invoices', '/clients', '/expenses'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get('auth_token')?.value;
  const user = token ? verifyToken(token) : null;

  const isAuthPath = AUTH_PATHS.some((p) => pathname.startsWith(p));
  const isPublicAuthPage = pathname === '/login' || pathname === '/signup';

  // Redirect unauthenticated users from protected pages
  if (isAuthPath && !user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Redirect authenticated users away from login/signup
  if (isPublicAuthPage && user) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
