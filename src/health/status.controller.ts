/**
 * Status page at `/`.
 *
 * A deployed API whose root returns 404 is indistinguishable from a broken
 * one, both to you and to anyone you send the link to. This serves a small
 * self-contained page that reports live dependency status and lists the API
 * surface, in the product's own colours.
 *
 * Deliberately dependency-free: no template engine, no static assets, no
 * build step. It is one string, so it cannot break a deploy.
 *
 * This is not the admin dashboard — that is a separate Next.js app. This is
 * a status page, and it exposes nothing an unauthenticated visitor should
 * not see: no counts, no records, no configuration values.
 */

import { Controller, Get, Header, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';

@Controller()
export class StatusController {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('status')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async index(): Promise<string> {
    const checks = await this.probe();
    return this.render(checks);
  }

  private async probe() {
    const result = {
      postgres: false,
      redis: false,
      postgis: '',
      tariffs: false,
      zones: false,
    };

    try {
      await this.db.query('SELECT 1');
      result.postgres = true;

      const [v] = await this.db.query('SELECT PostGIS_Version() AS v');
      result.postgis = v?.v ?? '';

      // Confirms migrations ran, without revealing the rates themselves.
      const [t] = await this.db.query(
        'SELECT COUNT(*)::int > 0 AS ok FROM tariffs WHERE valid_to IS NULL',
      );
      result.tariffs = Boolean(t?.ok);

      const [z] = await this.db.query(
        'SELECT COUNT(*)::int > 0 AS ok FROM service_zones WHERE is_active',
      );
      result.zones = Boolean(z?.ok);
    } catch {
      /* leave flags false — the page reports the failure */
    }

    try {
      await this.redis.ping();
      result.redis = true;
    } catch {
      /* same */
    }

    return result;
  }

  private render(c: Awaited<ReturnType<StatusController['probe']>>): string {
    const rows: Array<[string, boolean, string]> = [
      ['API', true, 'running'],
      ['PostgreSQL', c.postgres, c.postgres ? 'connected' : 'unreachable'],
      ['PostGIS', Boolean(c.postgis), c.postgis || 'not installed'],
      ['Redis', c.redis, c.redis ? 'connected' : 'unreachable'],
      ['Schema', c.tariffs && c.zones, c.tariffs && c.zones ? 'migrated' : 'incomplete'],
    ];

    const dot = (ok: boolean) =>
      `<span style="width:9px;height:9px;border-radius:50%;background:${
        ok ? '#1E7A4C' : '#C0392B'
      };display:inline-block;flex:none"></span>`;

    const statusRows = rows
      .map(
        ([label, ok, detail]) => `
      <div style="display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #E4DFD7">
        ${dot(ok)}
        <span style="flex:1;font-weight:600;color:#1C1A17">${label}</span>
        <span style="color:#6B665E;font-size:14px;text-align:right">${detail}</span>
      </div>`,
      )
      .join('');

    const endpoints = [
      ['POST', '/api/auth/otp/request'],
      ['POST', '/api/auth/otp/verify'],
      ['POST', '/api/pricing/quote'],
      ['GET', '/api/rides/active'],
      ['POST', '/api/payments/collect'],
      ['WS', '/rt'],
    ]
      .map(
        ([method, path]) => `
      <div style="display:flex;gap:10px;padding:7px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
        <span style="color:#3A4BB8;font-weight:600;min-width:42px">${method}</span>
        <span style="color:#433F39">${path}</span>
      </div>`,
      )
      .join('');

    const allOk = rows.every(([, ok]) => ok);

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/brand/favicon.ico" sizes="any">
<title>Kwema Ride — API status</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#FAF8F5;color:#1C1A17;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
       line-height:1.6;padding:24px 16px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:560px;margin:0 auto}
  .card{background:#fff;border:1px solid #E4DFD7;border-radius:16px;padding:22px;margin-bottom:16px}
  h1{font-size:26px;font-weight:700;letter-spacing:-.6px;color:#fff}
  h2{font-size:13px;font-weight:600;color:#6B665E;text-transform:uppercase;
     letter-spacing:.7px;margin-bottom:8px}
  a{color:#3A4BB8}
</style></head>
<body><div class="wrap">

  <div style="background:#3A4BB8;border-radius:16px;padding:24px;margin-bottom:16px">
    <h1>Kwema&nbsp;Ride</h1>
    <p style="color:#D5D9F5;font-size:14px;margin-top:4px">
      Ride-hailing platform API &middot; Tanzania
    </p>
    <div style="display:inline-flex;align-items:center;gap:8px;margin-top:14px;
                background:${allOk ? 'rgba(255,255,255,.14)' : '#C0392B'};
                border-radius:999px;padding:6px 14px">
      ${dot(allOk)}
      <span style="color:#fff;font-size:13px;font-weight:600">
        ${allOk ? 'All systems operational' : 'Degraded'}
      </span>
    </div>
  </div>

  <div class="card">
    <h2>Services</h2>
    ${statusRows}
    <p style="font-size:13px;color:#979187;margin-top:14px">
      Checked ${new Date().toISOString()}
    </p>
  </div>

  <div class="card">
    <h2>Endpoints</h2>
    ${endpoints}
    <p style="font-size:13px;color:#6B665E;margin-top:12px">
      All routes require authentication except the health checks.
      Machine-readable status:
      <a href="/api/health/ready">/api/health/ready</a>
    </p>
  </div>

  <div class="card" style="background:#FDF2DE;border-color:#F2C673">
    <h2 style="color:#8A5B0A">Before going live</h2>
    <p style="font-size:14px;color:#8A5B0A">
      Fare rates are placeholders pending the LATRA order in force, and
      mobile money credentials are not yet configured. This deployment
      cannot process real payments.
    </p>
  </div>

  <p style="text-align:center;font-size:13px;color:#979187;padding:8px 0 24px">
    The rider and driver apps are Flutter clients &mdash; this URL serves the API only.
  </p>

</div></body></html>`;
  }
}
