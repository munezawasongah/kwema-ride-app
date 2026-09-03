# Kwema Ride — Ride-hailing platform architecture (Tanzania)

A production architecture for a multi-tier ride-hailing service covering
bodaboda, bajaji, standard car and XL/Express across Tanzanian cities.

---

## 1. Market reality this design assumes

A few facts about the Tanzanian market drive most of the non-obvious
decisions in this codebase.

**LATRA regulates ride-hailing like transport, not like a marketplace.** It
sets guide fares per kilometre and per minute, a minimum fare, and ceilings on
what the operator may take. Those ceilings have moved: a March 2022 order cut
commission from around a third to 15% and removed the booking fee; a December
2022 gazette notice raised it to 25% and restored a small booking fee. Uber
withdrew from the market in early 2026 citing the framework. The engineering
consequence is that **no rate, cap or fee is a constant in this codebase** —
all of them live in the versioned `tariffs` table with a `gazette_reference`,
so a notice becomes a new row and every historic fare stays reproducible under
audit. Verify the values in force with LATRA before go-live.

**Cash is not a legacy payment method here.** It remains the dominant rail,
especially for boda and bajaji. That means the driver wallet, cash-commission
debt, and the dispatch cutoff for drivers who owe too much are core domain
objects, not an afterthought.

**Mobile money is the digital default.** M-Pesa, Mixx by Yas (Tigo Pesa),
Airtel Money and HaloPesa, reached through an aggregator — AzamPay or Selcom.
Both are supported behind one interface because one of them will be degraded
on any given evening.

**Connectivity is intermittent, not absent.** Drivers lose signal for minutes
at a time on the Morogoro road or under the Ubungo interchange. Every write
path from a device is idempotent and buffered locally.

---

## 2. Stack

| Layer | Choice | Why this over the alternative |
|---|---|---|
| Mobile | **Flutter** | One codebase, and the render-everything-yourself model gives consistent behaviour on the entry-level Android devices that dominate the driver fleet. React Native's bridge cost shows on a 60 fps map with live markers. |
| Backend | **NestJS (TypeScript)** | Structured DI and decorators keep a microservice fleet legible; the same language as the admin web app. Go is the better choice if you expect >5k concurrent drivers per node — the dispatch service is deliberately written so it can be ported alone. |
| Database | **PostgreSQL 16 + PostGIS 3.4** | `GEOGRAPHY` types give true-metre `ST_DWithin`/`ST_Distance` with no projection juggling, and the KNN `<->` operator on a GiST index is fast enough to be a credible dispatch fallback. |
| Cache / geo | **Redis 7** | `GEOSEARCH` for the dispatch hot path, pub/sub for the Socket.IO adapter, distributed locks for offer reservation, surge tiles. |
| Realtime | **Socket.IO + Redis adapter** | Automatic reconnection with backoff and a polling fallback for the proxies that still break WS upgrades. Raw WebSockets would mean reimplementing both. |
| Maps | **Google Maps** (primary), **Mapbox** (fallback) | Google's coverage of Dar's informal roads is better. Mapbox's offline tile packs are the answer for driver navigation in low-coverage corridors. |
| Queue | **BullMQ on Redis** | Breadcrumb persistence, receipts, payouts, reconciliation. |
| Admin web | **Next.js** | Server components for the ops dashboard; same TS types as the backend. |

---

## 3. Service topology

```
                      ┌──────────────┐
   Rider app ────────►│   API GW     │  JWT verify, rate limit, WAF
   Driver app ───────►│  (Kong/NGINX)│
   Admin web ────────►└──────┬───────┘
                             │
        ┌────────────┬───────┴───────┬──────────────┬─────────────┐
        ▼            ▼               ▼              ▼             ▼
   ┌─────────┐  ┌─────────┐   ┌────────────┐  ┌──────────┐  ┌──────────┐
   │  auth   │  │  rides  │   │  dispatch  │  │ payments │  │ pricing  │
   └────┬────┘  └────┬────┘   └─────┬──────┘  └────┬─────┘  └────┬─────┘
        │            │              │              │             │
        └────────────┴──────┬───────┴──────────────┴─────────────┘
                            ▼
              ┌─────────────────────────────┐
              │  PostgreSQL + PostGIS       │  (primary + read replica)
              │  Redis (geo, pub/sub, lock) │
              └─────────────────────────────┘
                            ▲
                 ┌──────────┴──────────┐
                 │  realtime gateway   │  Socket.IO, sticky-session-free
                 │  (horizontally      │  via the Redis adapter
                 │   scaled)           │
                 └─────────────────────┘
```

The realtime gateway is stateless. Ride rooms live in the Redis adapter, so a
rolling deploy drops sockets that immediately reconnect and re-join from the
`session:ready` snapshot rather than losing trip state.

---

## 4. Ride lifecycle

```
rider taps request
        │
        ▼
 quote (locked, 180s TTL) ──► ride row created (idempotent on client id)
        │
        ▼
 dispatch: GEOSEARCH ring 1 → hard filters → score → shortlist (top 5)
        │
        ▼
 sequential offers, 15s each, driver locked in Redis for the offer window
        │                                   │
   accepted                             all declined / timeout
        │                                   │
        ▼                                   ▼
 driver en route ──► arrived ──► in_progress ──► completed
                                                     │
                                                     ▼
                                       settlement fare (capped at
                                       quote + 20% tolerance)
                                                     │
                                       ┌─────────────┴─────────────┐
                                    cash                    mobile money
                                       │                           │
                          driver wallet debited          STK push → webhook
                          by commission                  → reconciliation job
```

**Why sequential and not broadcast.** Broadcasting to all nearby drivers gets
the fastest acceptance and the worst driver experience: four drivers accept,
three lose, and acceptance-rate metrics become meaningless. Sequential offers
with a Redis `SET NX` lock per driver make double-offer impossible, which is
the specific bug that erodes driver trust fastest.

---

## 5. Fare model

```
base + (km × per_km) + (min × per_min) + waiting + zone surcharge
  → × surge (capped by tariff.max_surge_multiplier)
  → floor at minimum_fare
  → + booking fee (bps, capped)
  → − promo (funded by operator, not the driver)
  → round to nearest 50 TZS
```

Two deliberate choices:

- **Surge is stepped, not continuous** (1.0 / 1.1 / 1.2 / 1.4 / 1.6). A smooth
  multiplier makes the displayed price flicker between taps, and a wide,
  fast-moving multiplier is a compliance risk under a regulated-fare regime.
- **Rounding to 50 TZS** because that is the smallest note a driver can
  practically give change for on a cash trip.

Commission is charged on the transport fare only, excluding the booking fee
and any pass-through surcharge, and is capped at the tariff's
`commission_bps_cap`. VAT (18%, verify against the Finance Act in force) is
computed on the operator's service fee, not on the driver's transport service.

---

## 6. Security

**Authentication.** Phone + OTP is the primary flow; passwords are optional
and hashed with Argon2id. Access tokens are 15-minute JWTs carrying `sub`,
`role`, `driverId`, `category` and a `jti`; refresh tokens are opaque,
rotated on use, and bound to a device fingerprint. Reuse of a rotated refresh
token revokes the whole family — that is the signal of a stolen token. The
`jti` denylist in Redis is checked on every WebSocket handshake so a logout or
ban takes effect on live sockets, not at the next token expiry.

**Authorisation.** Ride events are scoped to `ride:{id}` rooms a socket may
only join via a server-side membership check. A driver accepting a ride must
present the short-lived HMAC `offerToken` issued with the offer, which stops a
driver from claiming a ride id they were never offered.

**Rate limiting.** Per-user and per-IP at the gateway; per-socket in
`WsThrottleGuard` for location pings (20 per 10s); a hard 5-per-minute cap on
payment initiation, because each attempt pushes a USSD prompt to a real
handset.

**Mobile money payload signing.** Outbound requests are signed per aggregator
(AzamPay bearer token + API key; Selcom HMAC-SHA256 digest over an ordered
canonical string). Inbound webhooks are verified over the **raw request body**
— re-serialising parsed JSON changes bytes and breaks the signature, so
`bodyParser` captures `rawBody` via its `verify` hook. Verification is
timing-safe. Selcom callbacks additionally carry a timestamp bounded to five
minutes to cap replay. On top of the signature, the webhook path enforces:
an IP allowlist at ingress, idempotency on `external_reference` via `SET NX`,
a `SELECT ... FOR UPDATE` row lock, and an amount-match check against the
transaction we created. Signature-valid webhooks always return 200 even on
business failure — a non-2xx makes aggregators retry for hours.

**Secrets.** Never on the device. The mobile apps hold no aggregator
credentials, no maps server key, and no signing secret; every third-party call
is server-side. Maps client keys are restricted by bundle id and SHA-1.

**PII.** NIDA numbers are encrypted at rest at the application layer.
Breadcrumb data is partitioned by day and dropped after the retention window.
Driver phone numbers are masked to riders behind a voice proxy.

**Fraud controls worth building early in this market:** GPS mock detection on
the driver app, trips whose driven distance diverges implausibly from the
routed distance, accounts sharing a device fingerprint, and cash trips
completed with no plausible movement.

---

## 7. Low-bandwidth engineering

- Location pings use one-character keys and integer-scaled coordinates
  (×1e6). At one ping per driver per four seconds, the saved bytes are real
  money on a bundle-priced network.
- `perMessageDeflate` above a 256-byte threshold.
- Ping cadence adapts to movement: a stationary driver drops to a 30 m
  distance filter with a 45-second keepalive floor.
- The rider app renders a stale price at reduced opacity while re-quoting
  rather than showing a spinner in place of the number.
- Quotes are locked for 180 seconds, so a surge spike between tapping and
  confirming cannot raise the agreed price.
- The driver's offline buffer is bounded at 2,000 fixes and thins the oldest
  half by dropping alternate fixes, preserving route shape under long outages.

---

## 8. Files in this scaffold

| Path | What it is |
|---|---|
| `db/001_schema.sql` | Full PostGIS DDL, spatial indexes, `find_nearby_drivers()` KNN function, zone resolution, partitioned breadcrumbs |
| `src/dispatch/dispatch.service.ts` | Expanding-ring GEOSEARCH, hard filters, multi-factor scoring, locked sequential offers, PostGIS fallback |
| `src/realtime/realtime.gateway.ts` | Socket.IO gateway: handshake auth, room rejoin on reconnect, heartbeat + stale-socket reaping, out-of-order ping rejection |
| `src/pricing/fare.service.ts` | Quote, settlement with tolerance cap, cancellation fees, surge tiles, tariff resolution |
| `src/payments/mobile-money.providers.ts` | AzamPay + Selcom adapters, token caching with single-flight, webhook verification |
| `src/payments/payments.controller.ts` | Collection initiation, idempotent webhook handling, reconciliation sweep |
| `mobile/lib/features/rider/rider_home_screen.dart` | Map, category carousel, fare display, request button |
| `mobile/lib/features/driver/incoming_ride_modal.dart` | Offer modal with server-anchored countdown and double-tap latch |
| `mobile/lib/core/l10n/localization.dart` | Swahili-default localization, TZS formatting |
| `mobile/lib/core/location/offline_location_queue.dart` | SQLite-buffered, ack-driven location pipeline |

---

## 9. What is deliberately not here

Auth service, admin dashboard, driver onboarding and document-verification
workflow, ratings, promotions engine, payout batching to driver mobile money
wallets, and the LATRA reporting exports. The ride flow, dispatch, pricing and
payments are the parts where the domain decisions matter; the rest is
conventional CRUD once these are settled.

Before go-live, two things need external confirmation rather than code: the
current LATRA fare order and commission ceiling, and the exact request/response
contracts from whichever aggregator issues your sandbox credentials.
