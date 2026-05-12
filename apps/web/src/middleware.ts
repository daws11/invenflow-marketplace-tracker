// Edge middleware: gate everything behind a NextAuth session except a small
// allow-list (login page, NextAuth's own routes, the public health check, and
// Next.js internals/static assets — those are also excluded by the matcher
// below, but kept here defensively).

import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/api/auth', // NextAuth's own endpoints (signin, callback, csrf, …)
  '/api/health',
  // Chrome scraper extension endpoints — these authenticate with the
  // `x-extension-key` header (see lib/extension-auth.ts), not a NextAuth
  // session. NOTE: `/api/settings/extension` (key generation) is NOT here on
  // purpose — that one is session-gated like the rest of /api/settings.
  '/api/extension', // GET /api/extension/accounts
  '/api/ingest', // POST /api/ingest
];

const PUBLIC_PATH_EXACT = new Set<string>([
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATH_EXACT.has(pathname)) return true;
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (token) {
    return NextResponse.next();
  }

  // No valid session → redirect to /login with a callbackUrl pointing at
  // wherever the user was trying to go.
  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('callbackUrl', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run middleware on everything except Next.js internals and static assets.
  // The function above re-checks `/login`, `/api/auth`, `/api/health` so that
  // logic stays explicit even if the matcher is changed later.
  matcher: [
    '/((?!_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
};
