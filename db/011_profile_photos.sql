-- =====================================================================
-- Profile photos for riders and drivers.
--
-- LATRA tests a ride-hailing app before issuing an operator licence, and one
-- of its criteria is that the rider can see the driver's name AND photo. So
-- this is a licensing requirement, not a nicety.
--
-- Photos are stored in the database rather than object storage. That is a
-- deliberate trade for this stage: no S3 credentials, no bucket policy, no
-- extra failure mode, and images are resized server-side to roughly 40-60 KB
-- so the column stays small. Move to object storage when the fleet is large
-- enough that this table's size starts to matter.
--
-- The photo is addressed by an unguessable key, not by user id. A URL like
-- /api/photos/{user-id} would let anyone enumerate every face on the
-- platform; a random key is a capability that only someone shown the photo
-- can hold, and rotating it on re-upload invalidates the old one.
-- =====================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS photo_key        VARCHAR(43),
  ADD COLUMN IF NOT EXISTS photo_bytes      BYTEA,
  ADD COLUMN IF NOT EXISTS photo_mime       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

-- The lookup path for every photo request.
CREATE UNIQUE INDEX IF NOT EXISTS users_photo_key_uidx
  ON users (photo_key)
  WHERE photo_key IS NOT NULL;

-- Guard against an oversized image reaching the column. The service resizes
-- before writing, but a constraint means a future code path cannot quietly
-- start storing multi-megabyte originals.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_photo_size_check;
ALTER TABLE users
  ADD CONSTRAINT users_photo_size_check
  CHECK (photo_bytes IS NULL OR length(photo_bytes) <= 400000);

COMMENT ON COLUMN users.photo_key IS
  'Unguessable public handle for the photo. Addressing by user id instead '
  'would let anyone enumerate every face on the platform.';
COMMENT ON COLUMN users.photo_bytes IS
  'Resized JPEG, roughly 40-60 KB. All EXIF is dropped on re-encode, which '
  'matters: phone photos carry GPS coordinates of where they were taken.';
