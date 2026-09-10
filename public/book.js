/* Kwema Ride — web booking client.
 *
 * Talks to the same API and WebSocket the mobile apps use. Nothing here is a
 * web-only code path: the quote is the same locked quote, dispatch is the
 * same sequential offer loop, and payment goes through the same providers.
 *
 * Token handling: the access token lives in sessionStorage rather than
 * localStorage, so it dies with the tab. On a shared or internet-cafe PC —
 * still a common way to get online here — a token that survives the browser
 * closing is a real account-takeover risk. The refresh token is deliberately
 * not stored at all on web; a returning visitor logs in again by OTP, which
 * costs one SMS and removes a whole class of exposure.
 */

(function () {
  const API = '';
  let state = {
    token: sessionStorage.getItem('kwema_token') || null,
    pickup: null,
    dropoff: null,
    quotes: [],
    selected: null,
    payment: 'mobile_money',
    ride: null,
    socket: null,
    map: null,
    markers: {},
    sessionToken: Math.random().toString(36).slice(2),
    service: 'ride',
    delivery: null,
    config: {},
  };

  const panel = document.getElementById('panel');
  const T = (k) => kwemaT(k);

  // =================================================================
  // API helper
  // =================================================================
  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('kwema_token');
      state.token = null;
      renderLogin();
      throw new Error('unauthorized');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'request_failed');
    return body;
  }

  function msg(text, kind) {
    return '<div class="msg msg-' + (kind || 'info') + '">' + text + '</div>';
  }

  // =================================================================
  // Login
  // =================================================================
  /** The emergency button follows the session, not the screen. */
  function toggleTopSos(visible) {
    const el = document.getElementById('sos-top');
    if (el) el.hidden = !visible;
  }

  function renderLogin(error, keepPhone) {
    toggleTopSos(false);
    panel.innerHTML =
      '<h2 style="font-size:22px;font-weight:800;margin-bottom:6px">' +
        (kwemaLang() === 'fr' ? 'Connexion' : kwemaLang() === 'en' ? 'Sign in' : 'Ingia') + '</h2>' +
      '<p style="color:var(--muted);font-size:14px;margin-bottom:20px">' +
        (kwemaLang() === 'fr' ? 'Nous enverrons un code par SMS.'
         : kwemaLang() === 'en' ? 'We will send a code by SMS.'
         : 'Tutakutumia msimbo kwa SMS.') + '</p>' +
      (error ? msg(error, 'err') : '') +
      '<label>' + (kwemaLang() === 'fr' ? 'Numéro de téléphone' : kwemaLang() === 'en' ? 'Phone number' : 'Namba ya simu') + '</label>' +
      '<div class="field"><input id="phone" value="' + (keepPhone || '+255') +
        '" inputmode="tel"></div>' +
      '<button class="btn btn-primary" style="width:100%" id="send">' +
        (kwemaLang() === 'fr' ? 'Envoyer le code' : kwemaLang() === 'en' ? 'Send code' : 'Tuma msimbo') +
      '</button>';

    document.getElementById('send').addEventListener('click', async () => {
      const phone = document.getElementById('phone').value.replace(/\s/g, '');
      if (!/^\+255[0-9]{9}$/.test(phone)) {
        return renderLogin(kwemaLang() === 'fr' ? 'Format : +255XXXXXXXXX'
          : kwemaLang() === 'en' ? 'Use the format +255XXXXXXXXX'
          : 'Tumia muundo +255XXXXXXXXX');
      }
      try {
        const out = await api('/api/auth/otp/request', {
          method: 'POST', body: JSON.stringify({ phone }),
        });

        // The endpoint returns 201 with sent:false when the 60s resend
        // cooldown is still running. Advancing to the code screen anyway —
        // which an earlier version did — showed a code prompt for an SMS
        // that was never sent, with nothing explaining why.
        if (out && out.sent === false) {
          const wait = out.retryAfter || 60;
          return renderLogin(
            kwemaLang() === 'fr'
              ? 'Un code a déjà été envoyé. Réessayez dans ' + wait + ' s.'
              : kwemaLang() === 'en'
              ? 'A code was already sent. Try again in ' + wait + 's.'
              : 'Msimbo tayari umetumwa. Jaribu tena baada ya sekunde ' + wait + '.',
            phone,
          );
        }
        renderOtp(phone);
      } catch (e) {
        renderLogin(e.message, phone);
      }
    });
  }

  function renderOtp(phone, error) {
    toggleTopSos(false);
    panel.innerHTML =
      '<h2 style="font-size:22px;font-weight:800;margin-bottom:6px">' +
        (kwemaLang() === 'fr' ? 'Code de vérification' : kwemaLang() === 'en' ? 'Verification code' : 'Msimbo') + '</h2>' +
      '<p style="color:var(--muted);font-size:14px;margin-bottom:20px">' + phone + '</p>' +
      (error ? msg(error, 'err') : '') +
      '<div class="field"><input id="code" inputmode="numeric" maxlength="6" ' +
        'style="letter-spacing:8px;font-size:22px;text-align:center;padding-left:15px"></div>' +
      '<button class="btn btn-primary" style="width:100%" id="verify">' +
        (kwemaLang() === 'fr' ? 'Vérifier' : kwemaLang() === 'en' ? 'Verify' : 'Thibitisha') + '</button>' +
      '<button class="btn btn-ghost" style="width:100%;margin-top:8px" id="back">' +
        (kwemaLang() === 'fr' ? 'Retour' : kwemaLang() === 'en' ? 'Back' : 'Rudi') + '</button>';

    document.getElementById('back').addEventListener('click', () => renderLogin());
    document.getElementById('verify').addEventListener('click', async () => {
      const code = document.getElementById('code').value.trim();
      try {
        const out = await api('/api/auth/otp/verify', {
          method: 'POST',
          body: JSON.stringify({ phone, code, deviceId: 'web-' + state.sessionToken }),
        });
        state.token = out.accessToken;
        sessionStorage.setItem('kwema_token', out.accessToken);
        renderBooking();
      } catch (e) {
        renderOtp(phone, e.message);
      }
    });
  }

  // =================================================================
  // Booking
  // =================================================================
  function renderBooking(error) {
    toggleTopSos(true);
    const params = new URLSearchParams(location.search);
    const svcLabel = { ride: T('service.ride'), parcel: T('service.parcel'), food: T('service.food') };

    panel.innerHTML =
      '<div class="svc-tabs">' +
        ['ride', 'parcel', 'food'].map((s) =>
          `<button data-svc="${s}" class="${state.service === s ? 'on' : ''}">${svcLabel[s]}</button>`
        ).join('') +
      '</div>' +
      '<h2 style="font-size:20px;font-weight:800;margin:14px 0 16px">' + T('book.title') + '</h2>' +
      (error ? msg(error, 'err') : '') +
      '<div class="field"><span class="dot dot-from"></span>' +
        '<input id="from" placeholder="' + T('book.from') + '" autocomplete="off" value="' +
        (params.get('from') || '') + '"><div class="suggestions" id="from-sug" hidden></div></div>' +
      '<div class="field"><span class="dot dot-to"></span>' +
        '<input id="to" placeholder="' + T('book.to') + '" autocomplete="off" value="' +
        (params.get('to') || '') + '"><div class="suggestions" id="to-sug" hidden></div></div>' +
      (state.service !== 'ride'
        ? '<div class="recip">' +
            '<label>' + T('delivery.what') + '</label>' +
            '<input id="d-what" placeholder="' + T('delivery.what_hint') + '">' +
            '<label>' + T('delivery.recipient_name') + '</label>' +
            '<input id="d-name">' +
            '<label>' + T('delivery.recipient_phone') + '</label>' +
            '<input id="d-phone" value="+255">' +
            '<label>' + T('delivery.size') + '</label>' +
            '<select id="d-size">' +
              '<option value="small">' + T('delivery.size_small') + '</option>' +
              '<option value="medium">' + T('delivery.size_medium') + '</option>' +
              '<option value="large">' + T('delivery.size_large') + '</option>' +
            '</select>' +
          '</div>'
        : '') +
      '<button class="btn btn-primary" style="width:100%;margin-top:4px" id="quote">' +
        T('book.go') + '</button>' +
      '<div id="results" style="margin-top:20px"></div>';

    wireSearch('from', (p, label) => { state.pickup = p; setMarker('pickup', p, label); });
    wireSearch('to', (p, label) => { state.dropoff = p; setMarker('dropoff', p, label); });
    document.getElementById('quote').addEventListener('click', getQuotes);

    document.querySelectorAll('[data-svc]').forEach((b) => {
      b.addEventListener('click', () => {
        state.service = b.dataset.svc;
        state.quotes = [];
        state.delivery = null;
        renderBooking();
      });
    });

    useBrowserLocation();
  }

  /** Place autocomplete through our server proxy — the Maps key stays server-side. */
  function wireSearch(id, onPick) {
    const input = document.getElementById(id);
    const box = document.getElementById(id + '-sug');
    let timer;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const value = input.value.trim();
      if (value.length < 2) { box.hidden = true; return; }
      // Debounced: Google bills autocomplete, and a fast typist generates a
      // request per keystroke otherwise.
      timer = setTimeout(async () => {
        try {
          const list = await api('/api/maps/autocomplete', {
            method: 'POST',
            body: JSON.stringify({
              input: value,
              sessionToken: state.sessionToken,
              language: kwemaLang(),
              ...(state.pickup ? { lat: state.pickup.lat, lng: state.pickup.lng } : {}),
            }),
          });
          if (!list.length) {
            box.innerHTML = '<div style="color:var(--muted);cursor:default">' +
              (kwemaLang() === 'fr' ? 'Aucun résultat'
               : kwemaLang() === 'en' ? 'No results'
               : 'Hakuna matokeo') + '</div>';
            box.hidden = false;
            return;
          }
          box.innerHTML = list.map((s) =>
            '<div data-id="' + s.placeId + '"><strong>' + s.primary + '</strong>' +
            '<small>' + s.secondary + '</small></div>').join('');
          box.hidden = false;
          box.querySelectorAll('div[data-id]').forEach((row) => {
            row.addEventListener('click', async () => {
              input.value = row.querySelector('strong').textContent;
              box.hidden = true;
              const detail = await api('/api/maps/place?placeId=' + row.dataset.id +
                '&sessionToken=' + state.sessionToken);
              if (detail && detail.point) onPick(detail.point, input.value);
            });
          });
        } catch (err) {
          // Silently hiding the box made a failing Places key look identical
          // to "no results", which is what made this hard to diagnose.
          box.innerHTML = '<div style="color:var(--stop);cursor:default">' +
            (kwemaLang() === 'fr' ? 'Recherche indisponible'
             : kwemaLang() === 'en' ? 'Search unavailable'
             : 'Utafutaji haupatikani') + '</div>';
          box.hidden = false;
        }
      }, 350);
    });

    document.addEventListener('click', (e) => {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
  }

  async function getQuotes() {
    if (!state.pickup || !state.dropoff) {
      return renderBooking(kwemaLang() === 'fr' ? 'Choisissez un départ et une destination.'
        : kwemaLang() === 'en' ? 'Choose a pickup and destination.'
        : 'Chagua mahali pa kuanzia na unakoenda.');
    }
    const results = document.getElementById('results');
    results.innerHTML = '<div class="status-box"><div class="spinner"></div></div>';

    try {
      const out = await api('/api/pricing/quote', {
        method: 'POST',
        body: JSON.stringify({
          serviceType: state.service,
          pickupLat: state.pickup.lat, pickupLng: state.pickup.lng,
          dropoffLat: state.dropoff.lat, dropoffLng: state.dropoff.lng,
        }),
      });
      state.quotes = out.quotes;
      state.selected = out.quotes.find((q) => q.category === 'standard') || out.quotes[0];
      renderQuotes();
      drawRoute(state.selected.polyline);
    } catch (e) {
      results.innerHTML = msg(e.message, 'err');
    }
  }

  const CAT_COLOUR = { boda: '#D9722B', bajaji: '#C9A227', standard: '#3A4BB8',
    xl: '#2E7D74', express: '#30409B' };
  const CAT_NAME = {
    sw: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Gari', xl: 'Gari Kubwa', express: 'Express' },
    en: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Car', xl: 'Car XL', express: 'Express' },
    fr: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Voiture', xl: 'Voiture XL', express: 'Express' },
  };

  function renderQuotes() {
    const lang = kwemaLang();
    const anyEstimate = state.quotes.some((q) => q.isEstimate);

    document.getElementById('results').innerHTML =
      (anyEstimate ? msg(lang === 'fr' ? 'Tarifs approximatifs — routage indisponible.'
        : lang === 'en' ? 'Approximate prices — routing unavailable.'
        : 'Bei za makadirio — ramani haipatikani.', 'info') : '') +
      state.quotes.map((q) =>
        '<div class="cat' + (state.selected && q.category === state.selected.category ? ' on' : '') +
          '" data-cat="' + q.category + '">' +
          '<div class="bar" style="background:' + CAT_COLOUR[q.category] + '"></div>' +
          '<div><div class="nm">' + CAT_NAME[lang][q.category] + '</div>' +
          '<div class="mt">' + Math.ceil(q.durationSeconds / 60) + ' min · ' +
            (q.distanceMetres / 1000).toFixed(1) + ' km</div></div>' +
          '<div class="pr"><strong>' + kwemaTzs(q.fare.totalFareCents) + '</strong>' +
          (q.fare.surgeMultiplier > 1
            ? '<span style="font-size:12px;color:var(--mg-600)">×' +
              q.fare.surgeMultiplier.toFixed(1) + '</span>' : '') +
          '</div></div>').join('') +
      '<label style="margin-top:18px">' +
        (lang === 'fr' ? 'Paiement' : lang === 'en' ? 'Payment' : 'Malipo') + '</label>' +
      '<div class="pm">' +
        '<button data-pm="mobile_money" class="on">' + T('pay.mm.t') + '</button>' +
        '<button data-pm="card">' + T('pay.card.t') + '</button>' +
        '<button data-pm="cash">' + T('pay.cash.t') + '</button>' +
      '</div>' +
      '<div id="mno-wrap"><label>' + T('pay.mm.t') + '</label>' +
        '<select id="mno">' +
        '<option value="mpesa">M-Pesa (Vodacom)</option>' +
        '<option value="tigopesa">Mixx by Yas (Tigo)</option>' +
        '<option value="airtelmoney">Airtel Money</option>' +
        '<option value="halopesa">HaloPesa</option>' +
        '</select></div>' +
      '<button class="btn btn-primary" style="width:100%;margin-top:16px" id="request">' +
        (lang === 'fr' ? 'Commander' : lang === 'en' ? 'Request ride' : 'Omba safari') + '</button>';

    document.querySelectorAll('.cat').forEach((el) => {
      el.addEventListener('click', () => {
        state.selected = state.quotes.find((q) => q.category === el.dataset.cat);
        renderQuotes();
        drawRoute(state.selected.polyline);
      });
    });
    document.querySelectorAll('.pm button').forEach((b) => {
      b.addEventListener('click', () => {
        state.payment = b.dataset.pm;
        document.querySelectorAll('.pm button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        document.getElementById('mno-wrap').style.display =
          state.payment === 'mobile_money' ? 'block' : 'none';
      });
    });
    document.getElementById('request').addEventListener('click', requestRide);
  }

  // =================================================================
  // Request + live tracking
  // =================================================================
  function readDelivery() {
    const el = (id) => document.getElementById(id);
    if (!el('d-name')) return null;
    const name = el('d-name').value.trim();
    const phone = el('d-phone').value.replace(/\s/g, '');
    const what = el('d-what').value.trim();

    if (name.length < 2) return { error: T('delivery.err_name') };
    if (!/^\+255[0-9]{9}$/.test(phone)) return { error: T('apply.err.phone') };
    if (what.length < 2) return { error: T('delivery.err_what') };

    return {
      recipientName: name,
      recipientPhone: phone,
      description: what,
      size: el('d-size').value,
    };
  }

  async function requestRide() {
    const q = state.selected;

    // A delivery cannot be dispatched without a named recipient — there is
    // nobody to hand it to otherwise.
    if (state.service !== 'ride') {
      const d = readDelivery();
      if (!d || d.error) {
        const box = panel.querySelector('#results');
        if (box) {
          box.innerHTML = msg(
            (d && d.error) ? d.error : T('delivery.err_name'), 'err');
        }
        return;
      }
      state.delivery = d;
    }

    panel.querySelector('#results').innerHTML =
      '<div class="status-box"><div class="spinner"></div><p>' + T('how.2.t') + '</p></div>';

    try {
      const ride = await api('/api/rides/request', {
        method: 'POST',
        body: JSON.stringify({
          clientGeneratedId: crypto.randomUUID(),
          serviceType: state.service,
          ...(state.delivery ? { delivery: state.delivery } : {}),
          quoteId: q.quoteId,
          category: q.category,
          paymentMethod: state.payment,
          pickup: { lat: state.pickup.lat, lng: state.pickup.lng,
            address: document.getElementById('from')?.value },
          dropoff: { lat: state.dropoff.lat, lng: state.dropoff.lng,
            address: document.getElementById('to')?.value },
        }),
      });
      state.ride = ride;
      connectSocket();
      renderTracking({ status: 'searching' });
    } catch (e) {
      renderBooking(e.message);
    }
  }

  /** Live updates over the same WebSocket namespace the apps use. */
  function connectSocket() {
    if (state.socket || !window.io) return;
    const socket = window.io('/rt', {
      auth: { token: state.token },
      transports: ['websocket', 'polling'],
    });
    state.socket = socket;

    socket.on('ride:status_change', (d) => renderTracking(d));
    socket.on('ride:driver_moved', (d) => {
      setMarker('driver', { lat: d.la / 1e6, lng: d.ln / 1e6 }, 'Dereva');
    });
    socket.on('payment:status', (d) => {
      if (d.status === 'success') renderTracking({ status: 'paid' });
    });
    // Application heartbeat; the gateway reaps sockets that go quiet.
    setInterval(() => socket.emit('hb', { t: Date.now() }), 20000);
  }

  function renderTracking(d) {
    toggleTopSos(true);
    const lang = kwemaLang();
    const labels = {
      searching: { sw: 'Tunatafuta dereva...', en: 'Finding a driver...', fr: 'Recherche d\u2019un chauffeur...' },
      accepted: { sw: 'Dereva anakuja', en: 'Driver on the way', fr: 'Le chauffeur arrive' },
      arrived: { sw: 'Dereva amefika', en: 'Driver has arrived', fr: 'Le chauffeur est arrivé' },
      in_progress: { sw: 'Safari imeanza', en: 'Trip in progress', fr: 'Trajet en cours' },
      completed: { sw: 'Safari imekamilika', en: 'Trip complete', fr: 'Trajet terminé' },
      expired: { sw: 'Hakuna dereva karibu', en: 'No drivers nearby', fr: 'Aucun chauffeur à proximité' },
      paid: { sw: 'Malipo yamekamilika', en: 'Payment complete', fr: 'Paiement effectué' },
    };
    const label = (labels[d.status] || labels.searching)[lang];
    const done = ['completed', 'expired', 'paid'].includes(d.status);

    panel.innerHTML =
      '<div class="status-box">' +
        (done ? '' : '<div class="spinner"></div>') +
        '<h2 style="font-size:20px;font-weight:800">' + label + '</h2>' +
        (state.ride ? '<p style="color:var(--muted);font-size:14px;margin-top:6px">' +
          state.ride.reference + '</p>' : '') +
      '</div>' +
      (d.driver ? '<div class="driver-card">' +
        '<div style="font-weight:700;font-size:16px">' + d.driver.name + '</div>' +
        '<div style="color:var(--muted);font-size:14px">★ ' + d.driver.rating + ' · ' +
          (d.vehicle ? d.vehicle.plate + ' · ' + d.vehicle.make + ' ' + d.vehicle.model : '') +
        '</div></div>' : '') +
      (d.status === 'completed' && state.payment === 'mobile_money'
        ? '<button class="btn btn-primary" style="width:100%" id="pay">' +
          T('pay.mm.t') + '</button>' : '') +
      (!done ? '<button class="btn-sos" id="sos">' +
        (lang === 'fr' ? 'Urgence' : lang === 'en' ? 'Emergency' : 'Dharura') +
        '</button>' : '') +
      (done ? '<button class="btn btn-ghost" style="width:100%;margin-top:10px" id="again">' +
        (lang === 'fr' ? 'Nouvelle course' : lang === 'en' ? 'Book another' : 'Omba nyingine') +
        '</button>' : '');

    const again = document.getElementById('again');
    if (again) again.addEventListener('click', () => { state.ride = null; renderBooking(); });

    const pay = document.getElementById('pay');
    if (pay) pay.addEventListener('click', payNow);

    const sos = document.getElementById('sos');
    if (sos) sos.addEventListener('click', raiseSos);
  }

  async function payNow() {
    try {
      if (state.payment === 'card') {
        const out = await api('/api/payments/card/initiate', {
          method: 'POST', body: JSON.stringify({ rideId: state.ride.rideId || state.ride.id }),
        });
        // Card details are entered on the provider's own page, never here.
        window.open(out.checkoutUrl, '_blank', 'noopener');
      } else {
        await api('/api/payments/collect', {
          method: 'POST',
          body: JSON.stringify({
            rideId: state.ride.rideId || state.ride.id,
            mno: (document.getElementById('mno') || {}).value || 'mpesa',
          }),
        });
        renderTracking({ status: 'completed' });
      }
    } catch (e) {
      panel.insertAdjacentHTML('afterbegin', msg(e.message, 'err'));
    }
  }

  // =================================================================
  // Emergency
  //
  // Confirmed once, because a misfire costs an operator's night, then sent
  // with whatever location the browser can give. A refused or unavailable
  // geolocation must never block the alert.
  // =================================================================
  async function raiseSos() {
    const lang = kwemaLang();
    const confirmText = lang === 'fr'
      ? 'Envoyer une alerte d\u2019urgence à Kwema ?'
      : lang === 'en'
      ? 'Send an emergency alert to Kwema?'
      : 'Tuma ombi la dharura kwa Kwema?';
    if (!window.confirm(confirmText)) return;

    let coords = null;
    try {
      coords = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude,
                           accuracyM: Math.round(p.coords.accuracy) }),
          () => resolve(null),
          { timeout: 4000, enableHighAccuracy: true });
      });
    } catch { coords = null; }

    try {
      await api('/sos', {
        method: 'POST',
        body: JSON.stringify({
          rideId: state.ride && (state.ride.rideId || state.ride.id),
          ...(coords || {}),
        }),
      });
    } catch { /* the alert is still worth confirming; ops also watch the log */ }

    const sent = lang === 'fr'
      ? 'Alerte envoyée. Appelez le 112 pour la police, l\u2019ambulance ou les pompiers.'
      : lang === 'en'
      ? 'Alert sent. Call 112 for police, ambulance or fire.'
      : 'Ombi limetumwa. Piga 112 kwa polisi, ambulensi au zimamoto.';
    if (window.confirm(sent + '\n\nOK = 112')) {
      window.location.href = 'tel:112';
    }
  }

  // =================================================================
  // Map
  // =================================================================
  function initMap() {
    if (!window.google || !window.google.maps) {
      document.getElementById('map').innerHTML =
        '<div class="map-fallback"><strong>' +
        (kwemaLang() === 'fr' ? 'Carte indisponible' : kwemaLang() === 'en' ? 'Map unavailable' : 'Ramani haipatikani') +
        '</strong><span>' +
        (kwemaLang() === 'fr' ? 'La réservation fonctionne quand même.'
         : kwemaLang() === 'en' ? 'Booking still works without it.'
         : 'Bado unaweza kuomba safari.') + '</span></div>';
      return;
    }
    state.map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: -6.8161, lng: 39.2894 }, // Posta, Dar es Salaam
      zoom: 13,
      disableDefaultUI: true,
      zoomControl: true,
    });
  }

  function setMarker(key, point, label) {
    if (!state.map) return;
    if (state.markers[key]) state.markers[key].setMap(null);
    const colours = { pickup: '#1E7A4C', dropoff: '#C0392B', driver: '#3A4BB8' };
    state.markers[key] = new google.maps.Marker({
      position: point, map: state.map, title: label,
      icon: {
        path: google.maps.SymbolPath.CIRCLE, scale: 9,
        fillColor: colours[key], fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3,
      },
    });
    const bounds = new google.maps.LatLngBounds();
    Object.values(state.markers).forEach((m) => bounds.extend(m.getPosition()));
    if (Object.keys(state.markers).length > 1) state.map.fitBounds(bounds, 70);
    else state.map.setCenter(point);
  }

  function drawRoute(polyline) {
    if (!state.map || !polyline || !google.maps.geometry) return;
    if (state.routeLine) state.routeLine.setMap(null);
    state.routeLine = new google.maps.Polyline({
      path: google.maps.geometry.encoding.decodePath(polyline),
      strokeColor: '#3A4BB8', strokeWeight: 5, strokeOpacity: 0.85, map: state.map,
    });
  }

  function useBrowserLocation() {
    if (!navigator.geolocation || state.pickup) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.pickup = point;
      setMarker('pickup', point, 'Pickup');
      try {
        const r = await api('/api/maps/reverse-geocode?lat=' + point.lat +
          '&lng=' + point.lng + '&language=' + kwemaLang());
        const input = document.getElementById('from');
        if (r.address && input && !input.value) input.value = r.address;
      } catch { /* a blank pickup field is fine; the marker is set */ }
    }, () => {}, { timeout: 8000 });
  }

  // =================================================================
  // Boot
  // =================================================================
  document.querySelectorAll('#lang button').forEach((b) => {
    b.addEventListener('click', () => {
      kwemaSetLang(b.dataset.lang);
      location.reload();
    });
  });

  fetch('/api/config/public').then((r) => r.json()).then((cfg) => {
    state.config = cfg;
    const scripts = [];
    if (cfg.mapsBrowserKey) {
      // loading=async silences Google's performance warning and is their
      // documented pattern for script-tag loading.
      scripts.push('https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(cfg.mapsBrowserKey) + '&libraries=geometry&loading=async');
    }
    scripts.push('/socket.io/socket.io.js');

    let pending = scripts.length;
    if (!pending) return start();
    scripts.forEach((src) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = s.onerror = () => { if (--pending === 0) start(); };
      document.head.appendChild(s);
    });
  }).catch(start);

  function start() {
    const topSos = document.getElementById('sos-top');
    if (topSos) {
      topSos.textContent = kwemaLang() === 'fr' ? 'Urgence'
        : kwemaLang() === 'en' ? 'Emergency' : 'Dharura';
      topSos.addEventListener('click', raiseSos);
    }
    initMap();
    if (state.token) renderBooking(); else renderLogin();
  }
})();
