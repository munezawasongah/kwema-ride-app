-- =====================================================================
-- KWEMA — Ride-hailing platform for Tanzania
-- PostgreSQL 16 + PostGIS 3.4 schema
--
-- Design notes
--  * All money is stored as BIGINT in *cents of TZS* (1 TZS = 100 cents).
--    TZS has no circulating subunit, but storing cents avoids float error
--    and keeps room for per-km rates like 512.50 TZS.
--  * All positions use GEOGRAPHY(Point, 4326) so ST_DWithin/ST_Distance
--    return true metres without manual projection.
--  * Every table that is written by a mobile client carries a
--    client_generated_id for idempotent retries over flaky 3G.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;    -- composite GiST indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy place-name search
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive email

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE user_role         AS ENUM ('rider', 'driver', 'admin', 'support', 'fleet_owner');
CREATE TYPE account_status    AS ENUM ('pending', 'active', 'suspended', 'banned', 'deleted');

-- Vehicle tiers as sold to the market. Bajaji = tuk-tuk, Boda = motorcycle.
CREATE TYPE vehicle_category  AS ENUM ('boda', 'bajaji', 'standard', 'xl', 'express');

CREATE TYPE driver_state      AS ENUM ('offline', 'online_idle', 'on_offer', 'en_route_pickup',
                                       'at_pickup', 'on_trip', 'paused');

CREATE TYPE ride_status       AS ENUM ('requested', 'searching', 'accepted', 'arrived',
                                       'in_progress', 'completed', 'cancelled_by_rider',
                                       'cancelled_by_driver', 'expired', 'failed');

CREATE TYPE payment_method    AS ENUM ('cash', 'mobile_money', 'card', 'wallet', 'corporate');
CREATE TYPE mno               AS ENUM ('mpesa', 'tigopesa', 'airtelmoney', 'halopesa', 'tpesa', 'azampesa');
CREATE TYPE txn_status        AS ENUM ('pending', 'processing', 'success', 'failed', 'reversed', 'timeout');
CREATE TYPE txn_direction     AS ENUM ('collection', 'disbursement');

-- ---------------------------------------------------------------------
-- users
-- Riders, drivers and back-office staff share one identity row so that a
-- driver can also hail a ride without a second account.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- E.164, always +255XXXXXXXXX. Unique index enforces one account/SIM.
    phone               VARCHAR(16)  NOT NULL,
    phone_verified_at   TIMESTAMPTZ,
    email               CITEXT,
    full_name           VARCHAR(120) NOT NULL,
    -- Argon2id hash. NULL for OTP-only riders (the common case in TZ).
    password_hash       TEXT,
    roles               user_role[]  NOT NULL DEFAULT '{rider}',
    status              account_status NOT NULL DEFAULT 'pending',
    preferred_language  CHAR(2)      NOT NULL DEFAULT 'sw',   -- 'sw' | 'en'
    -- NIDA (National ID) number, encrypted at rest by the app layer.
    national_id_enc     BYTEA,
    referral_code       VARCHAR(12) UNIQUE,
    referred_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    rating_avg          NUMERIC(3,2) NOT NULL DEFAULT 5.00 CHECK (rating_avg BETWEEN 1 AND 5),
    rating_count        INTEGER      NOT NULL DEFAULT 0,
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT users_phone_e164 CHECK (phone ~ '^\+255[0-9]{9}$')
);

CREATE UNIQUE INDEX users_phone_uidx ON users (phone) WHERE deleted_at IS NULL;
CREATE INDEX users_roles_gin        ON users USING GIN (roles);
CREATE INDEX users_name_trgm        ON users USING GIN (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- drivers
-- One row per driver profile. LATRA requires per-driver licensing data to
-- be held and producible on demand, so those columns are first-class.
-- ---------------------------------------------------------------------
CREATE TABLE drivers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    -- ---- LATRA / statutory compliance -------------------------------
    latra_licence_no        VARCHAR(40),          -- driver's private-hire licence
    latra_licence_expiry    DATE,
    driving_licence_no      VARCHAR(40)  NOT NULL,
    driving_licence_expiry  DATE         NOT NULL,
    psv_badge_no            VARCHAR(40),          -- public service vehicle badge
    police_clearance_ref    VARCHAR(60),
    police_clearance_expiry DATE,
    compliance_verified_at  TIMESTAMPTZ,
    compliance_verified_by  UUID REFERENCES users(id),

    -- ---- Operational --------------------------------------------------
    state                   driver_state NOT NULL DEFAULT 'offline',
    active_vehicle_id       UUID,                 -- FK added after vehicles
    home_city               VARCHAR(60),          -- 'Dar es Salaam', 'Arusha'...
    -- Rolling counters maintained by the dispatch service; used for scoring.
    offers_sent_24h         INTEGER NOT NULL DEFAULT 0,
    offers_accepted_24h     INTEGER NOT NULL DEFAULT 0,
    acceptance_rate         NUMERIC(4,3) NOT NULL DEFAULT 1.000
                            CHECK (acceptance_rate BETWEEN 0 AND 1),
    cancellation_rate       NUMERIC(4,3) NOT NULL DEFAULT 0.000,
    completed_trips         INTEGER NOT NULL DEFAULT 0,
    -- Negative balance = driver owes commission on cash trips. Blocks
    -- dispatch past a configured floor.
    wallet_balance_cents    BIGINT  NOT NULL DEFAULT 0,

    last_location           GEOGRAPHY(Point, 4326),
    last_location_at        TIMESTAMPTZ,
    -- Denormalised heading/speed so the rider map can dead-reckon between
    -- pings without another round trip.
    last_heading_deg        SMALLINT CHECK (last_heading_deg BETWEEN 0 AND 359),
    last_speed_kph          SMALLINT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot dispatch path in Postgres (fallback when Redis is cold).
-- Partial index keeps it tiny: only drivers who can actually be offered a ride.
CREATE INDEX drivers_dispatchable_gix
    ON drivers USING GIST (last_location)
    WHERE state = 'online_idle';

CREATE INDEX drivers_state_idx       ON drivers (state);
CREATE INDEX drivers_compliance_idx  ON drivers (latra_licence_expiry, driving_licence_expiry);

-- ---------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------
CREATE TABLE vehicles (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id            UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    owner_user_id        UUID REFERENCES users(id),   -- fleet owner, if leased

    category             vehicle_category NOT NULL,
    plate_number         VARCHAR(16) NOT NULL,        -- 'T123 ABC' or 'MC 123 ABC'
    make                 VARCHAR(40) NOT NULL,
    model                VARCHAR(40) NOT NULL,
    year                 SMALLINT CHECK (year BETWEEN 1980 AND 2100),
    colour               VARCHAR(24),
    seats                SMALLINT NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 14),

    -- Statutory documents
    insurance_policy_no  VARCHAR(60) NOT NULL,
    insurance_expiry     DATE        NOT NULL,
    inspection_expiry    DATE,                         -- LATRA roadworthiness
    latra_vehicle_licence VARCHAR(40),

    -- Boda/bajaji specific
    helmets_provided     SMALLINT DEFAULT 0,

    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vehicles_plate_uidx ON vehicles (upper(replace(plate_number, ' ', '')));
CREATE INDEX vehicles_driver_idx        ON vehicles (driver_id) WHERE is_active;
CREATE INDEX vehicles_category_idx      ON vehicles (category)  WHERE is_active;

ALTER TABLE drivers
    ADD CONSTRAINT drivers_active_vehicle_fk
    FOREIGN KEY (active_vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- service_zones — geofences used for surge tiles, airport rules, and
-- LATRA per-region tariff variations (Dar fares differ from Dodoma).
-- ---------------------------------------------------------------------
CREATE TABLE service_zones (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          VARCHAR(32) NOT NULL UNIQUE,   -- 'DAR_CBD', 'JNIA_AIRPORT'
    name_sw       VARCHAR(80) NOT NULL,
    name_en       VARCHAR(80) NOT NULL,
    boundary      GEOGRAPHY(MultiPolygon, 4326) NOT NULL,
    -- Zones may forbid a category (e.g. no boda on the Nyerere flyover).
    allowed_categories vehicle_category[] NOT NULL DEFAULT
        '{boda,bajaji,standard,xl,express}',
    pickup_surcharge_cents BIGINT NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX service_zones_gix ON service_zones USING GIST (boundary) WHERE is_active;

-- ---------------------------------------------------------------------
-- tariffs — the LATRA-approved rate card. Versioned by validity window so
-- a gazette notice becomes a new row, never an UPDATE. Historic fares stay
-- reproducible during a regulator audit.
-- ---------------------------------------------------------------------
CREATE TABLE tariffs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id                UUID REFERENCES service_zones(id),  -- NULL = national
    category               vehicle_category NOT NULL,

    base_fare_cents        BIGINT NOT NULL,
    per_km_cents           BIGINT NOT NULL,
    per_minute_cents       BIGINT NOT NULL,
    minimum_fare_cents     BIGINT NOT NULL,
    cancellation_fee_cents BIGINT NOT NULL DEFAULT 0,
    waiting_per_minute_cents BIGINT NOT NULL DEFAULT 0,
    free_waiting_seconds   INTEGER NOT NULL DEFAULT 180,

    -- Regulator-set ceilings, expressed as basis points (10000 = 100%).
    -- Held as data, not constants: LATRA has changed these by gazette
    -- notice more than once, and the value must be verified against the
    -- notice in force before go-live.
    commission_bps_cap     INTEGER NOT NULL CHECK (commission_bps_cap BETWEEN 0 AND 10000),
    booking_fee_bps_cap    INTEGER NOT NULL DEFAULT 0,
    max_surge_multiplier   NUMERIC(3,2) NOT NULL DEFAULT 1.00,

    valid_from             TIMESTAMPTZ NOT NULL,
    valid_to               TIMESTAMPTZ,
    gazette_reference      VARCHAR(80),        -- e.g. 'GN 7284 / 30-12-2022'
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one live tariff per (zone, category) at any instant.
CREATE UNIQUE INDEX tariffs_live_uidx
    ON tariffs (COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
    WHERE valid_to IS NULL;
CREATE INDEX tariffs_lookup_idx ON tariffs (category, valid_from DESC);

-- ---------------------------------------------------------------------
-- rides
-- ---------------------------------------------------------------------
CREATE TABLE rides (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Human-readable code shown in-app and quoted to support: 'TZ-8H3K2M'
    reference            VARCHAR(12) NOT NULL UNIQUE,
    client_generated_id  UUID NOT NULL,           -- idempotency for retries

    rider_id             UUID NOT NULL REFERENCES users(id),
    driver_id            UUID REFERENCES drivers(id),
    vehicle_id           UUID REFERENCES vehicles(id),
    requested_category   vehicle_category NOT NULL,
    status               ride_status NOT NULL DEFAULT 'requested',

    pickup_point         GEOGRAPHY(Point, 4326) NOT NULL,
    pickup_address       TEXT,
    dropoff_point        GEOGRAPHY(Point, 4326),
    dropoff_address      TEXT,
    -- Encoded polyline of the actual driven route, backfilled on completion.
    route_polyline       TEXT,
    pickup_zone_id       UUID REFERENCES service_zones(id),

    -- Quote snapshot: what the rider agreed to before dispatch.
    tariff_id            UUID REFERENCES tariffs(id),
    quoted_fare_cents    BIGINT,
    quoted_distance_m    INTEGER,
    quoted_duration_s    INTEGER,
    surge_multiplier     NUMERIC(3,2) NOT NULL DEFAULT 1.00,

    -- Settlement: what actually happened.
    actual_distance_m    INTEGER,
    actual_duration_s    INTEGER,
    waiting_seconds      INTEGER NOT NULL DEFAULT 0,
    final_fare_cents     BIGINT,
    commission_cents     BIGINT,
    booking_fee_cents    BIGINT NOT NULL DEFAULT 0,
    vat_cents            BIGINT NOT NULL DEFAULT 0,
    driver_earnings_cents BIGINT,

    payment_method       payment_method NOT NULL DEFAULT 'cash',
    is_paid              BOOLEAN NOT NULL DEFAULT FALSE,

    requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at          TIMESTAMPTZ,
    arrived_at           TIMESTAMPTZ,
    started_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    cancelled_at         TIMESTAMPTZ,
    cancellation_reason  TEXT,

    rider_rating         SMALLINT CHECK (rider_rating BETWEEN 1 AND 5),
    driver_rating        SMALLINT CHECK (driver_rating BETWEEN 1 AND 5),

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rides_idempotency_uidx ON rides (rider_id, client_generated_id);
CREATE INDEX rides_pickup_gix   ON rides USING GIST (pickup_point);
CREATE INDEX rides_dropoff_gix  ON rides USING GIST (dropoff_point);
CREATE INDEX rides_rider_idx    ON rides (rider_id, requested_at DESC);
CREATE INDEX rides_driver_idx   ON rides (driver_id, requested_at DESC);
-- Open rides: the set the dispatcher and ops dashboard scan constantly.
CREATE INDEX rides_open_idx     ON rides (status, requested_at)
    WHERE status IN ('requested', 'searching', 'accepted', 'arrived', 'in_progress');
-- Unsettled cash commission, driven by the finance job.
CREATE INDEX rides_unpaid_idx   ON rides (driver_id) WHERE NOT is_paid AND status = 'completed';

-- Only one live ride per rider at a time.
CREATE UNIQUE INDEX rides_one_active_per_rider
    ON rides (rider_id)
    WHERE status IN ('requested', 'searching', 'accepted', 'arrived', 'in_progress');

-- ---------------------------------------------------------------------
-- locations — the raw breadcrumb stream.
-- High write volume (1 row/driver/4s while online). Partitioned by day and
-- dropped after the LATRA record-retention window; hot lookups live in Redis.
-- ---------------------------------------------------------------------
CREATE TABLE locations (
    id             BIGSERIAL,
    driver_id      UUID NOT NULL,
    ride_id        UUID,                      -- NULL when idle/cruising
    position       GEOGRAPHY(Point, 4326) NOT NULL,
    heading_deg    SMALLINT,
    speed_kph      SMALLINT,
    accuracy_m     SMALLINT,
    -- Device clock; may lag server time when the queue drained from offline.
    recorded_at    TIMESTAMPTZ NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- TRUE when this ping was replayed from the device's offline buffer.
    is_backfilled  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Create partitions ahead of time (pg_partman or a nightly cron in prod).
CREATE TABLE locations_2026_09 PARTITION OF locations
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE locations_2026_10 PARTITION OF locations
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE INDEX locations_ride_idx  ON locations (ride_id, recorded_at);
CREATE INDEX locations_gix       ON locations USING GIST (position);
CREATE INDEX locations_driver_time_idx ON locations (driver_id, recorded_at DESC);

-- ---------------------------------------------------------------------
-- transactions — money movement ledger (collections and payouts).
-- Append-only: corrections are new rows, never UPDATEs of amount.
-- ---------------------------------------------------------------------
CREATE TABLE transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID REFERENCES rides(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    direction           txn_direction NOT NULL,
    method              payment_method NOT NULL,
    provider            mno,                        -- NULL for cash/card
    -- Aggregator that fronted the request: 'azampay' | 'selcom' | 'dpo'
    aggregator          VARCHAR(24),

    amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'TZS',
    status              txn_status NOT NULL DEFAULT 'pending',

    -- Our reference sent to the aggregator; must be unique for reconciliation.
    external_reference  VARCHAR(64) NOT NULL UNIQUE,
    -- Aggregator's own id, returned on the checkout response.
    aggregator_txn_id   VARCHAR(80),
    -- MNO receipt shown to the customer, e.g. an M-Pesa 'QGH4XXXXXX'.
    mno_receipt         VARCHAR(40),
    payer_phone         VARCHAR(16),

    -- Raw webhook body retained for dispute resolution and signature replay.
    callback_payload    JSONB,
    failure_reason      TEXT,
    attempt_count       SMALLINT NOT NULL DEFAULT 1,

    initiated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transactions_ride_idx     ON transactions (ride_id);
CREATE INDEX transactions_user_idx     ON transactions (user_id, created_at DESC);
CREATE INDEX transactions_pending_idx  ON transactions (status, initiated_at)
    WHERE status IN ('pending', 'processing');
CREATE INDEX transactions_receipt_idx  ON transactions (mno_receipt);
CREATE INDEX transactions_callback_gin ON transactions USING GIN (callback_payload);

-- ---------------------------------------------------------------------
-- ride_offers — the dispatch audit trail. One row per driver we pinged.
-- Also the source data for acceptance_rate.
-- ---------------------------------------------------------------------
CREATE TABLE ride_offers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id        UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    driver_id      UUID NOT NULL REFERENCES drivers(id),
    rank           SMALLINT NOT NULL,            -- 1 = best-scored candidate
    score          NUMERIC(6,4) NOT NULL,
    distance_m     INTEGER NOT NULL,
    eta_seconds    INTEGER,
    offered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    responded_at   TIMESTAMPTZ,
    outcome        VARCHAR(16),                  -- accepted|declined|timeout|superseded
    UNIQUE (ride_id, driver_id)
);

CREATE INDEX ride_offers_driver_idx ON ride_offers (driver_id, offered_at DESC);
CREATE INDEX ride_offers_open_idx   ON ride_offers (expires_at) WHERE outcome IS NULL;

-- ---------------------------------------------------------------------
-- surge_tiles — demand/supply per H3-style tile, refreshed every 60s by a
-- worker. Kept in Postgres for history/analytics; Redis holds the live copy.
-- ---------------------------------------------------------------------
CREATE TABLE surge_tiles (
    tile_id        VARCHAR(20) NOT NULL,        -- geohash6 or H3 index
    category       vehicle_category NOT NULL,
    window_start   TIMESTAMPTZ NOT NULL,
    open_requests  INTEGER NOT NULL,
    idle_drivers   INTEGER NOT NULL,
    multiplier     NUMERIC(3,2) NOT NULL,
    centroid       GEOGRAPHY(Point, 4326),
    PRIMARY KEY (tile_id, category, window_start)
);

CREATE INDEX surge_tiles_recent_idx ON surge_tiles (window_start DESC);

-- =====================================================================
-- Spatial helper functions used by the dispatch fallback path
-- =====================================================================

-- Nearest dispatchable drivers, ordered by true metres.
-- ST_DWithin on GEOGRAPHY uses the GiST index; ST_Distance then refines.
-- Called only when the Redis geo set is unavailable or cold.
CREATE OR REPLACE FUNCTION find_nearby_drivers(
    p_point      GEOGRAPHY(Point, 4326),
    p_radius_m   INTEGER,
    p_category   vehicle_category,
    p_limit      INTEGER DEFAULT 10,
    p_stale_after INTERVAL DEFAULT INTERVAL '45 seconds'
)
RETURNS TABLE (
    driver_id       UUID,
    vehicle_id      UUID,
    distance_m      DOUBLE PRECISION,
    acceptance_rate NUMERIC,
    rating_avg      NUMERIC,
    last_location_at TIMESTAMPTZ
)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT
        d.id,
        v.id,
        ST_Distance(d.last_location, p_point) AS distance_m,
        d.acceptance_rate,
        u.rating_avg,
        d.last_location_at
    FROM drivers d
    JOIN vehicles v ON v.id = d.active_vehicle_id AND v.is_active
    JOIN users    u ON u.id = d.user_id
    WHERE d.state = 'online_idle'
      AND v.category = p_category
      AND u.status = 'active'
      -- Index-backed bounding filter first.
      AND ST_DWithin(d.last_location, p_point, p_radius_m)
      -- Never dispatch to a driver whose GPS went quiet.
      AND d.last_location_at > now() - p_stale_after
      -- Statutory documents must be current at the moment of dispatch.
      AND v.insurance_expiry       >= CURRENT_DATE
      AND d.driving_licence_expiry >= CURRENT_DATE
      AND (d.latra_licence_expiry IS NULL OR d.latra_licence_expiry >= CURRENT_DATE)
    ORDER BY d.last_location <-> p_point   -- KNN operator, uses the GiST index
    LIMIT p_limit;
$$;

-- Resolve which service zone a point falls in (for tariff + surcharge lookup).
CREATE OR REPLACE FUNCTION zone_for_point(p_point GEOGRAPHY(Point, 4326))
RETURNS UUID
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT z.id
    FROM service_zones z
    WHERE z.is_active AND ST_Intersects(z.boundary, p_point)
    -- Smallest matching zone wins, so an airport polygon beats a city polygon.
    ORDER BY ST_Area(z.boundary::geometry) ASC
    LIMIT 1;
$$;

-- Keep updated_at honest without application discipline.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['users','drivers','vehicles','rides','transactions'] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
    END LOOP;
END $$;
