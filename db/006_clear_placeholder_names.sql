-- =====================================================================
-- Clear the "Mteja" placeholder from accounts created before names were
-- captured at signup.
--
-- Blanking the field is deliberate rather than guessing a name: the app
-- treats an empty name as "not yet provided" and asks once on next launch.
-- Leaving the placeholder would mean every early account stayed anonymous
-- to drivers forever, since nothing would ever prompt them.
--
-- 'Mteja' is Swahili for "customer" — it was the seeded default, never
-- something a person typed, so no real name is being discarded here.
-- =====================================================================

UPDATE users
   SET full_name = ''
 WHERE full_name IN ('Mteja', 'mteja', 'MTEJA');

-- Drivers are onboarded with a verified legal name from their licence, so
-- they are excluded from the prompt regardless — but this makes it explicit
-- that only nameless accounts are affected.
COMMENT ON COLUMN users.full_name IS
  'Display name shown to the other party on a trip. Empty means the person '
  'has not provided one yet and the app will ask on next launch.';
