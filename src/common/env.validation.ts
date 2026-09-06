/**
 * Environment validation, run before the Nest app is created.
 *
 * The failure mode this prevents: with no `JWT_ACCESS_SECRET`, the app boots
 * happily, signs tokens with `undefined`, and every login appears to work
 * until you notice that any forged token verifies. A deploy that is
 * misconfigured should refuse to start, loudly, with the variable named.
 *
 * Optional-but-important variables produce warnings instead, because the app
 * is genuinely usable without them (OTPs to the log, no payment collection),
 * and blocking a first deploy on aggregator credentials nobody has yet would
 * be worse than starting degraded.
 */

import { Logger } from '@nestjs/common';

interface Requirement {
  key: string;
  description: string;
  validate?: (value: string) => string | null;
}

const REQUIRED: Requirement[] = [
  {
    key: 'DATABASE_URL',
    description:
      'PostGIS connection string. On Railway set this to ${{Postgres.DATABASE_URL}} ' +
      'from the PostGIS template service (NOT the default Postgres plugin).',
    validate: (v) =>
      v.startsWith('postgres://') || v.startsWith('postgresql://')
        ? null
        : 'must start with postgresql://',
  },
  {
    key: 'REDIS_URL',
    description: 'Redis connection string. On Railway: ${{Redis.REDIS_URL}}',
    validate: (v) =>
      v.startsWith('redis://') || v.startsWith('rediss://')
        ? null
        : 'must start with redis://',
  },
  {
    key: 'JWT_ACCESS_SECRET',
    description: 'Access token signing key. Generate: openssl rand -base64 48',
    validate: (v) =>
      v.length >= 32
        ? null
        : `must be at least 32 characters (got ${v.length}) — short keys are brute-forceable`,
  },
];

const RECOMMENDED: Requirement[] = [
  {
    key: 'OFFER_TOKEN_SECRET',
    description: 'Signs driver ride-offer tokens. Falls back to JWT_ACCESS_SECRET.',
  },
  {
    key: 'SMS_API_URL',
    description: 'SMS gateway. Unset means OTP codes are written to the log — development only.',
  },
  {
    key: 'AZAMPAY_CLIENT_ID',
    description: 'Mobile money collection is unavailable until aggregator credentials are set.',
  },
];

export function validateEnvironment(): void {
  const logger = new Logger('Environment');
  const failures: string[] = [];

  for (const { key, description, validate } of REQUIRED) {
    const value = process.env[key];

    if (!value || value.trim() === '') {
      failures.push(`  ${key} is not set\n      ${description}`);
      continue;
    }

    // A placeholder copied straight out of .env.example is worse than a
    // missing value: it looks configured and behaves insecurely.
    if (value.includes('change-me') || value.includes('your-') || value === 'x') {
      failures.push(`  ${key} still holds a placeholder value\n      ${description}`);
      continue;
    }

    const problem = validate?.(value);
    if (problem) failures.push(`  ${key} ${problem}\n      ${description}`);
  }

  if (failures.length > 0) {
    logger.error(
      `\n\nRefusing to start — ${failures.length} configuration problem(s):\n\n` +
        failures.join('\n\n') +
        '\n\nSet these in Railway under the service\'s Variables tab.\n',
    );
    process.exit(1);
  }

  for (const { key, description } of RECOMMENDED) {
    if (!process.env[key]) logger.warn(`${key} not set — ${description}`);
  }

  if (process.env.PORT && process.env.NODE_ENV === 'production') {
    logger.log(`PORT injected by the platform: ${process.env.PORT}`);
  }
}
