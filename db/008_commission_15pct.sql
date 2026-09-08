-- =====================================================================
-- Commission set to 15%.
--
-- Basis points: 1500 = 15%. Previous rate cards carried 2500 (25%).
--
-- Done as a NEW tariff version rather than an UPDATE of the existing rows.
-- That is the whole point of the valid_from / valid_to design: a fare charged
-- last week must still be reproducible from the rate card that was in force
-- when it was charged. Overwriting the commission in place would silently
-- rewrite the history of every completed trip's split.
--
-- Note this is the operator's own commission, not a regulatory figure. LATRA
-- sets a CEILING; charging below it is permitted, charging above is not.
-- =====================================================================

-- Close the current cards.
UPDATE tariffs
   SET valid_to = now()
 WHERE valid_to IS NULL
   AND commission_bps_cap <> 1500;

-- Reopen each as a new version with 15% commission, carrying every other
-- rate across unchanged.
INSERT INTO tariffs (
    zone_id, category,
    base_fare_cents, per_km_cents, per_minute_cents,
    minimum_fare_cents, cancellation_fee_cents,
    waiting_per_minute_cents, free_waiting_seconds,
    commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
    valid_from, gazette_reference
)
SELECT
    t.zone_id, t.category,
    t.base_fare_cents, t.per_km_cents, t.per_minute_cents,
    t.minimum_fare_cents, t.cancellation_fee_cents,
    t.waiting_per_minute_cents, t.free_waiting_seconds,
    1500,                      -- 15% operator commission
    t.booking_fee_bps_cap,
    t.max_surge_multiplier,
    now(),
    -- Preserve whatever traceability the previous card carried, and record
    -- why this version exists.
    CASE
      WHEN t.gazette_reference LIKE 'PLACEHOLDER%'
        THEN 'PLACEHOLDER rates, commission set to 15% by operator'
      ELSE t.gazette_reference || ' (commission 15%)'
    END
FROM tariffs t
WHERE t.valid_to IS NOT NULL
  AND t.commission_bps_cap <> 1500
  -- Only the rows this migration just closed, not historical versions.
  AND t.valid_to >= now() - interval '1 minute'
  AND NOT EXISTS (
        SELECT 1 FROM tariffs live
         WHERE live.valid_to IS NULL
           AND live.category = t.category
           AND live.zone_id IS NOT DISTINCT FROM t.zone_id
      );
