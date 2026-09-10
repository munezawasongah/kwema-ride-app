-- =====================================================================
-- Kwema Delivery and Kwema Food.
--
-- Both are courier jobs: collect something at A, hand it to a named person
-- at B. That is the same shape as a ride, so they extend `rides` rather than
-- getting a parallel table. Dispatch, the fare engine, payments, SOS,
-- ratings and the breadcrumb trail all work unchanged.
--
-- What a delivery needs that a ride does not:
--   * a recipient who is not the person who booked
--   * a description of what is being carried
--   * proof that it reached the right person
--   * the option for the recipient to pay on receipt
-- =====================================================================

CREATE TYPE service_type AS ENUM ('ride', 'parcel', 'food');
CREATE TYPE parcel_size AS ENUM ('small', 'medium', 'large');
CREATE TYPE payer AS ENUM ('sender', 'recipient');

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS service_type service_type NOT NULL DEFAULT 'ride';

CREATE INDEX IF NOT EXISTS rides_service_idx
  ON rides (service_type, requested_at DESC);

-- A rider may have one active job PER SERVICE, not one overall. Sending a
-- parcel across town should not stop someone hailing a ride while they wait.
DROP INDEX IF EXISTS rides_one_active_per_rider;
CREATE UNIQUE INDEX rides_one_active_per_service
  ON rides (rider_id, service_type)
  WHERE status IN ('requested', 'searching', 'accepted', 'arrived', 'in_progress');

-- ---------------------------------------------------------------------
-- Delivery detail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
    ride_id          UUID PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,

    -- The person receiving. Usually not the account holder, which is the
    -- whole difference from a ride.
    recipient_name   VARCHAR(120) NOT NULL,
    recipient_phone  VARCHAR(16)  NOT NULL,
    recipient_note   TEXT,

    -- What is being carried. Free text plus a size band, because a courier
    -- needs to know whether it fits on a boda before accepting.
    description      VARCHAR(240) NOT NULL,
    size             parcel_size NOT NULL DEFAULT 'small',

    -- Declared value, for disputes. Not insurance — the platform does not
    -- underwrite anything, and the apps say so.
    declared_value_cents BIGINT,

    -- Who settles the fare. Cash on delivery is normal here: a sender in
    -- Kariakoo sends goods and the buyer pays the courier on receipt.
    fare_paid_by     payer NOT NULL DEFAULT 'sender',

    -- Money the courier collects from the recipient on the sender's behalf,
    -- separate from the delivery fare. Tracked so it appears on the driver's
    -- statement and is never confused with earnings.
    cash_to_collect_cents BIGINT NOT NULL DEFAULT 0,

    -- Four digits given to the sender, passed to the recipient, quoted to the
    -- courier at handover. Chosen over a signature or photo because it works
    -- on any handset, needs no data, and proves the right person received it.
    delivery_code    CHAR(4) NOT NULL,

    collected_at     TIMESTAMPTZ,
    delivered_at     TIMESTAMPTZ,
    delivered_to     VARCHAR(120),
    failure_reason   TEXT,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT deliveries_recipient_e164
      CHECK (recipient_phone ~ '^\+255[0-9]{9}$'),
    CONSTRAINT deliveries_code_digits
      CHECK (delivery_code ~ '^[0-9]{4}$')
);

CREATE INDEX IF NOT EXISTS deliveries_recipient_idx ON deliveries (recipient_phone);
CREATE INDEX IF NOT EXISTS deliveries_undelivered_idx
  ON deliveries (created_at) WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------
-- Tariffs per service
--
-- A parcel is not priced like a passenger. There is handling at both ends,
-- a courier often waits at a restaurant, and there is no passenger comfort
-- to pay for. Rather than bolt a multiplier onto ride fares, each service
-- gets its own versioned rate card — the same discipline that keeps historic
-- fares reproducible for a ride.
-- ---------------------------------------------------------------------
ALTER TABLE tariffs
  ADD COLUMN IF NOT EXISTS service_type service_type NOT NULL DEFAULT 'ride';

DROP INDEX IF EXISTS tariffs_live_uidx;
CREATE UNIQUE INDEX tariffs_live_uidx
  ON tariffs (
    COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid),
    category,
    service_type
  )
  WHERE valid_to IS NULL;

-- Seed parcel and food cards from the live ride cards.
--
-- Base fare carries a handling charge; the per-km and per-minute rates are
-- inherited. Food adds slightly more than a parcel because a courier
-- routinely waits for an order to be prepared, and waiting is the cost that
-- surprises new couriers most.
INSERT INTO tariffs (
    zone_id, category, service_type,
    base_fare_cents, per_km_cents, per_minute_cents,
    minimum_fare_cents, cancellation_fee_cents,
    waiting_per_minute_cents, free_waiting_seconds,
    commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
    valid_from, gazette_reference
)
SELECT
    t.zone_id, t.category, s.svc,
    t.base_fare_cents + s.handling,
    t.per_km_cents,
    t.per_minute_cents,
    t.minimum_fare_cents + s.handling,
    t.cancellation_fee_cents,
    t.waiting_per_minute_cents,
    s.free_wait,
    t.commission_bps_cap,
    t.booking_fee_bps_cap,
    t.max_surge_multiplier,
    now(),
    'Derived from the ride card; operator-set handling charge'
FROM tariffs t
CROSS JOIN (VALUES
    ('parcel'::service_type, 50000,  180),   -- +500 TZS handling, 3 min free
    ('food'::service_type,   80000,  600)    -- +800 TZS, 10 min free at the vendor
) AS s(svc, handling, free_wait)
WHERE t.valid_to IS NULL
  AND t.service_type = 'ride'
  -- Only tiers that can realistically carry goods.
  AND t.category IN ('boda', 'bajaji', 'standard')
  AND NOT EXISTS (
    SELECT 1 FROM tariffs x
     WHERE x.valid_to IS NULL
       AND x.service_type = s.svc
       AND x.category = t.category
       AND x.zone_id IS NOT DISTINCT FROM t.zone_id
  );

COMMENT ON TABLE deliveries IS
  'Parcel and food courier jobs. The ride row carries route, fare and '
  'dispatch; this carries who receives it and the proof it arrived.';
