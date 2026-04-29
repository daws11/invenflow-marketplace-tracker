// Initial admin seed (PRD §15.1 step 4–5).
//
// Runs at first boot from `prisma db seed` (configured in package.json under
// "prisma.seed"). Behavior:
//
//   - If any User row already exists, do nothing (idempotent for re-runs).
//   - Otherwise, read INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD from env,
//     bcrypt the password (cost 12), and insert a single admin user.

import { hash } from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const BCRYPT_COST = 12;

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.count();
    if (existing > 0) {
      console.log('Skipping seed (users already present)');
      return;
    }

    const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.INITIAL_ADMIN_PASSWORD;

    if (!email || !password) {
      throw new Error(
        'INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set to seed the initial admin.',
      );
    }

    const hashed = await hash(password, BCRYPT_COST);
    await prisma.user.create({
      data: {
        email,
        password: hashed,
      },
    });

    console.log(`Seeded initial admin: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
