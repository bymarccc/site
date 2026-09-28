/* GOATIFY visitors — anonymous page-view beacon for the "Live visitors" / last-24h numbers in the GOATIFY app.
   No cookies, no personal data: a random id kept in this browser, the page path and where the visit came from. */
(function () {
  try {
    if (navigator.webdriver || !/(^|\.)bymarccc\.com$/.test(location.hostname)) return;
    var API = 'https://goatify.goatagency.us/api/v1/collect/bymarccc', K = 'bym.vid', v = null;
    try { v = localStorage.getItem(K); } catch (e) {}
    if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
      var a = new Uint8Array(16); crypto.getRandomValues(a);
      v = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(K, v); } catch (e) {}
    }
    var utm = ''; try { utm = new URLSearchParams(location.search).get('utm_source') || ''; } catch (e) {}
    var send = function (ev) {
      var d = JSON.stringify({ v: v, e: ev, p: location.pathname, r: ev === 'pv' ? document.referrer : '', u: ev === 'pv' ? utm : '' });
      try { if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([d], { type: 'text/plain' }))) return; } catch (e) {}
      try { fetch(API, { method: 'POST', body: d, headers: { 'content-type': 'text/plain' }, keepalive: true, credentials: 'omit' }).catch(function () {}); } catch (e) {}
    };
    send('pv');
    setInterval(function () { if (document.visibilityState === 'visible') send('hb'); }, 30000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') send('hb'); });
  } catch (e) {}
})();
