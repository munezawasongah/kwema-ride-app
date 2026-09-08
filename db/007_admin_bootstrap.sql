-- =====================================================================
-- Remove the seeded placeholder administrator.
--
-- 002_seed.sql created an admin on +255700000000, a number nobody owns. A
-- dormant admin account tied to an unowned phone is exactly the kind of thing
-- that sits forgotten until someone acquires that number, so it goes.
--
-- The real administrator is promoted at startup from the ADMIN_PHONE
-- environment variable — see src/db/migrate.ts. That keeps a personal number
-- out of a public repository, and makes the grant reversible by changing a
-- Railway variable rather than editing an applied migration.
-- =====================================================================

-- Soft delete rather than DELETE: the account may already be referenced by
-- audit columns such as tariffs.created_by or drivers.compliance_verified_by,
-- and a hard delete would either fail on the constraint or orphan the trail.
UPDATE users
   SET roles = ARRAY['rider']::user_role[],
       status = 'suspended',
       deleted_at = COALESCE(deleted_at, now()),
       full_name = 'Removed placeholder admin'
 WHERE phone = '+255700000000';

-- Guard against a second one ever being seeded by accident.
COMMENT ON COLUMN users.roles IS
  'Role array. Administrators are granted via the ADMIN_PHONE environment '
  'variable at startup, never seeded into a migration — a committed admin '
  'phone number is a credential in version control.';
