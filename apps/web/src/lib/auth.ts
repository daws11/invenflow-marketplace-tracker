// NextAuth config + a server-side `getCurrentUser()` helper.
//
// Per PRD §7.1: credentials provider, bcrypt cost 12, JWT session strategy.
// This module is the single source of truth for auth options — both the
// `[...nextauth]` route handler and any server component that needs the
// current user (`getServerSession(authOptions)`) import from here.

import { compare } from 'bcryptjs';
import type { NextAuthOptions } from 'next-auth';
import { getServerSession } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

import { prisma } from '@/lib/db';

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
  },
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase().trim() },
        });
        if (!user) return null;

        // bcrypt.compare is constant-time on the hash itself; we hash with
        // cost 12 in the seed and password-change flows.
        const ok = await compare(credentials.password, user.password);
        if (!ok) return null;

        return { id: user.id, email: user.email };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // First call after sign-in: persist user fields onto the JWT.
      if (user) {
        token.id = (user as { id: string }).id;
        token.email = user.email ?? token.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.id as string | undefined;
        if (token.email) session.user.email = token.email as string;
      }
      return session;
    },
  },
};

/**
 * Returns the current logged-in user (id + email) on the server, or null.
 * Use from server components, route handlers, and server actions.
 */
export async function getCurrentUser(): Promise<{
  id: string;
  email: string;
} | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; email?: string } | undefined;
  if (!user?.id || !user?.email) return null;
  return { id: user.id, email: user.email };
}
