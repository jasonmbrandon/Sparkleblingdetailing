// Ad tracking for the Henderson-area landing pages (Meta Pixel + Google Ads).
// Fill in the three IDs below. Anything left empty stays switched off, so this file is safe to ship before the ad accounts exist.
//   META_PIXEL_ID   Meta Events Manager > Data sources > your pixel > Settings ("Dataset ID" / "Pixel ID"), digits only
//   GOOGLE_ADS_ID   Google Ads > Goals > Conversions > your lead action > Tag setup > "AW-XXXXXXXXXX"
//   GOOGLE_ADS_LEAD_LABEL   same screen, the part after the slash in send_to: 'AW-XXXXXXXXXX/<label>'
(function () {
  var META_PIXEL_ID = '';
  var GOOGLE_ADS_ID = '';
  var GOOGLE_ADS_LEAD_LABEL = '';

  // Remember where the visitor came from (ad click IDs + UTM tags) for this browser session,
  // so a lead still carries it after they click through to a neighborhood page.
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
  var store = {};
  try { store = JSON.parse(sessionStorage.getItem('sb_attr') || '{}'); } catch (e) {}
  var q = new URLSearchParams(location.search);
  if (KEYS.some(function (k) { return q.get(k); })) {
    store = { landing_page: location.pathname };
    KEYS.forEach(function (k) { if (q.get(k)) store[k] = q.get(k); });
    try { sessionStorage.setItem('sb_attr', JSON.stringify(store)); } catch (e) {}
  }
  window.sbAttribution = function () {
    var out = {};
    KEYS.concat('landing_page').forEach(function (k) { out[k] = store[k] || ''; });
    return out;
  };

  if (META_PIXEL_ID) {
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  if (GOOGLE_ADS_ID) {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + GOOGLE_ADS_ID;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GOOGLE_ADS_ID);
  }

  // Called by lp.js after a quote request reaches the Leads sheet.
  window.sbTrackLead = function (value, label) {
    if (window.fbq && META_PIXEL_ID) window.fbq('track', 'Lead', { content_name: label, currency: 'USD', value: value });
    if (window.gtag && GOOGLE_ADS_ID && GOOGLE_ADS_LEAD_LABEL) {
      window.gtag('event', 'conversion', { send_to: GOOGLE_ADS_ID + '/' + GOOGLE_ADS_LEAD_LABEL, currency: 'USD', value: value });
    }
  };
})();
