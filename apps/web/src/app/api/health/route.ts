import { NextResponse } from 'next/server';

// B1 stub: real DB + Redis liveness checks land in B2.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    checks: {
      database: 'skipped',
      redis: 'skipped',
    },
  });
}
