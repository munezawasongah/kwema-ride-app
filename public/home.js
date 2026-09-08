/* Landing page behaviour.
 *
 * The board is the page's one moving part. Everything else responds only to a
 * click, and the board itself stops if the visitor has asked for reduced
 * motion or moves focus into the page.
 */

(function () {
  // ---------------------------------------------------------------
  // Fares
  //
  // Computed here from the same Dar es Salaam rate card the server uses, so
  // the marketing figures cannot drift away from what someone is actually
  // quoted. Amounts in TSh. These are the placeholder rates pending the LATRA
  // order, which is what the banner at the top of the page says.
  // ---------------------------------------------------------------
  // Speeds are average door-to-door pace on a real Dar route, taken from what
  // Google Directions actually returns — not the much slower figure the
  // dispatcher uses to estimate a driver's approach through traffic. Using
  // the dispatch figure here inflated every duration roughly fourfold and
  // made the board quote prices the app would never charge.
  const RATES = {
    boda:     { base:  600, km:  400, min:  40, minimum: 1200, colour: '#D9722B', speed: 32 },
    bajaji:   { base: 1200, km:  550, min:  60, minimum: 1800, colour: '#C9A227', speed: 26 },
    standard: { base: 2500, km:  800, min: 100, minimum: 3500, colour: '#3A4BB8', speed: 30 },
    xl:       { base: 3500, km: 1100, min: 130, minimum: 5000, colour: '#2E7D74', speed: 28 },
  };
  const BOOKING_FEE = 0.03;

  /** Mirrors the server: metered total, floor at the minimum, booking fee,
   *  then rounded to the nearest 50 TSh so a driver can make change. */
  function fare(tier, km) {
    const r = RATES[tier];
    const minutes = (km / r.speed) * 60;
    const metered = r.base + km * r.km + minutes * r.min;
    const withFee = Math.max(metered, r.minimum) * (1 + BOOKING_FEE);
    return Math.round(withFee / 50) * 50;
  }

  function minutes(tier, km) {
    return Math.max(1, Math.round((km / RATES[tier].speed) * 60));
  }

  const money = (n) => n.toLocaleString('en-US');

  // Real Dar es Salaam routes, with straight-line distances scaled the way the
  // server scales them. Recognisable pairs matter more than exhaustive ones.
  const ROUTES = [
    { from: 'Posta',        to: 'Mlimani City',   km: 13.0 },
    { from: 'Kariakoo',     to: 'Masaki',         km: 9.4 },
    { from: 'Ubungo',       to: 'Posta',          km: 12.2 },
    { from: 'Mwenge',       to: 'Kariakoo',       km: 10.1 },
    { from: 'Uwanja wa Ndege', to: 'Masaki',      km: 15.6 },
    { from: 'Tegeta',       to: 'Mwenge',         km: 11.8 },
    { from: 'Kimara',       to: 'Ubungo',         km: 7.9 },
  ];

  const TIER_KEY = { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Gari', xl: 'Gari Kubwa' };

  let index = 0;
  let timer = null;

  function paintBoard(animate) {
    const r = ROUTES[index];
    const lang = kwemaLang();

    document.getElementById('from').textContent = r.from;
    document.getElementById('to').textContent = r.to;
    document.getElementById('meta').textContent = r.km.toFixed(1) + ' km';

    const names = {
      sw: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Gari', xl: 'Gari Kubwa' },
      en: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Car', xl: 'Car XL' },
      fr: { boda: 'Bodaboda', bajaji: 'Bajaji', standard: 'Voiture', xl: 'Voiture XL' },
    }[lang] || TIER_KEY;

    const unit = lang === 'sw' ? 'dakika' : 'min';

    document.getElementById('fares').innerHTML = Object.keys(RATES).map((tier) => `
      <div class="fare">
        <div class="bar" style="background:${RATES[tier].colour}"></div>
        <div class="tier">${names[tier]}</div>
        <div class="amt">${money(fare(tier, r.km))}</div>
        <div class="min">${lang === 'sw' ? unit + ' ' + minutes(tier, r.km)
                                          : minutes(tier, r.km) + ' ' + unit}</div>
      </div>`).join('');

    const board = document.getElementById('board');
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      board.classList.remove('board-swap');
      void board.offsetWidth; // restart the animation
      board.classList.add('board-swap');
    }
  }

  function startBoard() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stopBoard();
    timer = setInterval(() => {
      index = (index + 1) % ROUTES.length;
      paintBoard(true);
    }, 3600);
  }
  function stopBoard() { if (timer) { clearInterval(timer); timer = null; } }

  // Stop cycling when the tab is hidden — no reason to spend a phone's
  // battery redrawing a board nobody is looking at.
  document.addEventListener('visibilitychange', () => {
    document.hidden ? stopBoard() : startBoard();
  });

  // "From" prices in the fleet table, taken from the shortest listed route so
  // the figure is honest rather than aspirational.
  function paintFleetPrices() {
    const shortest = ROUTES.reduce((a, b) => (a.km < b.km ? a : b)).km;
    document.querySelectorAll('[data-fare]').forEach((el) => {
      const label = el.querySelector('span');
      el.textContent = 'TSh ' + money(fare(el.dataset.fare, shortest));
      if (label) el.appendChild(label);
    });
  }

  // ---------------------------------------------------------------
  // Downloads
  //
  // Store URLs come from the server so links go live the moment the apps are
  // published, without a redeploy. Anything unconfigured renders as a
  // disabled tile rather than a dead link.
  //
  // The direct APK sits alongside the stores rather than below them: Play
  // Store access is inconsistent on the cheaper Android handsets sold here,
  // and sideloading is an ordinary way to install an app in this market.
  // ---------------------------------------------------------------
  let config = {};
  let currentDl = 'rider';

  function renderStores(which) {
    currentDl = which;
    const row = document.getElementById('stores');
    const apps = (config.apps && config.apps[which]) || {};

    row.innerHTML = [
      ['ios', apps.ios, 'App Store', 'iPhone'],
      ['android', apps.android, 'Google Play', 'Android'],
      ['apk', apps.apk, 'APK', kwemaT('dl.apk')],
    ].map(([kind, url, small, strong]) => {
      const live = Boolean(url);
      return `<a class="store${live ? '' : ' off'}" href="${live ? url : '#'}"
                 ${live ? 'rel="noopener"' : 'aria-disabled="true"'}
                 ${kind === 'apk' && live ? 'download' : ''}>
                <span><small>${live ? small : kwemaT('dl.soon')}</small>
                <strong>${strong}</strong></span></a>`;
    }).join('');

    document.getElementById('apk-note').textContent = kwemaT('dl.apk.note');
  }

  document.querySelectorAll('.dl-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dl-tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      renderStores(tab.dataset.dl);
    });
  });

  fetch('/api/config/public')
    .then((r) => r.json())
    .then((c) => { config = c; renderStores('rider'); })
    .catch(() => renderStores('rider'));

  // ---------------------------------------------------------------
  kwemaApplyI18n();
  document.querySelectorAll('#lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === kwemaLang());
    b.addEventListener('click', () => {
      kwemaSetLang(b.dataset.lang);
      paintBoard(false);
      paintFleetPrices();
      renderStores(currentDl);
    });
  });

  paintBoard(false);
  paintFleetPrices();
  startBoard();
})();
