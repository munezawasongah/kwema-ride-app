# Railway deployment runbook

Everything needed to get Kwema Ride running on Railway, in order, with the
failure modes each step guards against.

---

## Services you need

Three services in one Railway project:

| Service | Source | Notes |
|---|---|---|
| `postgis` | **Template** → PostGIS | PostgreSQL 16 + PostGIS 3.4 |
| `redis` | **Database** → Redis | Geo index, locks, pub/sub |
| `kwema-api` | **GitHub repo** | Builds from `Dockerfile` |

### The PostGIS requirement is not optional

Railway's standard PostgreSQL plugin uses the plain Debian Postgres image
with no extensions compiled in. This schema is built on `GEOGRAPHY(Point,
4326)` columns and GiST spatial indexes. On the default plugin, migration 001
fails immediately with:

```
error: type "geography" does not exist
```

Deploy the **PostGIS** template instead (`postgis/postgis`, PostgreSQL 16,
PostGIS 3.4). Same connection variables, same `DATABASE_URL` reference
syntax — only the image differs.

---

## Variables

On `kwema-api` → **Variables** → **Raw Editor**:

```
DATABASE_URL=${{postgis.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DATABASE_SSL=true
NODE_ENV=production
JWT_ACCESS_SECRET=<paste 48 random bytes>
OFFER_TOKEN_SECRET=<paste 48 different random bytes>
DEFAULT_AGGREGATOR=azampay
```

The `${{postgis.DATABASE_URL}}` reference must match your PostGIS service's
actual name in the Railway sidebar. If you named it something else, change
the prefix or the reference resolves to nothing and the app exits with
`DATABASE_URL is not set`.

Generate the secrets:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
```

**Never set `PORT`.** Railway injects it. Overriding it means the app binds
one port while the healthcheck probes another, and every deploy fails
healthcheck and rolls back.

Add the aggregator and SMS credentials from `.env.example` once you have
sandbox keys. The app starts without them and logs a warning per missing
variable; payment collection returns a provider error until they're set.

---

## What happens on deploy

1. Railway reads `railway.json`, builds from `Dockerfile` (multi-stage, ends
   as a non-root `node:20-alpine` image).
2. Container starts: `node dist/db/migrate.js && node dist/main.js`.
3. `migrate.js` applies `001_schema.sql` then `002_seed.sql`, recording each
   in `_migrations` with a checksum. Already-applied files are skipped.
4. Env validation runs. A missing or placeholder secret exits 1 here, before
   anything binds.
5. API listens on `0.0.0.0:$PORT`. Railway's healthcheck hits `/health`.

A failed migration exits non-zero, so Railway keeps the previous deployment
serving traffic rather than promoting a broken build.

---

## Verify

```bash
curl https://<service>.up.railway.app/health
# {"status":"ok","service":"kwema-ride",...}

curl https://<service>.up.railway.app/api/health/ready
# {"status":"ready","checks":{"postgres":"ok","redis":"ok","postgis":"ok (3.4.x)"}}
```

If `postgis` reports `missing`, you're on the wrong database template.

Then confirm the seed landed:

```sql
SELECT category, base_fare_cents, per_km_cents, gazette_reference FROM tariffs;
SELECT code, name_en FROM service_zones;
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `type "geography" does not exist` | Default Postgres plugin | Redeploy on the PostGIS template |
| `DATABASE_URL is not set` | Service-name mismatch in the `${{...}}` reference | Match the reference to the sidebar name |
| `no pg_hba.conf entry ... no encryption` | `DATABASE_SSL=false` against an SSL-only server | Set `DATABASE_SSL=true` |
| `server does not support SSL` | `DATABASE_SSL=true` against a non-SSL server | Set `DATABASE_SSL=false` |
| Healthcheck fails, deploy rolls back | `PORT` set manually | Delete the `PORT` variable |
| `Refusing to start — N configuration problem(s)` | Missing/placeholder secret | Read the named variables in the log |
| Redis errors loop but app serves | Redis service not linked | Add the `REDIS_URL` reference |
| WebSocket connects then drops at 60s | Client not sending `hb` | Client must emit `hb` every 20s |
| Migration warns "has changed since applied" | An applied `.sql` file was edited | Add a new numbered migration instead |

---

## After the first successful deploy

1. **Generate a public domain**: Settings → Networking → Generate Domain.
   WebSockets work over it without extra configuration.
2. **Point the aggregator webhooks** at
   `https://<domain>/api/payments/webhook/azampay` and `/selcom`, then
   restrict those routes to the aggregator's published IP ranges.
3. **Replace the seeded tariffs.** Every rate in `002_seed.sql` is marked
   `PLACEHOLDER`. Enter the LATRA figures in force and record the gazette
   reference. Do this as a *new* migration file — never edit an applied one.
4. **Replace the seeded admin phone** `+255700000000`.
5. **Set `WS_ALLOWED_ORIGINS` and `CORS_ORIGINS`** once the admin panel has a
   domain. Until then they default open, which is fine for mobile clients but
   not something to leave in place.

## Scaling

Keep `numReplicas: 1` until you have real load. The architecture is
replica-safe — ride rooms go through the Socket.IO Redis adapter, offer locks
and driver responses live in Redis — but the breadcrumb buffer and WebSocket
throttle are per-node, so each replica adds a small independent flush batch
and its own rate-limit window. Neither is a correctness problem; both are
worth measuring before you scale out.
