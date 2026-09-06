# Kwema Ride

Ride-hailing platform for the Tanzanian market — bodaboda, bajaji, standard
car and XL/Express, with mobile money collection, Swahili-first apps, and a
LATRA-shaped fare model.

Backend: NestJS + PostgreSQL/PostGIS + Redis + Socket.IO.
Mobile: Flutter (rider and driver).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design reasoning.

---

## Deploy to Railway

### 1. Push this repo to GitHub

```powershell
git init
git branch -M main
git add -A
git commit -m "Kwema Ride: initial platform"
git remote add origin https://github.com/<you>/kwema-ride.git
git push -u origin main
```

### 2. Create the Railway project

1. Railway → **New Project** → **Deploy from GitHub repo** → pick `kwema-ride`.
2. Railway reads `railway.json` and builds from the `Dockerfile`. No build
   configuration needed.

### 3. Add the databases — PostGIS template, NOT the default Postgres

**Do not use Railway's standard PostgreSQL plugin.** It ships the plain
Debian Postgres image with no PostGIS, and this schema is built on
`GEOGRAPHY` columns. Migration 001 will fail with
`type "geography" does not exist`.

Instead: **New** → **Template** → search **PostGIS** → deploy
`postgis/postgis` (PostgreSQL 16, PostGIS 3.4). Then **New** → **Database**
→ **Redis** for the cache.

The PostGIS template initialises with a self-signed certificate, which is why
the app sets `rejectUnauthorized: false` when `DATABASE_SSL=true`.

### 4. Set the service variables

On the API service → **Variables** → **Raw Editor**, paste:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DATABASE_SSL=true
NODE_ENV=production
JWT_ACCESS_SECRET=<openssl rand -base64 48>
OFFER_TOKEN_SECRET=<openssl rand -base64 48>
DEFAULT_AGGREGATOR=azampay
```

Do **not** set `PORT` — Railway injects it, and overriding it breaks the
healthcheck.

Add the AzamPay/Selcom and SMS credentials from `.env.example` when you have
sandbox keys. The app boots without them; payment initiation returns a
provider error until they are set.

### 5. Deploy

Railway builds, runs `node dist/db/migrate.js` (applying `001_schema.sql`
then `002_seed.sql`), then starts the API. Migrations run before the server
binds, so a failed migration leaves the previous deployment serving traffic.

### 6. Verify

```bash
curl https://<your-service>.up.railway.app/health
curl https://<your-service>.up.railway.app/api/health/ready
```

`/health` is liveness only and checks nothing — that is deliberate, so a
brief Redis blip cannot trigger a restart loop. `/api/health/ready` reports
Postgres, Redis and PostGIS individually.

### 7. Point the webhooks at it

In your aggregator dashboard, set the callback URL to:

```
https://<your-service>.up.railway.app/api/payments/webhook/azampay
https://<your-service>.up.railway.app/api/payments/webhook/selcom
```

Then restrict inbound traffic to those routes to the aggregator's published
IP ranges. The HMAC check is the primary control, but the allowlist is what
saves you when a secret leaks.

---

## Local development

```bash
docker compose up --build
```

Brings up PostGIS 16-3.4, Redis 7, and the API on `:3000` with migrations
applied. Without `SMS_API_URL` set, OTP codes print to the API log instead of
being sent — that is how you log in locally.

```bash
npm install
npm run start:dev     # watch mode against the compose database
npm run typecheck
npm run migrate
```

---

## API surface

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/auth/otp/request` | 3/min per IP |
| `POST` | `/api/auth/otp/verify` | Returns access + refresh tokens |
| `POST` | `/api/auth/refresh` | Rotating; reuse revokes the family |
| `POST` | `/api/auth/logout` | Denylists the access `jti` |
| `POST` | `/api/pricing/quote` | Locked quote, 180s TTL |
| `GET` | `/api/rides/active` | Reconnect/deep-link fallback |
| `GET` | `/api/rides/history` | Paginated |
| `POST` | `/api/rides/:id/cancel` | Applies the cancellation fee rules |
| `POST` | `/api/payments/collect` | Triggers the USSD/STK prompt, 5/min |
| `GET` | `/api/payments/status/:ref` | Poll fallback if the socket is down |
| `POST` | `/api/payments/webhook/:provider` | Signature-verified, idempotent |
| `GET` | `/health`, `/api/health/ready` | Liveness, readiness |

WebSocket namespace `/rt`, JWT in the handshake auth:

`driver:location_update` · `ride:request` · `ride:accept` · `ride:decline` ·
`ride:status_change` · `hb` — server emits `session:ready`,
`ride:driver_moved`, `ride:offer_closed`, `ride:fare_ready`,
`payment:status`.

---

## Mobile apps

`mobile/lib` holds the Flutter scaffolding: rider home, driver offer modal,
Swahili/English localization with TZS formatting, and the offline-first
location queue. These are the screens and services with real logic in them —
`main.dart`, routing, and the remaining screens still need writing, and
`pubspec.yaml` needs generating with `flutter create`.

Dependencies the existing files assume:

```yaml
flutter_riverpod: ^2.5.1
google_maps_flutter: ^2.9.0
geolocator: ^13.0.2
sqflite: ^2.4.1
socket_io_client: ^3.0.2
intl: ^0.19.0
```

---

## Before you go live

1. **Replace the tariffs.** Every rate in `db/002_seed.sql` is a placeholder
   marked `PLACEHOLDER`. Get the LATRA order in force, enter the real figures,
   and record the gazette reference on each row.
2. **Confirm the aggregator contract.** `mobile-money.providers.ts` is a
   correct integration skeleton, but AzamPay and Selcom change field names
   between API versions. Reconcile against your sandbox docs.
3. **Register the SMS sender ID with TCRA**, or OTPs will not deliver.
4. **Replace the seeded admin phone** in `002_seed.sql`.
5. **Set real service-zone polygons.** The ones seeded are rough bounding
   boxes for Dar es Salaam and JNIA.
6. **Add an IP allowlist** in front of the webhook routes.
