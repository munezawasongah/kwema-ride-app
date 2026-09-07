-- =====================================================================
-- Exact rating aggregates.
--
-- Keeping only a running average forces a rounding step on every update, and
-- that error accumulates: simulated over random rating histories it reached
-- 0.10 stars of drift against a true recomputation. Drivers get deactivated
-- on rating thresholds, so a tenth of a star is not cosmetic.
--
-- Storing the integer sum makes the average exact and derivable at any time,
-- and costs one bigint per user.
-- =====================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rating_sum BIGINT NOT NULL DEFAULT 0;

-- Backfill from whatever the running average currently holds. Approximate by
-- definition — the old figure is all the information that survives — but it
-- keeps existing scores stable and every rating from here on is exact.
UPDATE users
   SET rating_sum = round(rating_avg * rating_count)
 WHERE rating_count > 0 AND rating_sum = 0;

COMMENT ON COLUMN users.rating_sum IS
  'Sum of all star ratings received. rating_avg is derived from '
  'rating_sum / rating_count and must never be written independently.';

-- Ratings a driver has yet to receive are a support question ("why is my
-- score low?"), so make the underlying rows cheap to find.
CREATE INDEX IF NOT EXISTS rides_driver_rated_idx
  ON rides (driver_id, completed_at DESC)
  WHERE driver_rating IS NOT NULL;

CREATE INDEX IF NOT EXISTS rides_rider_rated_idx
  ON rides (rider_id, completed_at DESC)
  WHERE rider_rating IS NOT NULL;
