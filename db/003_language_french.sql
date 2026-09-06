-- =====================================================================
-- Add French as a supported interface language.
--
-- A CHECK constraint rather than an enum: languages get added over the life
-- of the product (Arabic for Zanzibar is the obvious next one), and altering
-- a CHECK is a metadata-only operation while adding an enum value cannot be
-- done inside a transaction with other DDL.
-- =====================================================================

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_preferred_language_check;

ALTER TABLE users
  ADD CONSTRAINT users_preferred_language_check
  CHECK (preferred_language IN ('sw', 'en', 'fr'));

COMMENT ON COLUMN users.preferred_language IS
  'ISO 639-1. sw = Kiswahili (default), en = English, fr = Français. '
  'Drives SMS, push notification and receipt language.';

-- Index only the non-default languages. The overwhelming majority of rows
-- are 'sw', so a full index would be mostly dead weight; this one makes
-- "send the French cohort a notice" cheap without paying for the common case.
CREATE INDEX IF NOT EXISTS users_language_idx
  ON users (preferred_language)
  WHERE preferred_language <> 'sw';
