/* Landing page behaviour: language switching, download links, and the
   destination capture that hands off to the booking app. */

(function () {
  kwemaApplyI18n();
  document.querySelectorAll('#lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === kwemaLang());
    b.addEventListener('click', () => {
      kwemaSetLang(b.dataset.lang);
      renderStores(currentDl);
    });
  });

  // ---------------------------------------------------------------
  // Download links
  //
  // Store URLs come from the server rather than being hardcoded, so the
  // links can go live the moment the apps are published without a redeploy.
  // Any store that has no URL configured renders as a disabled "coming soon"
  // tile rather than a dead link.
  //
  // The direct APK matters more here than it would in Europe. Play Store
  // access is inconsistent on cheaper Android handsets sold locally, and
  // sideloading is a normal, expected way to install an app in this market —
  // so it gets a first-class slot, not a hidden footnote.
  // ---------------------------------------------------------------
  let config = {};
  let currentDl = 'rider';

  const STORE_META = {
    ios: { glyph: '', small: 'App Store', strong: 'iPhone' },
    android: { glyph: '▶', small: 'Google Play', strong: 'Android' },
    apk: { glyph: '⤓', small: 'APK', strong: 'Android' },
  };

  function renderStores(which) {
    currentDl = which;
    const row = document.getElementById('stores');
    const apps = (config.apps && config.apps[which]) || {};
    row.innerHTML = '';

    [
      ['ios', apps.ios],
      ['android', apps.android],
      ['apk', apps.apk],
    ].forEach(([kind, url]) => {
      const meta = STORE_META[kind];
      const a = document.createElement('a');
      a.className = 'store' + (url ? '' : ' disabled');
      a.href = url || '#';
      if (url) {
        a.rel = 'noopener';
        if (kind === 'apk') a.setAttribute('download', '');
      }
      a.innerHTML =
        '<span class="glyph">' + meta.glyph + '</span><span>' +
        '<small>' + (url ? meta.small : kwemaT('dl.soon')) + '</small>' +
        '<strong>' + (kind === 'apk' ? kwemaT('dl.apk') : meta.strong) + '</strong>' +
        '</span>';
      row.appendChild(a);
    });

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
  // Destination capture
  //
  // Place search needs an authenticated session, so before login the inputs
  // simply carry whatever the visitor typed through to the booking app,
  // which resolves it properly once they are signed in. Better than blocking
  // the whole hero behind a login wall.
  // ---------------------------------------------------------------
  function handoff() {
    const from = document.getElementById('from').value.trim();
    const to = document.getElementById('to').value.trim();
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    window.location.href = '/book.html' + (params.toString() ? '?' + params : '');
  }

  document.getElementById('go').addEventListener('click', handoff);
  ['from', 'to'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handoff();
    });
  });
})();
