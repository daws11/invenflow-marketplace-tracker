// NextAuth.js v4 App Router handler.
// Both GET and POST are routed through the same NextAuth instance; the
// shared `authOptions` lives in `@/lib/auth`.

import NextAuth from 'next-auth';

import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
