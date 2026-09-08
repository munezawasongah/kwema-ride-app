/**
 * Migration runner.
 *
 * Plain SQL files applied in filename order, tracked in a `_migrations`
 * table. Deliberately not TypeORM's migration system: this schema is mostly
 * PostGIS features (geography columns, GiST indexes, partitioned tables,
 * SQL functions) that TypeORM does not model, and letting it generate
 * migrations against them produces destructive diffs.
 *
 * Run as `npm run migrate` — Railway calls it before starting the server.
 * Each file runs inside a transaction, so a failed migration leaves nothing
 * half-applied.
 */

import { Client } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
  });

  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // When compiled, the SQL files sit next to this script in dist/db.
  // When run through ts-node they are in ../../db.
  const candidates = [
    path.join(__dirname, '.'),
    path.join(__dirname, '..', '..', 'db'),
    path.join(process.cwd(), 'db'),
  ];
  const dir = candidates.find(
    (d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith('.sql')),
  );

  if (!dir) {
    console.error('no migration directory found');
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await client.query('SELECT filename, checksum FROM _migrations');
  const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    if (appliedMap.has(file)) {
      // An edited migration that has already run is a deployment hazard:
      // the database and the file no longer agree, and nobody would notice.
      if (appliedMap.get(file) !== checksum) {
        console.warn(`WARNING: ${file} has changed since it was applied — skipping`);
      }
      continue;
    }

    console.log(`applying ${file}...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      console.log(`  ${file} ok`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ${file} FAILED: ${(err as Error).message}`);
      await client.end();
      process.exit(1);
    }
  }

  console.log('migrations up to date');

  await grantAdmin(client);

  await client.end();
}

/**
 * Promotes the ADMIN_PHONE account to administrator on every boot.
 *
 * Driven by an environment variable rather than a migration for two reasons:
 * a phone number committed to a public repository is a credential in version
 * control, and revoking access should be a variable change rather than an
 * edit to an already-applied migration.
 *
 * Idempotent, and deliberately quiet about failure modes that are normal:
 * the account has to exist first, because the person signs up in the app with
 * their own number and verifies it by OTP before they can be made an admin.
 */
async function grantAdmin(client: Client): Promise<void> {
  const phone = process.env.ADMIN_PHONE?.trim();
  if (!phone) {
    console.log('ADMIN_PHONE not set — no administrator granted');
    return;
  }

  if (!/^\+255[0-9]{9}$/.test(phone)) {
    console.error(`ADMIN_PHONE "${phone}" is not in +255XXXXXXXXX format`);
    return;
  }

  try {
    const { rows } = await client.query(
      `UPDATE users
          SET roles = CASE WHEN 'admin' = ANY(roles) THEN roles
                           ELSE array_append(roles, 'admin'::user_role) END,
              status = 'active'
        WHERE phone = $1 AND deleted_at IS NULL
        RETURNING id, full_name, roles`,
      [phone],
    );

    if (rows.length === 0) {
      console.warn(
        `ADMIN_PHONE ${phone} has no account yet. ` +
          'Sign in once with that number in the app, then redeploy.',
      );
      return;
    }

    console.log(
      `administrator: ${phone} (${rows[0].full_name || 'unnamed'}) ` +
        `roles=${rows[0].roles}`,
    );
  } catch (err) {
    // Never fail the boot over this — an app that will not start is worse
    // than an app whose admin panel needs one more deploy.
    console.error(`admin grant failed: ${(err as Error).message}`);
  }
}

void main();
