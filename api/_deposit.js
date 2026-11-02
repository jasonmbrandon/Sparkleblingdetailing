// Shared deposit logic (files starting with "_" are not public endpoints on Vercel).
//
// Flow ("pay to confirm"): customer picks a time -> Stripe Checkout for the deposit -> after payment
// is confirmed by Stripe, we book the slot through the existing n8n Booking API (calendar + emails).
// Unpaid checkouts never touch the calendar.
//
// Vercel environment variables:
//   STRIPE_SECRET_KEY      (required) Joe's Stripe key: sk_test_... on Preview, sk_live_... or rk_live_... on Production
//   SB_DEPOSIT_PERCENT     (optional) default 20
//   SB_DEPOSIT_SERVICES    (optional) comma list of service keys, default: every ceramic_* service
//   SB_N8N_BASE            (optional) same as api/agent.js

const N8N = (process.env.SB_N8N_BASE || 'https://n8n-production-86e81.up.railway.app/webhook').replace(/\/$/, '');
const BOOK_API = N8N + '/sparkle-book';
const LEAD_API = N8N + '/sparkle-leads';
const PERCENT = Number(process.env.SB_DEPOSIT_PERCENT || 20);
const POLICY = 'Your deposit is non-refundable but can be moved to a new date, and it is applied to your final bill.';

async function post(url, body, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await r.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = { raw: raw.slice(0, 500) }; }
    if (Array.isArray(data)) data = data[0] || null;
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

let settingsCache = { at: 0, value: null };
async function getSettings(defaults) {
  if (settingsCache.value && Date.now() - settingsCache.at < 5 * 60 * 1000) return settingsCache.value;
  const r = await post(BOOK_API, { action: 'public_settings' }, null, 10000);
  const live = r.ok && r.data && r.data.ok && r.data.settings;
  const value = Object.assign({}, defaults || {}, live || {}, { _source: live ? 'live' : 'fallback' });
  if (live) settingsCache = { at: Date.now(), value };
  return value;
}

function depositRequired(service) {
  const list = (process.env.SB_DEPOSIT_SERVICES || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list.includes(service) : /^ceramic/.test(String(service || ''));
}

// Price from the business settings (same numbers the booking widget shows), and 20% of it.
function quote(settings, service, vehicleSize, addons) {
  const pkg = settings.packages && settings.packages[service];
  if (!pkg || pkg[vehicleSize] == null) return null;
  const add = (addons || []).reduce((t, k) => t + Number((settings.addons && settings.addons[k] && settings.addons[k].price) || 0), 0);
  const total = Number(pkg[vehicleSize]) + add;
  const deposit = Math.round(total * PERCENT / 100);
  return { label: pkg.label || service, total, deposit, percent: PERCENT, required: depositRequired(service) };
}

// ---------- Stripe (REST, no SDK) ----------
function form(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(k => {
    const v = obj[k], key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) return;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  });
  return out.join('&');
}
async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set in Vercel');
  const r = await fetch('https://api.stripe.com/v1' + path + (method === 'GET' && params ? '?' + form(params) : ''), {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe ' + r.status + ': ' + ((data.error && data.error.message) || 'request failed'));
  return data;
}

const FIELDS = ['service', 'vehicleSize', 'addons', 'start', 'startLabel', 'name', 'phone', 'email', 'address', 'city', 'vehicle', 'notes', 'sessionId', 'testMode', 'source'];
const clip = (v, n) => String(v == null ? '' : v).slice(0, n || 450);

// Check the time is still open right before taking money (cuts the "someone grabbed it" window to the checkout itself).
async function slotStillOpen(b) {
  const day = String(b.start || '').slice(0, 10);
  const r = await post(BOOK_API, { action: 'find_slots', mode: 'day', service: b.service, vehicleSize: b.vehicleSize, addons: (b.addons || []).join(','), dateFrom: day, dateTo: day }, null, 20000);
  if (!(r.ok && r.data && r.data.ok)) return { known: false };
  const slots = r.data.slots || [];
  return { known: true, open: slots.some(s => s.start === b.start), slots: slots.slice(0, 6).map(s => ({ start: s.start, label: s.label })) };
}

async function startCheckout(b, origin, defaults) {
  const missing = ['service', 'vehicleSize', 'start', 'name', 'phone', 'address', 'city', 'vehicle'].filter(k => !b[k]);
  if (missing.length) return { ok: false, error: 'MISSING_INFO', message: 'Missing: ' + missing.join(', ') };
  const settings = await getSettings(defaults);
  const q = quote(settings, b.service, b.vehicleSize, b.addons);
  if (!q) return { ok: false, error: 'BAD_SERVICE', message: 'Unknown service or vehicle size.' };
  if (!q.required) return { ok: false, error: 'NO_DEPOSIT', message: 'This service does not need a deposit.' };

  const check = await slotStillOpen(b);
  if (check.known && !check.open) return { ok: false, error: 'SLOT_TAKEN', message: 'That time was just taken.', alternatives: check.slots };

  const meta = {};
  FIELDS.forEach(k => { if (b[k] !== undefined && b[k] !== '') meta[k] = clip(Array.isArray(b[k]) ? b[k].join(',') : b[k]); });
  meta.total = String(q.total); meta.deposit = String(q.deposit);

  const base = origin.replace(/\/$/, '');
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: b.email || undefined,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: q.deposit * 100, product_data: {
      name: q.percent + '% deposit: ' + q.label,
      description: clip((b.startLabel || b.start) + ' · ' + b.vehicle + ' · ' + b.city + '. Remaining balance due when the job is done.', 300)
    } } } },
    metadata: meta,
    payment_intent_data: { metadata: meta, description: 'Deposit: ' + q.label + ' for ' + clip(b.name, 80) },
    custom_text: { submit: { message: POLICY } },
    success_url: base + '/?deposit=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: base + '/?deposit=cancelled'
  });
  return { ok: true, url: session.url, sessionId: session.id, deposit: q.deposit, total: q.total };
}

// Called by the Stripe webhook (and, as a backup, by the status check). Books only if Stripe says it's paid,
// and only once: the result is written to the payment's metadata.
async function finalize(sessionId) {
  const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(sessionId), { expand: { 0: 'payment_intent' } });
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  if (s.payment_status !== 'paid' || !pi) return { status: 'unpaid' };
  const pm = pi.metadata || {};
  if (pm.booking_status) return { status: pm.booking_status, displayTime: pm.booking_time || '', bookingPrice: pm.total };

  const m = s.metadata || {};
  const paid = Math.round((s.amount_total || 0) / 100);
  const body = {
    action: 'book', service: m.service, vehicleSize: m.vehicleSize, addons: m.addons || '', start: m.start,
    name: m.name, phone: m.phone, email: m.email || s.customer_details && s.customer_details.email || '', address: m.address, city: m.city, vehicle: m.vehicle,
    notes: [m.notes, 'DEPOSIT PAID $' + paid + ' (Stripe ' + pi.id + '), balance $' + (Number(m.total || 0) - paid)].filter(Boolean).join(' | '),
    website: '', sessionId: m.sessionId || '', testMode: m.testMode === 'true'
  };
  const r = await post(BOOK_API, body, null, 30000);
  const d = r.data || {};
  let result;
  if (r.ok && d.status === 'confirmed') {
    result = { status: 'confirmed', displayTime: d.displayTime || m.startLabel || '', serviceLabel: d.serviceLabel, price: d.price, address: d.address, addToCalendarUrl: d.addToCalendarUrl };
  } else {
    // Paid but the time is gone (or the booking system failed): tell Joe to call them to pick a new time.
    await post(LEAD_API, {
      id: 'L' + Date.now().toString(36), timestamp: new Date().toISOString(), status: 'new', type: 'handoff', source: 'Deposit paid - needs scheduling',
      name: m.name, phone: m.phone, email: body.email, service: m.service, vehicle: m.vehicle, vehicleSize: m.vehicleSize, city: m.city, address: m.address,
      when: m.startLabel || m.start, estimate: m.total, test: m.testMode === 'true',
      notes: 'DEPOSIT PAID $' + paid + ' (Stripe ' + pi.id + ') but the time could not be booked (' + (d.message || r.status || r.error) + '). Call to pick a new time.'
    }, null, 15000);
    result = { status: 'needs_reschedule', displayTime: m.startLabel || '' };
  }
  await stripe('POST', '/payment_intents/' + pi.id, { metadata: { booking_status: result.status, booking_time: clip(result.displayTime, 200) } }).catch(() => {});
  return result;
}

async function status(sessionId) {
  const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(sessionId), { expand: { 0: 'payment_intent' } });
  const m = s.metadata || {};
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const base = { paid: s.payment_status === 'paid', deposit: Math.round((s.amount_total || 0) / 100), total: Number(m.total || 0), startLabel: m.startLabel || '', email: m.email || '' };
  if (!base.paid) return Object.assign(base, { status: s.status === 'expired' ? 'expired' : 'unpaid' });
  const pm = (pi && pi.metadata) || {};
  if (pm.booking_status) return Object.assign(base, { status: pm.booking_status, displayTime: pm.booking_time || m.startLabel || '' });
  // Webhook normally books within seconds of payment. If it still hasn't 2 minutes after payment, book from here as a backup.
  if (pi && Date.now() / 1000 - (pi.created || 0) > 120) return Object.assign(base, await finalize(sessionId));
  return Object.assign(base, { status: 'processing' });
}

module.exports = { post, getSettings, quote, depositRequired, startCheckout, finalize, status, PERCENT, POLICY };
