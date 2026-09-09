-- =====================================================================
-- Emergency SOS.
--
-- Design note, because it shapes everything below: Tanzania's national
-- emergency number is 112, but it does not connect reliably outside the
-- larger cities, and there is effectively no government ambulance service.
-- An SOS that only dials 112 would fail exactly where a driver is most
-- isolated.
--
-- So an alert does three things at once:
--   1. reaches Kwema operations with live position and trip context,
--   2. offers one-tap dialling of 112,
--   3. notifies the person's own emergency contact.
--
-- The third matters more here than it would in a country with dependable
-- state services, which is why the contact fields sit on the user record and
-- are prompted for rather than buried in settings.
-- =====================================================================

CREATE TYPE sos_status AS ENUM ('open', 'acknowledged', 'resolved', 'false_alarm');
CREATE TYPE sos_source AS ENUM ('rider', 'driver');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS emergency_contact_name  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(16);

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_emergency_phone_e164;
ALTER TABLE users
  ADD CONSTRAINT users_emergency_phone_e164
  CHECK (emergency_contact_phone IS NULL
         OR emergency_contact_phone ~ '^\+[0-9]{9,15}$');

CREATE TABLE IF NOT EXISTS sos_alerts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id),
    ride_id       UUID REFERENCES rides(id),
    raised_by     sos_source NOT NULL,

    -- Where they were when they pressed it. Nullable because a phone with no
    -- GPS fix must still be able to raise an alarm — losing the alert because
    -- the location was unavailable would be the worst possible failure.
    position      GEOGRAPHY(Point, 4326),
    accuracy_m    SMALLINT,

    status        sos_status NOT NULL DEFAULT 'open',
    note          TEXT,

    -- Whether the contact and the emergency number were reached, so a review
    -- can tell what actually happened rather than what was intended.
    contact_notified_at TIMESTAMPTZ,
    emergency_called    BOOLEAN NOT NULL DEFAULT FALSE,

    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    resolution      TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Open alerts are the only query that matters under pressure, so it gets its
-- own tiny index rather than sharing one with historical rows.
CREATE INDEX IF NOT EXISTS sos_open_idx
  ON sos_alerts (created_at DESC)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS sos_user_idx ON sos_alerts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sos_ride_idx ON sos_alerts (ride_id);
CREATE INDEX IF NOT EXISTS sos_position_gix ON sos_alerts USING GIST (position);

COMMENT ON TABLE sos_alerts IS
  'Emergency alerts raised from the apps. Never deleted: an alert record is '
  'evidence, and a resolved one is how the platform shows it responded.';
