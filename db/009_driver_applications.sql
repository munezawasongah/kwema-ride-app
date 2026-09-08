-- =====================================================================
-- Driver applications from the public website.
--
-- Deliberately NOT the drivers table. An application is an unverified lead:
-- the phone number has not been proven, no documents exist, and nobody has
-- checked a licence. Writing straight into `drivers` would mean anyone with
-- the form URL could put a name into the fleet.
--
-- The path to becoming a driver stays: apply here → sign up in the app with
-- that number (which verifies it by OTP) → admin creates the driver record
-- against the verified account → admin approves once documents check out.
-- =====================================================================

CREATE TYPE application_status AS ENUM (
  'new',          -- just submitted
  'contacted',    -- someone has spoken to them
  'documents',    -- waiting on paperwork
  'approved',     -- driver record created
  'rejected',
  'duplicate'
);

CREATE TABLE IF NOT EXISTS driver_applications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     VARCHAR(120) NOT NULL,
    phone         VARCHAR(16)  NOT NULL,
    email         CITEXT,
    city          VARCHAR(60),
    -- What they intend to drive. Not binding; the vehicle is recorded properly
    -- when the driver record is created.
    vehicle_type  vehicle_category,

    status        application_status NOT NULL DEFAULT 'new',
    notes         TEXT,
    handled_by    UUID REFERENCES users(id),
    handled_at    TIMESTAMPTZ,

    -- Consent to being contacted, recorded with a timestamp. Tanzania's
    -- Personal Data Protection Act requires a lawful basis for holding this
    -- data; an unticked box means we should not have the record at all, so
    -- the column is NOT NULL.
    consent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Kept for abuse investigation only, and short-lived: a retention job
    -- should clear these once an application is resolved.
    source_ip     INET,
    user_agent    TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT driver_applications_phone_e164 CHECK (phone ~ '^\+255[0-9]{9}$')
);

-- One live application per number. A second submission updates the first
-- rather than filling the queue with duplicates — people do resubmit when a
-- form does not obviously confirm.
CREATE UNIQUE INDEX IF NOT EXISTS driver_applications_phone_open_uidx
    ON driver_applications (phone)
    WHERE status IN ('new', 'contacted', 'documents');

CREATE INDEX IF NOT EXISTS driver_applications_queue_idx
    ON driver_applications (status, created_at DESC);

CREATE TRIGGER driver_applications_touch
    BEFORE UPDATE ON driver_applications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
