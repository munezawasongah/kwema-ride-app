-- =====================================================================
-- Kwema Ride — seed data
--
-- IMPORTANT: the tariff figures below are PLACEHOLDERS shaped to the right
-- structure, not the rates currently in force. LATRA sets guide fares per km
-- and per minute, a minimum fare, and ceilings on commission and booking fee,
-- and it has revised them by gazette notice more than once. Before go-live,
-- replace every row here with the values from the notice in force and put its
-- reference in `gazette_reference`.
--
-- The commission ceiling is expressed in basis points: 2500 = 25%.
-- Money is in cents of TZS: 50000 = 500 TZS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Service zones
-- ---------------------------------------------------------------------

-- Dar es Salaam operating area (rough bounding polygon; replace with the
-- real operating boundary before launch).
INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories)
VALUES (
  'DAR_METRO',
  'Dar es Salaam',
  'Dar es Salaam',
  ST_GeogFromText('MULTIPOLYGON(((
    39.1000 -7.0500,
    39.4200 -7.0500,
    39.4200 -6.6000,
    39.1000 -6.6000,
    39.1000 -7.0500
  )))'),
  '{boda,bajaji,standard,xl,express}'
)
ON CONFLICT (code) DO NOTHING;

-- Julius Nyerere International Airport. Smaller polygon wins in
-- zone_for_point(), so the airport surcharge applies over the metro tariff.
-- Motorcycles are excluded from the terminal approach.
INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories, pickup_surcharge_cents)
VALUES (
  'JNIA_AIRPORT',
  'Uwanja wa Ndege wa Julius Nyerere',
  'Julius Nyerere International Airport',
  ST_GeogFromText('MULTIPOLYGON(((
    39.1950 -6.8900,
    39.2350 -6.8900,
    39.2350 -6.8550,
    39.1950 -6.8550,
    39.1950 -6.8900
  )))'),
  '{bajaji,standard,xl,express}',
  200000  -- 2,000 TZS airport pickup surcharge
)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- National tariffs (zone_id NULL — the fallback for every city)
-- ---------------------------------------------------------------------

INSERT INTO tariffs (
  zone_id, category,
  base_fare_cents, per_km_cents, per_minute_cents,
  minimum_fare_cents, cancellation_fee_cents,
  waiting_per_minute_cents, free_waiting_seconds,
  commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
  valid_from, gazette_reference
) VALUES
  -- Bodaboda: motorcycle, single passenger, shortest trips
  (NULL, 'boda',     50000,  35000, 3000,  100000, 50000,  2000, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with LATRA notice in force'),
  -- Bajaji: three-wheeler, 2-3 passengers
  (NULL, 'bajaji',  100000,  50000, 5000,  150000, 70000,  3000, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with LATRA notice in force'),
  -- Standard saloon car
  (NULL, 'standard',200000,  70000, 8000,  300000, 100000, 5000, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with LATRA notice in force'),
  -- XL: 6-7 seats
  (NULL, 'xl',      300000, 100000, 11000, 450000, 150000, 7000, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with LATRA notice in force'),
  -- Express: priority matching on the standard fleet
  (NULL, 'express', 250000,  85000, 10000, 400000, 120000, 6000, 120, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with LATRA notice in force')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Dar-specific overrides — traffic makes the per-minute component matter
-- more here than anywhere else in the country.
-- ---------------------------------------------------------------------

INSERT INTO tariffs (
  zone_id, category,
  base_fare_cents, per_km_cents, per_minute_cents,
  minimum_fare_cents, cancellation_fee_cents,
  waiting_per_minute_cents, free_waiting_seconds,
  commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
  valid_from, gazette_reference
)
SELECT z.id, v.category,
       v.base, v.km, v.min_rate, v.minimum, v.cancel,
       v.waiting, 180, 2500, 300, 1.60, now(),
       'PLACEHOLDER — replace with LATRA notice in force'
FROM service_zones z
CROSS JOIN (VALUES
  ('boda'::vehicle_category,     60000,  40000,  4000, 120000,  50000, 2000),
  ('bajaji'::vehicle_category,  120000,  55000,  6000, 180000,  80000, 3000),
  ('standard'::vehicle_category,250000,  80000, 10000, 350000, 120000, 6000),
  ('xl'::vehicle_category,      350000, 110000, 13000, 500000, 170000, 8000),
  ('express'::vehicle_category, 300000,  95000, 12000, 450000, 140000, 7000)
) AS v(category, base, km, min_rate, minimum, cancel, waiting)
WHERE z.code = 'DAR_METRO'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Admin bootstrap. Replace the phone number before deploying, and note that
-- there is no password: the account authenticates by OTP like any other.
-- ---------------------------------------------------------------------

INSERT INTO users (phone, full_name, roles, status, preferred_language, phone_verified_at)
VALUES ('+255700000000', 'Kwema Admin', '{admin}', 'active', 'en', now())
ON CONFLICT DO NOTHING;
