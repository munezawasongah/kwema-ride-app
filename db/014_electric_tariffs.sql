-- =====================================================================
-- Rate cards for the electric tiers.
--
-- Split from 013 because Postgres will not let a newly added enum value be
-- used in the same transaction that added it. The migration runner wraps each
-- file in a transaction, so this has to be a separate file — not a style
-- choice.
--
-- Pricing: electric tiers are set roughly 10% below their petrol equivalent
-- on the per-kilometre rate. Running costs are far lower than that, but the
-- purchase price is much higher, so the margin goes to the driver paying off
-- the vehicle rather than entirely to the rider. Revise once there is real
-- data on what an electric driver actually earns per shift.
-- =====================================================================

INSERT INTO tariffs (
    zone_id, category, service_type,
    base_fare_cents, per_km_cents, per_minute_cents,
    minimum_fare_cents, cancellation_fee_cents,
    waiting_per_minute_cents, free_waiting_seconds,
    commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
    valid_from, gazette_reference
)
SELECT
    t.zone_id,
    e.electric,
    t.service_type,
    t.base_fare_cents,
    round(t.per_km_cents * 0.90),
    t.per_minute_cents,
    t.minimum_fare_cents,
    t.cancellation_fee_cents,
    t.waiting_per_minute_cents,
    t.free_waiting_seconds,
    t.commission_bps_cap,
    t.booking_fee_bps_cap,
    t.max_surge_multiplier,
    now(),
    COALESCE(t.gazette_reference, '') || ' (electric tier)'
FROM tariffs t
JOIN (VALUES
    ('boda'::vehicle_category,     'e_boda'::vehicle_category),
    ('bajaji'::vehicle_category,   'e_bajaji'::vehicle_category),
    ('standard'::vehicle_category, 'e_car'::vehicle_category)
) AS e(petrol, electric) ON e.petrol = t.category
WHERE t.valid_to IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM tariffs x
     WHERE x.valid_to IS NULL
       AND x.category = e.electric
       AND x.service_type = t.service_type
       AND x.zone_id IS NOT DISTINCT FROM t.zone_id
  );

-- Electric vehicles are silent, which is a genuine safety consideration for
-- a pedestrian and worth recording against the vehicle for driver briefing.
COMMENT ON TYPE vehicle_category IS
  'Vehicle tiers. e_ prefixed values are electric equivalents with their own '
  'rate cards; a bajaji is a tuk-tuk, so there is no separate tuk-tuk tier.';
