/* Kwema Ride — admin panel.
 *
 * Vanilla JS on purpose: this is served from the API container itself, so a
 * build step would mean a second toolchain and a second thing to deploy for a
 * tool a handful of people use.
 *
 * Token lives in sessionStorage, not localStorage. This panel can move money
 * and put vehicles on the road; a token that survives the browser closing on
 * a shared office machine is not a risk worth taking for the convenience.
 */

(function () {
  const S = {
    token: sessionStorage.getItem('kwema_admin_token') || null,
    tab: 'overview',
    driverFilter: 'all',
    rideFilter: 'active',
    phone: null,
  };

  const app = document.getElementById('app');
  const tzs = (c) => 'TSh ' + Math.round((c || 0) / 100).toLocaleString('en-US');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  async function api(path, options = {}) {
    const res = await fetch('/api' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}),
      },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('kwema_admin_token');
      S.token = null;
      renderLogin('Session expired. Sign in again.');
      throw new Error('unauthorized');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Request failed');
    return body;
  }

  // =================================================================
  // Login
  // =================================================================
  function renderLogin(error) {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="logo" style="font-size:24px;margin-bottom:4px">Kwema</div>
        <p style="color:var(--muted);font-size:14px;margin-bottom:22px">Admin panel</p>
        ${error ? `<div class="msg-box m-err">${esc(error)}</div>` : ''}
        <label style="font-size:13px;font-weight:600;color:var(--muted)">Admin phone</label>
        <input id="phone" value="+255" style="width:100%;padding:13px;border:1px solid var(--line);border-radius:10px;font-size:16px;margin:6px 0 14px">
        <button class="btn btn-primary" id="send" style="width:100%">Send code</button>
        <p class="hint">The code is written to the Railway deploy log until an SMS gateway is connected.</p>
      </div>`;
    document.getElementById('send').onclick = async () => {
      const phone = document.getElementById('phone').value.replace(/\s/g, '');
      try {
        const out = await api('/auth/otp/request', {
          method: 'POST', body: JSON.stringify({ phone }),
        });
        if (out.sent === false) {
          return renderLogin(`A code was already sent. Wait ${out.retryAfter}s.`);
        }
        S.phone = phone;
        renderCode();
      } catch (e) { renderLogin(e.message); }
    };
  }

  function renderCode(error) {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="logo" style="font-size:24px;margin-bottom:4px">Kwema</div>
        <p style="color:var(--muted);font-size:14px;margin-bottom:22px">${esc(S.phone)}</p>
        ${error ? `<div class="msg-box m-err">${esc(error)}</div>` : ''}
        <input id="code" maxlength="6" inputmode="numeric"
          style="width:100%;padding:14px;border:1px solid var(--line);border-radius:10px;
                 font-size:24px;letter-spacing:10px;text-align:center;margin-bottom:14px">
        <button class="btn btn-primary" id="verify" style="width:100%">Verify</button>
        <button class="btn btn-ghost" id="back" style="width:100%;margin-top:8px">Back</button>
      </div>`;
    document.getElementById('back').onclick = () => renderLogin();
    document.getElementById('verify').onclick = async () => {
      try {
        const out = await api('/auth/otp/verify', {
          method: 'POST',
          body: JSON.stringify({
            phone: S.phone,
            code: document.getElementById('code').value.trim(),
            deviceId: 'admin-panel',
          }),
        });
        S.token = out.accessToken;
        sessionStorage.setItem('kwema_admin_token', out.accessToken);
        renderShell();
      } catch (e) { renderCode(e.message); }
    };
  }

  // =================================================================
  // Shell
  // =================================================================
  const TABS = [
    ['overview', 'Overview'],
    ['drivers', 'Drivers'],
    ['rides', 'Rides'],
    ['payouts', 'Payouts'],
    ['finance', 'Reconciliation'],
    ['tariffs', 'Tariffs'],
  ];

  function renderShell() {
    app.innerHTML = `
      <div class="admin-nav">
        <span class="brand">Kwema Admin</span>
        ${TABS.map(([id, label]) =>
          `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${label}</button>`).join('')}
        <div class="right">
          <button id="signout" style="border-bottom:none">Sign out</button>
        </div>
      </div>
      <div class="wrap-admin" id="content"><div class="empty">Loading…</div></div>`;

    app.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { S.tab = b.dataset.tab; renderShell(); };
    });
    document.getElementById('signout').onclick = () => {
      sessionStorage.removeItem('kwema_admin_token');
      S.token = null;
      renderLogin();
    };

    ({ overview: viewOverview, drivers: viewDrivers, rides: viewRides,
       payouts: viewPayouts, finance: viewFinance, tariffs: viewTariffs })[S.tab]();
  }

  const content = () => document.getElementById('content');
  const fail = (e) => { content().innerHTML = `<div class="msg-box m-err">${esc(e.message)}</div>`; };

  // =================================================================
  // Overview
  // =================================================================
  async function viewOverview() {
    try {
      const d = await api('/admin/overview');
      const f = d.fleet, t = d.today;
      content().innerHTML = `
        <div class="cards">
          <div class="stat"><div class="label">Trips today</div>
            <div class="value">${t.completed}</div>
            <div class="sub">${t.active} in progress</div></div>
          <div class="stat"><div class="label">Gross today</div>
            <div class="value">${tzs(t.grossCents)}</div>
            <div class="sub">commission ${tzs(t.commissionCents)}</div></div>
          <div class="stat ${t.unservedPercent > 20 ? 'warn' : ''}">
            <div class="label">Unserved requests</div>
            <div class="value">${t.unservedPercent}%</div>
            <div class="sub">${t.expired} found no driver</div></div>
          <div class="stat"><div class="label">Drivers online</div>
            <div class="value">${f.online}</div>
            <div class="sub">${f.idle} idle of ${f.drivers} total</div></div>
          <div class="stat ${f.pendingApproval ? 'warn' : ''}">
            <div class="label">Awaiting approval</div>
            <div class="value">${f.pendingApproval}</div>
            <div class="sub">cannot receive trips</div></div>
          <div class="stat"><div class="label">Owed to drivers</div>
            <div class="value pos">${tzs(f.payableCents)}</div>
            <div class="sub">next payout run</div></div>
          <div class="stat ${f.inDebt ? 'warn' : ''}">
            <div class="label">Owed by drivers</div>
            <div class="value neg">${tzs(f.receivableCents)}</div>
            <div class="sub">${f.inDebt} with cash debt</div></div>
          <div class="stat"><div class="label">Accounts</div>
            <div class="value">${d.users.total}</div></div>
        </div>
        ${t.unservedPercent > 20 ? `<div class="msg-box m-err">
          <strong>${t.unservedPercent}% of requests found no driver today.</strong>
          Riders who cannot get a trip stop opening the app. Supply is the
          constraint, not demand.</div>` : ''}`;
    } catch (e) { fail(e); }
  }

  // =================================================================
  // Drivers
  // =================================================================
  async function viewDrivers() {
    const filters = [['all', 'All'], ['pending', 'Awaiting approval'],
                     ['online', 'Online'], ['debt', 'In debt'],
                     ['expiring', 'Documents expiring']];
    content().innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Drivers</h2>
          <div class="filters">${filters.map(([id, l]) =>
            `<button data-f="${id}" class="${S.driverFilter === id ? 'on' : ''}">${l}</button>`).join('')}
          </div></div>
        <div id="dlist"><div class="empty">Loading…</div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Add a driver</h2></div>
        <div class="panel-body">
          <p style="color:var(--muted);font-size:14px;margin-bottom:16px">
            The person must sign up in the rider app with this number first —
            that way the number is verified before it is attached to a vehicle.</p>
          <div id="dmsg"></div>
          <form class="grid" id="dform">
            <div><label>Phone</label><input name="phone" value="+255" required></div>
            <div><label>Vehicle type</label><select name="category">
              <option value="boda">Bodaboda</option><option value="bajaji">Bajaji</option>
              <option value="standard" selected>Car</option><option value="xl">Car XL</option>
              <option value="express">Express</option></select></div>
            <div><label>Driving licence no.</label><input name="drivingLicenceNo" required></div>
            <div><label>Licence expiry</label><input name="drivingLicenceExpiry" type="date" required></div>
            <div><label>LATRA licence no.</label><input name="latraLicenceNo"></div>
            <div><label>LATRA expiry</label><input name="latraLicenceExpiry" type="date"></div>
            <div><label>Plate number</label><input name="plateNumber" placeholder="T123 ABC" required></div>
            <div><label>Make</label><input name="make" placeholder="Toyota" required></div>
            <div><label>Model</label><input name="model" placeholder="Vitz" required></div>
            <div><label>Colour</label><input name="colour" placeholder="White"></div>
            <div><label>Insurance policy no.</label><input name="insurancePolicyNo" required></div>
            <div><label>Insurance expiry</label><input name="insuranceExpiry" type="date" required></div>
          </form>
          <button class="btn btn-primary" id="dsave" style="margin-top:16px">Create driver</button>
        </div>
      </div>`;

    content().querySelectorAll('[data-f]').forEach((b) => {
      b.onclick = () => { S.driverFilter = b.dataset.f; viewDrivers(); };
    });
    document.getElementById('dsave').onclick = createDriver;
    loadDrivers();
  }

  async function loadDrivers() {
    try {
      const q = S.driverFilter === 'all' ? '' : '?filter=' + S.driverFilter;
      const rows = await api('/admin/drivers' + q);
      const box = document.getElementById('dlist');
      if (!rows.length) { box.innerHTML = '<div class="empty">No drivers match.</div>'; return; }

      const today = new Date().toISOString().slice(0, 10);
      box.innerHTML = `<table><thead><tr>
          <th>Driver</th><th>Vehicle</th><th>Status</th><th>Trips</th>
          <th>Rating</th><th>Balance</th><th>Documents</th><th></th>
        </tr></thead><tbody>${rows.map((d) => {
          const bal = Number(d.wallet_balance_cents);
          const expired = [d.driving_licence_expiry, d.insurance_expiry, d.latra_licence_expiry]
            .filter(Boolean).some((x) => x < today);
          return `<tr>
            <td><strong>${esc(d.full_name)}</strong><br>
              <span style="color:var(--muted);font-size:13px">${esc(d.phone)}</span></td>
            <td>${d.plate_number ? esc(d.plate_number) + '<br><span style="color:var(--muted);font-size:13px">' +
                 esc(d.make || '') + ' ' + esc(d.model || '') + '</span>' :
                 '<span class="pill p-bad">no vehicle</span>'}</td>
            <td>${d.compliance_verified_at
                  ? `<span class="pill ${d.state === 'offline' ? 'p-mute' : 'p-ok'}">${esc(d.state)}</span>`
                  : '<span class="pill p-warn">unapproved</span>'}</td>
            <td>${d.completed_trips}</td>
            <td>${Number(d.rating_avg).toFixed(2)} <span style="color:var(--muted)">(${d.rating_count})</span></td>
            <td class="money ${bal > 0 ? 'pos' : bal < 0 ? 'neg' : ''}">${tzs(bal)}</td>
            <td>${expired ? '<span class="pill p-bad">expired</span>' : '<span class="pill p-ok">valid</span>'}</td>
            <td>${d.compliance_verified_at
                  ? `<button class="btn-sm btn-stop" data-suspend="${d.id}">Suspend</button>`
                  : `<button class="btn-sm btn-go" data-verify="${d.id}">Approve</button>`}</td>
          </tr>`; }).join('')}</tbody></table>`;

      box.querySelectorAll('[data-verify]').forEach((b) => {
        b.onclick = async () => {
          try { await api(`/admin/drivers/${b.dataset.verify}/verify`, { method: 'POST' }); loadDrivers(); }
          catch (e) { alert(e.message); }
        };
      });
      box.querySelectorAll('[data-suspend]').forEach((b) => {
        b.onclick = async () => {
          const reason = prompt('Reason for suspension:');
          if (!reason) return;
          try {
            await api(`/admin/drivers/${b.dataset.suspend}/suspend`, {
              method: 'POST', body: JSON.stringify({ reason }),
            });
            loadDrivers();
          } catch (e) { alert(e.message); }
        };
      });
    } catch (e) { fail(e); }
  }

  async function createDriver() {
    const form = document.getElementById('dform');
    const data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach((k) => { if (data[k] === '') delete data[k]; });
    const msg = document.getElementById('dmsg');
    try {
      const out = await api('/admin/drivers', { method: 'POST', body: JSON.stringify(data) });
      msg.innerHTML = `<div class="msg-box m-ok">Created for ${esc(out.name)}.
        Approve them in the list above before they can receive trips.</div>`;
      form.reset();
      loadDrivers();
    } catch (e) {
      msg.innerHTML = `<div class="msg-box m-err">${esc(e.message)}</div>`;
    }
  }

  // =================================================================
  // Rides
  // =================================================================
  async function viewRides() {
    const filters = [['active', 'Active'], ['completed', 'Completed'],
                     ['expired', 'No driver found'], ['all', 'All']];
    content().innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>Rides</h2>
          <div class="filters">${filters.map(([id, l]) =>
            `<button data-f="${id}" class="${S.rideFilter === id ? 'on' : ''}">${l}</button>`).join('')}
          </div></div>
        <div id="rlist"><div class="empty">Loading…</div></div>
      </div>`;
    content().querySelectorAll('[data-f]').forEach((b) => {
      b.onclick = () => { S.rideFilter = b.dataset.f; viewRides(); };
    });
    try {
      const rows = await api('/admin/rides?status=' + S.rideFilter);
      const box = document.getElementById('rlist');
      if (!rows.length) { box.innerHTML = '<div class="empty">No rides.</div>'; return; }
      box.innerHTML = `<table><thead><tr>
        <th>Ref</th><th>When</th><th>Rider</th><th>Driver</th><th>Route</th>
        <th>Type</th><th>Fare</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><code>${esc(r.reference)}</code></td>
          <td style="font-size:13px">${new Date(r.requested_at).toLocaleString('en-GB')}</td>
          <td>${esc(r.rider_name)}</td>
          <td>${r.driver_name ? esc(r.driver_name) : '<span style="color:var(--muted)">—</span>'}</td>
          <td style="font-size:13px;max-width:230px">${esc(r.pickup_address || '?')} →
              ${esc(r.dropoff_address || '?')}</td>
          <td>${esc(r.requested_category)}</td>
          <td class="money">${tzs(r.final_fare_cents ?? r.quoted_fare_cents)}</td>
          <td>${esc(r.payment_method)}${r.is_paid ? ' <span class="pill p-ok">paid</span>' : ''}</td>
          <td><span class="pill ${r.status === 'completed' ? 'p-ok' :
              r.status === 'expired' || r.status.startsWith('cancelled') ? 'p-bad' : 'p-warn'}">
              ${esc(r.status)}</span></td>
        </tr>`).join('')}</tbody></table>`;
    } catch (e) { fail(e); }
  }

  // =================================================================
  // Payouts
  // =================================================================
  async function viewPayouts() {
    content().innerHTML = `
      <div class="msg-box m-ok" style="background:var(--tz-50);color:var(--tz-700)">
        <strong>Run reconciliation before paying out.</strong>
        A variance there means a trip completed without its payment being
        accounted for, and paying on top of that compounds the error.</div>
      <div class="panel"><div class="panel-head"><h2>Owed to drivers</h2>
        <span style="color:var(--muted);font-size:13px">minimum 5,000 TSh</span></div>
        <div id="plist"><div class="empty">Loading…</div></div></div>
      <div class="panel"><div class="panel-head"><h2>Owed by drivers (cash commission)</h2></div>
        <div id="dblist"><div class="empty">Loading…</div></div></div>`;
    try {
      const [pay, debt] = await Promise.all([api('/admin/payouts'), api('/admin/debtors')]);

      const pbox = document.getElementById('plist');
      pbox.innerHTML = !pay.length
        ? '<div class="empty">Nothing to pay out.</div>'
        : `<table><thead><tr><th>Driver</th><th>Phone</th><th>Trips</th>
             <th>Amount owed</th><th></th></tr></thead><tbody>${pay.map((d) => `<tr>
             <td><strong>${esc(d.full_name)}</strong></td><td>${esc(d.phone)}</td>
             <td>${d.completed_trips}</td>
             <td class="money pos">${tzs(d.wallet_balance_cents)}</td>
             <td><button class="btn-sm btn-tz" data-pay="${d.driver_id}"
                  data-amt="${d.wallet_balance_cents}" data-name="${esc(d.full_name)}">
                  Record payout</button></td></tr>`).join('')}</tbody></table>`;

      pbox.querySelectorAll('[data-pay]').forEach((b) => {
        b.onclick = async () => {
          const full = Number(b.dataset.amt);
          const input = prompt(
            `Amount to pay ${b.dataset.name} (TSh). Full balance is ${Math.round(full / 100)}.`,
            String(Math.round(full / 100)));
          if (!input) return;
          const cents = Math.round(Number(input) * 100);
          if (!cents || cents <= 0) return alert('Invalid amount');
          try {
            const out = await api('/admin/payouts', {
              method: 'POST',
              body: JSON.stringify({ driverId: b.dataset.pay, amountCents: cents }),
            });
            alert(`Recorded ${out.reference}. Balance now ${Math.round(out.balanceAfterCents / 100)} TSh.\n\nSend the money via mobile money separately — this records the obligation, it does not transfer funds.`);
            viewPayouts();
          } catch (e) { alert(e.message); }
        };
      });

      document.getElementById('dblist').innerHTML = !debt.length
        ? '<div class="empty">No outstanding driver debt.</div>'
        : `<table><thead><tr><th>Driver</th><th>Phone</th><th>Debt</th>
             <th>Ceiling</th><th>Status</th></tr></thead><tbody>${debt.map((d) => `<tr>
             <td><strong>${esc(d.full_name)}</strong></td><td>${esc(d.phone)}</td>
             <td class="money neg">${tzs(d.debt_cents)}</td>
             <td class="money">${tzs(d.debt_ceiling_cents)}</td>
             <td>${d.is_blocked ? '<span class="pill p-bad">blocked</span>'
                                : '<span class="pill p-warn">accruing</span>'}</td>
             </tr>`).join('')}</tbody></table>`;
    } catch (e) { fail(e); }
  }

  // =================================================================
  // Reconciliation
  // =================================================================
  async function viewFinance() {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    content().innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Rides versus money collected</h2></div>
        <div class="panel-body">
          <form class="grid" style="max-width:520px">
            <div><label>From</label><input type="date" id="from" value="${weekAgo}"></div>
            <div><label>To</label><input type="date" id="to" value="${today}"></div>
          </form>
          <button class="btn btn-primary" id="run" style="margin-top:14px">Run</button>
          <div id="rec" style="margin-top:20px"></div>
        </div></div>`;
    document.getElementById('run').onclick = async () => {
      try {
        const d = await api(`/admin/reconcile?from=${document.getElementById('from').value}` +
                            `&to=${document.getElementById('to').value}`);
        const clean = d.varianceCents === 0;
        document.getElementById('rec').innerHTML = `
          <div class="cards">
            <div class="stat"><div class="label">Completed rides</div>
              <div class="value">${d.completedRides}</div></div>
            <div class="stat"><div class="label">Rides total</div>
              <div class="value">${tzs(d.ridesTotalCents)}</div></div>
            <div class="stat"><div class="label">Collected</div>
              <div class="value">${tzs(d.collectedTotalCents)}</div>
              <div class="sub">${d.transactions} transactions</div></div>
            <div class="stat ${clean ? '' : 'warn'}"><div class="label">Variance</div>
              <div class="value">${tzs(d.varianceCents)}</div>
              <div class="sub">${d.unpaidRides} unpaid rides</div></div>
          </div>
          ${clean ? '<div class="msg-box m-ok">Balanced. Safe to pay out.</div>'
                  : `<div class="msg-box m-err"><strong>${tzs(d.varianceCents)} unaccounted.</strong>
                     Cash trips the driver never confirmed are the usual cause —
                     the fare was charged but no transaction recorded. Investigate
                     before the payout run.</div>`}`;
      } catch (e) { fail(e); }
    };
  }

  // =================================================================
  // Tariffs
  // =================================================================
  async function viewTariffs() {
    try {
      const rows = await api('/admin/tariffs');
      const placeholders = rows.filter((t) =>
        (t.gazette_reference || '').includes('PLACEHOLDER')).length;

      content().innerHTML = `
        ${placeholders ? `<div class="msg-box m-err">
          <strong>${placeholders} rate cards are still placeholders.</strong>
          They are structurally correct but the figures are invented. Replace
          them with the LATRA order in force before taking real fares.</div>` : ''}
        <div class="panel"><div class="panel-head"><h2>Live rate cards</h2></div>
          <table><thead><tr><th>Zone</th><th>Type</th><th>Base</th><th>Per km</th>
            <th>Per min</th><th>Minimum</th><th>Commission</th><th>Max surge</th>
            <th>Gazette</th></tr></thead><tbody>
            ${rows.map((t) => `<tr>
              <td>${t.zone_code ? esc(t.zone_code) : '<span style="color:var(--muted)">national</span>'}</td>
              <td><strong>${esc(t.category)}</strong></td>
              <td class="money">${tzs(t.base_fare_cents)}</td>
              <td class="money">${tzs(t.per_km_cents)}</td>
              <td class="money">${tzs(t.per_minute_cents)}</td>
              <td class="money">${tzs(t.minimum_fare_cents)}</td>
              <td>${(t.commission_bps_cap / 100).toFixed(1)}%</td>
              <td>×${Number(t.max_surge_multiplier).toFixed(2)}</td>
              <td style="font-size:12px;max-width:200px">${
                (t.gazette_reference || '').includes('PLACEHOLDER')
                  ? '<span class="pill p-bad">placeholder</span>'
                  : esc(t.gazette_reference || '—')}</td>
            </tr>`).join('')}</tbody></table></div>

        <div class="panel"><div class="panel-head"><h2>Publish a new rate card</h2></div>
          <div class="panel-body">
            <p style="color:var(--muted);font-size:14px;margin-bottom:16px">
              Publishing closes the current card and starts a new one. The old
              rates are kept, so any past fare can still be reproduced from the
              card that was in force — which is what an audit or a rider
              dispute actually asks for. Amounts are in TSh.</p>
            <div id="tmsg"></div>
            <form class="grid" id="tform">
              <div><label>Vehicle type</label><select name="category">
                <option value="boda">Bodaboda</option><option value="bajaji">Bajaji</option>
                <option value="standard">Car</option><option value="xl">Car XL</option>
                <option value="express">Express</option></select></div>
              <div><label>Base fare</label><input name="baseFare" type="number" required></div>
              <div><label>Per km</label><input name="perKm" type="number" required></div>
              <div><label>Per minute</label><input name="perMinute" type="number" required></div>
              <div><label>Minimum fare</label><input name="minimumFare" type="number" required></div>
              <div><label>Cancellation fee</label><input name="cancellationFee" type="number" value="0"></div>
              <div><label>Waiting per minute</label><input name="waiting" type="number" value="0"></div>
              <div><label>Commission %</label><input name="commissionPct" type="number" step="0.1" required></div>
              <div><label>Booking fee %</label><input name="bookingPct" type="number" step="0.1" value="0"></div>
              <div><label>Max surge</label><input name="maxSurge" type="number" step="0.1" value="1.6"></div>
              <div style="grid-column:1/-1"><label>Gazette reference (required)</label>
                <input name="gazetteReference" placeholder="GN 1234 / 01-01-2026" required></div>
            </form>
            <button class="btn btn-primary" id="tsave" style="margin-top:16px">Publish</button>
          </div></div>`;

      document.getElementById('tsave').onclick = async () => {
        const f = Object.fromEntries(new FormData(document.getElementById('tform')).entries());
        const body = {
          category: f.category,
          baseFareCents: Math.round(Number(f.baseFare) * 100),
          perKmCents: Math.round(Number(f.perKm) * 100),
          perMinuteCents: Math.round(Number(f.perMinute) * 100),
          minimumFareCents: Math.round(Number(f.minimumFare) * 100),
          cancellationFeeCents: Math.round(Number(f.cancellationFee || 0) * 100),
          waitingPerMinuteCents: Math.round(Number(f.waiting || 0) * 100),
          commissionBps: Math.round(Number(f.commissionPct) * 100),
          bookingFeeBps: Math.round(Number(f.bookingPct || 0) * 100),
          maxSurge: Number(f.maxSurge),
          gazetteReference: f.gazetteReference,
        };
        try {
          await api('/admin/tariffs', { method: 'POST', body: JSON.stringify(body) });
          viewTariffs();
        } catch (e) {
          document.getElementById('tmsg').innerHTML =
            `<div class="msg-box m-err">${esc(e.message)}</div>`;
        }
      };
    } catch (e) { fail(e); }
  }

  // =================================================================
  if (S.token) renderShell(); else renderLogin();
})();
