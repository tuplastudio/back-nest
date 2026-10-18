import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/control-plane/client';
import { PiiCryptoService } from '../src/pii/pii-crypto.service';

/**
 * One-off rotation of a platform admin's password.
 *
 * Needed until the API exposes a change-password endpoint: the seed does not
 * rotate existing accounts, so the only way to replace the bootstrap password is
 * a direct database update.
 *
 * Required environment: `CONTROL_PLANE_DATABASE_URL`, `PII_HMAC_KEY`,
 * `PII_ENCRYPTION_KEY` and `NEW_PW`.
 *
 * ```bash
 * NEW_PW=... npx tsx scripts/rotate-owner-password.ts owner@example.com
 * ```
 */

/** Argon2id parameters, identical to `prisma/seed.ts` so hashes verify the same way. */
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name.
 * @returns The non-empty value.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

/** Hashes the new password and updates the matching platform admin. */
async function main(): Promise<void> {
  const emailArg = process.argv[2];
  if (!emailArg) {
    throw new Error('Usage: rotate-owner-password.ts <email>');
  }
  const newPassword = requiredEnv('NEW_PW');
  const pii = new PiiCryptoService(requiredEnv('PII_HMAC_KEY'), requiredEnv('PII_ENCRYPTION_KEY'));
  const pool = new Pool({ connectionString: requiredEnv('CONTROL_PLANE_DATABASE_URL'), max: 1 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const emailLookup = pii.blindIndex(PiiCryptoService.normalizeEmail(emailArg));
    const updated = await prisma.platformAdmin.update({
      where: { emailLookup },
      data: {
        passwordHash: await argon2.hash(newPassword, ARGON2),
        mustChangePassword: false,
      },
      select: { id: true, emailMasked: true, role: true },
    });
    process.stdout.write(`Rotated password for ${updated.emailMasked} (${updated.role}).\n`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
