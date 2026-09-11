-- =====================================================================
-- Electric tiers.
--
-- Three, not four: in Tanzania a bajaji IS a tuk-tuk. Listing both would put
-- two identical options side by side and make riders hesitate over a
-- difference that does not exist.
--
-- Separate categories rather than a flag on `vehicles` because they need
-- their own rate cards. An electric bodaboda costs roughly a third of a
-- petrol one to run per kilometre, and passing some of that on is the reason
-- a rider would choose one. A boolean column could not carry a fare.
--
-- The cost: supply fragments. With a thin fleet, splitting the pool means an
-- e-boda request can find nobody while three petrol boda sit idle nearby. The
-- apps therefore present electric as a preference within a tier group, not as
-- a wholly separate product — see the note on fallback below.
-- =====================================================================

ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'e_boda';
ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'e_bajaji';
ALTER TYPE vehicle_category ADD VALUE IF NOT EXISTS 'e_car';
