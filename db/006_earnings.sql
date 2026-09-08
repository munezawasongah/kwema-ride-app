-- =====================================================================
-- Driver earnings and settlement.
--
-- The core fact this schema has to make obvious: money flows in OPPOSITE
-- directions depending on how the rider paid.
--
--   Cash trip      the driver already holds the full fare, so the platform
--                  is owed the commission. Driver wallet goes NEGATIVE.
--
--   Mobile/card    the platform collected the fare, so the platform owes the
--                  driver their share. Driver wallet goes POSITIVE.
--
-- A driver working both therefore has the two netting against each other, and
-- `drivers.wallet_balance_cents` is the single net position:
--
--   balance > 0    we owe the driver this much  -> include in payout run
--   balance < 0    the driver owes us this much -> collect before dispatch
--                  is blocked at the ceiling
--
-- Reporting gross earnings without that split is what produces drivers who
-- believe they are owed money the platform has already effectively paid them
-- in cash.
-- =====================================================================

-- Per-driver, per-day rollup. Materialising this is deliberate: the finance
-- questions ("what did we owe on the 3rd?") are historical, and recomputing
-- them across the whole rides table gets slower every week.
CREATE OR REPLACE VIEW driver_earnings_daily AS
SELECT
    r.driver_id,
    (r.completed_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date AS day,

    COUNT(*)                                   AS trips,
    COUNT(*) FILTER (WHERE r.payment_method = 'cash')     AS cash_trips,
    COUNT(*) FILTER (WHERE r.payment_method <> 'cash')    AS digital_trips,

    -- What riders were charged, before any split.
    COALESCE(SUM(r.final_fare_cents), 0)       AS gross_fares_cents,

    -- The platform's cut and the tax on it.
    COALESCE(SUM(r.commission_cents), 0)       AS commission_cents,
    COALESCE(SUM(r.vat_cents), 0)              AS vat_cents,
    COALESCE(SUM(r.booking_fee_cents), 0)      AS booking_fee_cents,

    -- The driver's share of every trip, regardless of payment method.
    COALESCE(SUM(r.driver_earnings_cents), 0)  AS driver_earnings_cents,

    -- Cash physically handed to the driver. They keep this; the commission on
    -- it becomes a debt.
    COALESCE(SUM(r.final_fare_cents)
             FILTER (WHERE r.payment_method = 'cash'), 0)  AS cash_collected_cents,
    COALESCE(SUM(r.commission_cents)
             FILTER (WHERE r.payment_method = 'cash'), 0)  AS commission_owed_cents,

    -- Fares the platform collected. The driver's share of these is a payable.
    COALESCE(SUM(r.final_fare_cents)
             FILTER (WHERE r.payment_method <> 'cash'), 0) AS digital_collected_cents,
    COALESCE(SUM(r.driver_earnings_cents)
             FILTER (WHERE r.payment_method <> 'cash'), 0) AS payable_to_driver_cents,

    COALESCE(SUM(r.actual_distance_m), 0)      AS distance_m,
    COALESCE(SUM(r.actual_duration_s), 0)      AS duration_s
FROM rides r
WHERE r.status = 'completed'
  AND r.driver_id IS NOT NULL
GROUP BY r.driver_id, (r.completed_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date;

COMMENT ON VIEW driver_earnings_daily IS
  'Completed trips rolled up per driver per calendar day, East Africa Time. '
  'Days are local, not UTC: a driver working until 01:00 would otherwise see '
  'their night split across two days and dispute the figures.';

-- The earnings queries all filter on driver + completion date.
CREATE INDEX IF NOT EXISTS rides_driver_completed_idx
  ON rides (driver_id, completed_at DESC)
  WHERE status = 'completed';

-- Payout runs scan for drivers the platform owes.
CREATE INDEX IF NOT EXISTS drivers_payable_idx
  ON drivers (wallet_balance_cents DESC)
  WHERE wallet_balance_cents > 0;

-- Settlement records: every payout and every debt collection, append-only.
CREATE TABLE IF NOT EXISTS driver_settlements (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id          UUID NOT NULL REFERENCES drivers(id),
    direction          txn_direction NOT NULL,   -- disbursement | collection
    amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),

    -- Wallet position before and after, so a disputed statement can be
    -- reconstructed exactly rather than re-derived from current data.
    balance_before_cents BIGINT NOT NULL,
    balance_after_cents  BIGINT NOT NULL,

    period_start       DATE,
    period_end         DATE,
    method             payment_method NOT NULL DEFAULT 'mobile_money',
    provider           mno,
    external_reference VARCHAR(64) UNIQUE,
    mno_receipt        VARCHAR(40),
    status             txn_status NOT NULL DEFAULT 'pending',
    failure_reason     TEXT,
    notes              TEXT,
    created_by         UUID REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS driver_settlements_driver_idx
  ON driver_settlements (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS driver_settlements_pending_idx
  ON driver_settlements (status, created_at)
  WHERE status IN ('pending', 'processing');
