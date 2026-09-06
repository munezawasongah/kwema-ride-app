-- =====================================================================
-- Card payments and cash debt tracking.
-- =====================================================================

-- DPO joins the aggregator set. Kept as free text rather than an enum for
-- the same reason as the language column: adding a payment provider should
-- not require an enum migration.
COMMENT ON COLUMN transactions.aggregator IS
  'Payment processor: azampay | selcom (mobile money), dpo (card). '
  'NULL for cash.';

-- Hosted checkout URL for card payments. Short-lived — DPO tokens expire in
-- minutes — but retained for support to reconstruct what the rider was shown.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS checkout_url TEXT;

-- Card metadata. Last four digits and brand only: storing more would pull
-- this database into PCI DSS scope, and there is no reason to.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS card_last_four CHAR(4),
  ADD COLUMN IF NOT EXISTS card_brand VARCHAR(24);

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_no_pan_check;

-- Defence in depth: a receipt field long enough to hold a full card number
-- is rejected outright. If a future code change ever tried to store a PAN
-- here, the insert fails rather than quietly creating a compliance breach.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_no_pan_check
  CHECK (mno_receipt IS NULL OR length(mno_receipt) < 13);

-- Cash debt ceiling, denormalised onto the driver so dispatch can filter on
-- it without a join. Maintained by CashService.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS debt_ceiling_cents BIGINT NOT NULL DEFAULT 3000000,
  ADD COLUMN IF NOT EXISTS cash_blocked_at TIMESTAMPTZ;

-- Drivers currently blocked over unsettled cash commission. Small partial
-- index — most drivers are never in this state, and finance queries it daily.
CREATE INDEX IF NOT EXISTS drivers_cash_blocked_idx
  ON drivers (wallet_balance_cents)
  WHERE wallet_balance_cents < 0;

-- Card transactions awaiting 3-D Secure completion. The reconciliation job
-- sweeps these; a customer who abandons the WebView leaves one behind.
CREATE INDEX IF NOT EXISTS transactions_card_pending_idx
  ON transactions (initiated_at)
  WHERE method = 'card' AND status IN ('pending', 'processing');
