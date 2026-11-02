// Sparkle & Bling AI agent: one endpoint, two modes.
//   customer (default): website chat. Answers questions, quotes, guides the sale, books onto the calendar.
//   owner: admin-page assistant. Reads leads, bookings and settings and answers the owner's questions.
//
// The calendar, emails and Leads sheet still run through the existing n8n APIs (Booking, Lead Intake, Admin);
// this file replaces only the n8n "Chat Agent" workflow, calling the AI directly.
//
// Vercel environment variables:
//   ANTHROPIC_API_KEY  (required)  AI key from console.anthropic.com
//   SB_AGENT_MODEL     (optional)  defaults to claude-sonnet-5-5
//   SB_N8N_BASE        (optional)  defaults to the live n8n webhook base below
// Owner mode needs no extra key here: it forwards the admin key the owner signed in with, and n8n checks it.

const GCal = require('./_gcal');
const N8N = (process.env.SB_N8N_BASE || 'https://n8n-production-86e81.up.railway.app/webhook').replace(/\/$/, '');
const API = { book: N8N + '/sparkle-book', leads: N8N + '/sparkle-leads', admin: N8N + '/sparkle-admin' };
const MODEL = process.env.SB_AGENT_MODEL || 'claude-sonnet-5-5';
const TZ = 'America/Los_Angeles';
const ALLOWED_ORIGINS = [/^https:\/\/(www\.)?sparkleblingdetailing\.com$/, /^https:\/\/[a-z0-9-]+\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/];

// Fallback business facts, used only if the Booking API's public_settings can't be reached.
const DEFAULT_SETTINGS = {
  business: { name: 'Sparkle & Bling Mobile Auto Detailing', phone: '(661) 481-5317' },
  packages: {
    express: { label: 'Express Wash & Wax', sedan: 135, mid_suv: 165, full_suv: 185 },
    signature: { label: 'Signature Full Detail', sedan: 265, mid_suv: 305, full_suv: 345 },
    ceramic_3yr: { label: '3-Year Ceramic Shield', sedan: 1050, mid_suv: 1260, full_suv: 1470 },
    ceramic_5yr: { label: '5-Year Graphene Armor', sedan: 1575, mid_suv: 1785, full_suv: 1995 },
    ceramic_lifetime: { label: 'Lifetime Crown Graphene', sedan: 2625, mid_suv: 3045, full_suv: 3465 }
  },
  addons: {
    headlight: { label: 'Headlight Restoration', price: 95 }, engine: { label: 'Engine Bay Detail', price: 125 },
    petHair: { label: 'Pet Hair Extraction', price: 85 }, glass: { label: 'Windshield Ceramic Shield', price: 75 },
    wheelCoating: { label: 'Wheel Barrel Ceramic Barrier', price: 150 }
  },
  sizeLabels: { sedan: 'Sedan / Coupe', mid_suv: 'Mid-size SUV / Pickup', full_suv: 'Full-size SUV / Van' },
  ceramicVoucher: 150,
  serviceCities: ['Lancaster', 'Palmdale', 'Quartz Hill', 'Santa Clarita', 'Valencia', 'Stevenson Ranch', 'Saugus', 'Newhall', 'Canyon Country', 'Rosamond', 'Acton']
};

const SITE_FACTS = `
- Fully mobile: we come to the customer's home or work with our own deionized spot-free water and power. No hookups needed.
- Ceramic and graphene coatings are 9H and include paint correction (multi-stage machine polish) before coating. Coating warranties are registered to the vehicle's VIN through CARFAX.
- Express Wash & Wax: maintenance hand wash and refresh. Signature Full Detail: full interior (steam, hot-water extraction of seats/carpets/headliner) plus exterior.
- Licensed, $1M insured, 4.9-star rating with 180+ local reviews, BBB A+.
- New ceramic clients get a ceramic prep credit (amount in settings: ceramicVoucher).
- Expanding to Henderson / Las Vegas (Henderson, Green Valley, Anthem, Inspirada, Lake Las Vegas, Seven Hills, Southern Highlands) for ceramic coating; those requests can always be taken as a quote request even if online booking there isn't open yet.
- Exact final price is confirmed after the paint is seen; very dirty interiors, heavy pet hair or heavy oxidation may cost more.`;

// ---------- small helpers ----------
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
async function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.at < 5 * 60 * 1000) return settingsCache.value;
  const r = await post(API.book, { action: 'public_settings' }, null, 10000);
  const live = r.ok && r.data && r.data.ok && r.data.settings;
  const value = Object.assign({}, DEFAULT_SETTINGS, live || {}, { _source: live ? 'live' : 'fallback' });
  settingsCache = { at: Date.now(), value };
  return value;
}

function nowLine() {
  return new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function todayISO(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

// ---------- tools ----------
const SERVICE_ENUM = ['express', 'signature', 'ceramic_3yr', 'ceramic_5yr', 'ceramic_lifetime'];
const SIZE_ENUM = ['sedan', 'mid_suv', 'full_suv'];

const CUSTOMER_TOOLS = [
  {
    name: 'find_open_times',
    description: 'Look up real open appointment times on the calendar for a service. Always call this before offering times; never invent times.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: SERVICE_ENUM },
        vehicleSize: { type: 'string', enum: SIZE_ENUM },
        addons: { type: 'array', items: { type: 'string' }, description: 'Add-on keys from settings, e.g. petHair' },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD, first day to search (defaults to today)' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD, last day to search (defaults to dateFrom + 6 days)' }
      },
      required: ['service', 'vehicleSize']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment on the calendar. Only call after the customer has picked one of the times returned by find_open_times AND explicitly confirmed the summary (service, vehicle, time, address, price).',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: SERVICE_ENUM },
        vehicleSize: { type: 'string', enum: SIZE_ENUM },
        addons: { type: 'array', items: { type: 'string' } },
        start: { type: 'string', description: 'The exact "start" value of the chosen slot from find_open_times' },
        name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', description: 'Optional but recommended for the confirmation email' },
        address: { type: 'string', description: 'Street address where the work happens' }, city: { type: 'string' },
        vehicle: { type: 'string', description: 'Year make model' }, notes: { type: 'string' }
      },
      required: ['service', 'vehicleSize', 'start', 'name', 'phone', 'address', 'city', 'vehicle']
    }
  },
  {
    name: 'save_request',
    description: 'Send the owner a lead when the customer wants a quote/callback instead of booking now, is outside online-booking areas (e.g. Henderson/Las Vegas ceramic), asks something you cannot answer, or booking tools are failing. Needs at least name and phone.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['request', 'question', 'handoff'] },
        name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
        service: { type: 'string' }, vehicle: { type: 'string' }, vehicleSize: { type: 'string' },
        city: { type: 'string' }, address: { type: 'string' }, when: { type: 'string', description: 'Preferred day/time in their words' },
        notes: { type: 'string', description: 'What they want / the question, in one or two lines' }
      },
      required: ['type', 'name', 'phone', 'notes']
    }
  },
  {
    name: 'show_booking_button',
    description: 'Show a "Pick a time" button that opens the on-page booking form prefilled. Use when the customer prefers to pick a time themselves, or if find_open_times fails.',
    input_schema: {
      type: 'object',
      properties: { service: { type: 'string', enum: SERVICE_ENUM }, vehicleSize: { type: 'string', enum: SIZE_ENUM }, vehicle: { type: 'string' }, addPetHair: { type: 'boolean' } },
      required: ['service']
    }
  },
  {
    name: 'quick_replies',
    description: 'Offer up to 4 short tap-to-send reply suggestions under your message (e.g. "Sedan", "Mid-size SUV"). Optional.',
    input_schema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, required: ['options'] }
  }
];

const OWNER_TOOLS = [
  {
    name: 'get_leads',
    description: 'Get leads and bookings from the Leads sheet (website chat, booking form, quote forms, landing pages, ads). Filter by days back and type. Returns rows plus counts by type, status, city, service and ad source.',
    input_schema: {
      type: 'object',
      properties: {
        daysBack: { type: 'integer', description: 'Only rows created in the last N days (default 30)' },
        type: { type: 'string', enum: ['any', 'booking', 'request', 'voucher', 'question', 'handoff'] },
        includeTest: { type: 'boolean', description: 'Include test rows (default false)' }
      }
    }
  },
  {
    name: 'get_schedule',
    description: 'Get confirmed upcoming (or past) appointments between two dates, from the bookings in the Leads sheet.',
    input_schema: { type: 'object', properties: { dateFrom: { type: 'string', description: 'YYYY-MM-DD (default today)' }, dateTo: { type: 'string', description: 'YYYY-MM-DD (default today + 7)' } } }
  },
  {
    name: 'find_open_times',
    description: 'Check open calendar times for a service and vehicle size between two dates.',
    input_schema: {
      type: 'object',
      properties: { service: { type: 'string', enum: SERVICE_ENUM }, vehicleSize: { type: 'string', enum: SIZE_ENUM }, dateFrom: { type: 'string' }, dateTo: { type: 'string' } },
      required: ['service', 'vehicleSize']
    }
  },
  {
    name: 'get_calendar',
    description: "Read Joe's real Google Calendar between two dates: every event, including jobs he added by hand and days blocked Off. Use this for any question about his calendar, schedule or availability.",
    input_schema: { type: 'object', properties: { dateFrom: { type: 'string', description: 'YYYY-MM-DD (default today)' }, dateTo: { type: 'string', description: 'YYYY-MM-DD (default today + 7)' } } }
  },
  {
    name: 'add_calendar_event',
    description: 'Add an event to Joe\'s calendar (a job he booked by phone, an errand, or a day off: use title "Off" and allDay so online booking skips that day). CHANGES THE CALENDAR: only after the owner replied yes to your exact summary.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, allDay: { type: 'boolean' }, endDate: { type: 'string', description: 'YYYY-MM-DD, last day for multi-day all-day events' },
        startTime: { type: 'string', description: 'HH:MM 24-hour, Pacific time' }, endTime: { type: 'string', description: 'HH:MM 24-hour' },
        location: { type: 'string' }, notes: { type: 'string', description: 'Customer name, phone, vehicle, service, price' }
      },
      required: ['title', 'date']
    }
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a website booking (removes it from the calendar, marks it cancelled, optionally emails the customer). Use the "id" from get_schedule or get_leads. CHANGES THE CALENDAR: only after the owner replied yes to your exact summary.',
    input_schema: { type: 'object', properties: { bookingId: { type: 'string' }, reason: { type: 'string', description: 'Included in the customer email' }, notifyCustomer: { type: 'boolean', description: 'Default true if they have an email' } }, required: ['bookingId'] }
  },
  {
    name: 'reschedule_booking',
    description: 'Move a website booking to a new time (updates the calendar, optionally emails the customer). Get valid times first with find_open_times for that booking\'s service and vehicle size. CHANGES THE CALENDAR: only after the owner replied yes to your exact summary.',
    input_schema: { type: 'object', properties: { bookingId: { type: 'string' }, newStart: { type: 'string', description: 'Exact "start" from find_open_times' }, notifyCustomer: { type: 'boolean' }, allowShortNotice: { type: 'boolean' } }, required: ['bookingId', 'newStart'] }
  },
  {
    name: 'get_settings',
    description: 'Get the current business settings: prices, hours, service cities, scheduling rules, current offer.',
    input_schema: { type: 'object', properties: {} }
  }
];

function compactLead(l) {
  const keys = ['id', 'timestamp', 'type', 'status', 'source', 'name', 'phone', 'email', 'serviceLabel', 'service', 'vehicle', 'vehicleSize', 'city', 'startDisplay', 'start', 'when', 'estimate', 'notes', 'utm_source', 'utm_campaign', 'landing_page', 'test'];
  const o = {};
  keys.forEach(k => { if (l[k] !== undefined && l[k] !== '' && l[k] !== null) o[k] = typeof l[k] === 'string' ? l[k].slice(0, 200) : l[k]; });
  return o;
}
function countBy(rows, f) { const o = {}; rows.forEach(r => { const k = f(r) || 'unknown'; o[k] = (o[k] || 0) + 1; }); return o; }
const isTest = l => l.test === true || l.test === 'true' || l.test === 'TRUE';

async function runTool(name, input, ctx) {
  input = input || {};
  const settings = ctx.settings;

  if (name === 'find_open_times') {
    const dateFrom = input.dateFrom || todayISO(0);
    const dateTo = input.dateTo || (() => { const d = new Date(dateFrom + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();
    const body = { action: 'find_slots', service: input.service, vehicleSize: input.vehicleSize, addons: (input.addons || []).join(','), dateFrom, dateTo };
    const r = ctx.mode === 'owner' ? await post(API.admin, body, { 'X-Admin-Key': ctx.adminKey }, 20000) : await post(API.book, body, null, 20000);
    if (!(r.ok && r.data && r.data.ok)) {
      ctx.log.push('find_slots failed ' + (r.status || r.error));
      return { ok: false, error: 'Calendar lookup is unavailable right now. Offer the "Pick a time" button (show_booking_button) or take a request (save_request).' };
    }
    const slots = (r.data.slots || []).slice(0, 10).map(s => ({ start: s.start, label: s.label }));
    return { ok: true, slots, note: slots.length ? 'Offer 2-4 of these, spread across days. Use the label text when talking to the customer.' : 'No openings in that range; try a later range.' };
  }

  if (name === 'book_appointment') {
    const body = {
      action: 'book', service: input.service, vehicleSize: input.vehicleSize, addons: (input.addons || []).join(','), start: input.start,
      name: input.name, phone: input.phone, email: input.email || '', address: input.address, city: input.city, vehicle: input.vehicle,
      notes: [input.notes, 'Booked by website AI agent'].filter(Boolean).join(' | '), website: '', sessionId: ctx.sessionId, testMode: !!ctx.testMode
    };
    const r = await post(API.book, body, null, 30000);
    const d = r.data || {};
    if (r.ok && d.status === 'confirmed') {
      ctx.booking = d;
      return { ok: true, confirmed: true, displayTime: d.displayTime, serviceLabel: d.serviceLabel, price: d.price, address: d.address };
    }
    if (d.alternatives) return { ok: false, reason: d.message || 'That time was just taken.', alternatives: d.alternatives.slice(0, 6).map(s => ({ start: s.start, label: s.label })) };
    if (d.error === 'MISSING_INFO') return { ok: false, reason: d.message || 'Missing information' };
    ctx.log.push('book failed ' + (r.status || r.error));
    return { ok: false, reason: 'The booking system did not respond. Apologize briefly, take it as a request with save_request (include the chosen time in "when"), and say the owner will text to confirm.' };
  }

  if (name === 'save_request') {
    const svc = settings.packages && settings.packages[input.service];
    const payload = Object.assign({
      id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: new Date().toISOString(), sessionId: ctx.sessionId,
      status: 'new', test: !!ctx.testMode, source: 'Website AI agent'
    }, input, { serviceLabel: svc ? svc.label : (input.service || '') });
    Object.assign(payload, ctx.attribution || {});
    const r = await post(API.leads, payload, null, 15000);
    if (!r.ok) ctx.log.push('lead failed ' + (r.status || r.error));
    return r.ok ? { ok: true } : { ok: false, error: 'Could not save. Ask them to call or text ' + ((settings.business && settings.business.phone) || '(661) 481-5317') + '.' };
  }

  if (name === 'show_booking_button') {
    ctx.openBooking = { type: 'open_booking', service: input.service, vehicleSize: input.vehicleSize || '', vehicle: input.vehicle || '', addPetHair: !!input.addPetHair };
    return { ok: true, note: 'Button will appear under your message.' };
  }

  if (name === 'quick_replies') { ctx.suggestions = (input.options || []).slice(0, 4); return { ok: true }; }

  // ----- owner tools -----
  if (['add_calendar_event', 'cancel_booking', 'reschedule_booking'].includes(name)) {
    if (!ctx.confirmed) return { ok: false, needsConfirmation: true, note: 'Not done. Show the owner exactly what will change (who, what, when, and whether the customer is emailed) and ask them to reply "yes".' };
    if ((ctx.writes = (ctx.writes || 0) + 1) > 3) return { ok: false, error: 'Too many changes in one message; ask the owner to confirm the rest separately.' };
  }

  if (name === 'get_calendar') {
    const from = input.dateFrom || todayISO(0), to = input.dateTo || todayISO(7);
    try { const events = await GCal.listEvents(from, to); return { ok: true, from, to, count: events.length, events }; }
    catch (e) { ctx.log.push('calendar read: ' + e.message); return { ok: false, error: e.message, note: 'Fall back to get_schedule (website bookings only) and tell the owner the calendar connection needs attention.' }; }
  }

  if (name === 'add_calendar_event') {
    if (!input.allDay && !(input.startTime && input.endTime)) return { ok: false, error: 'Need startTime and endTime, or allDay: true.' };
    try { const ev = await GCal.createEvent(input); return { ok: true, created: ev }; }
    catch (e) { ctx.log.push('calendar write: ' + e.message); return { ok: false, error: e.message }; }
  }

  if (name === 'cancel_booking' || name === 'reschedule_booking') {
    if (!ctx.leadRows) {
      const r = await post(API.admin, { action: 'list_leads', limit: 500 }, { 'X-Admin-Key': ctx.adminKey }, 25000);
      if (!(r.ok && r.data && Array.isArray(r.data.leads))) return { ok: false, error: 'Could not load bookings.' };
      ctx.leadRows = r.data.leads;
    }
    const l = ctx.leadRows.find(x => String(x.id) === String(input.bookingId));
    if (!l || l.type !== 'booking') return { ok: false, error: 'No website booking with that id. Use get_schedule to find it.' };
    if (String(l.status || '').toLowerCase() === 'cancelled') return { ok: false, error: 'That booking is already cancelled.' };
    const base = { id: l.id, eventId: l.eventId, name: l.name, email: l.email, serviceLabel: l.serviceLabel, address: l.address, city: l.city, notify: input.notifyCustomer === undefined ? !!l.email : !!input.notifyCustomer };
    const body = name === 'cancel_booking'
      ? Object.assign({ action: 'cancel_booking', reason: input.reason || '' }, base)
      : Object.assign({ action: 'reschedule_booking', start: input.newStart, service: l.service, vehicleSize: l.vehicleSize, addons: '', allowShortNotice: !!input.allowShortNotice }, base);
    const r = await post(API.admin, body, { 'X-Admin-Key': ctx.adminKey }, 30000);
    if (r.ok && r.data && r.data.ok) {
      if (name === 'cancel_booking') l.status = 'cancelled'; else { l.start = r.data.start; l.startDisplay = r.data.startDisplay; }
      return { ok: true, booking: { name: l.name, service: l.serviceLabel, status: l.status, newTime: r.data.startDisplay || '' }, customerEmailed: base.notify };
    }
    return { ok: false, error: (r.data && r.data.message) || ('Failed (' + (r.status || r.error) + ')') };
  }

  if (name === 'get_settings') {
    const r = await post(API.admin, { action: 'get_settings' }, { 'X-Admin-Key': ctx.adminKey }, 20000);
    return r.ok && r.data && r.data.settings ? { ok: true, settings: r.data.settings } : { ok: true, settings, note: 'Admin API unavailable; showing public settings.' };
  }

  if (name === 'get_leads' || name === 'get_schedule') {
    if (!ctx.leadRows) {
      const r = await post(API.admin, { action: 'list_leads', limit: 500 }, { 'X-Admin-Key': ctx.adminKey }, 25000);
      if (!(r.ok && r.data && Array.isArray(r.data.leads))) return { ok: false, error: 'Could not load the Leads sheet (' + (r.status || r.error) + ').' };
      ctx.leadRows = r.data.leads;
    }
    let rows = ctx.leadRows;
    if (name === 'get_schedule') {
      const from = input.dateFrom || todayISO(0), to = input.dateTo || todayISO(7);
      rows = rows.filter(l => l.type === 'booking' && !isTest(l) && String(l.status || '').toLowerCase() !== 'cancelled' && l.start && String(l.start).slice(0, 10) >= from && String(l.start).slice(0, 10) <= to)
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return { ok: true, from, to, count: rows.length, appointments: rows.map(compactLead) };
    }
    const days = input.daysBack || 30, since = Date.now() - days * 86400000;
    rows = rows.filter(l => (input.includeTest || !isTest(l)) && (!l.timestamp || Date.parse(l.timestamp) >= since));
    if (input.type && input.type !== 'any') rows = rows.filter(l => l.type === input.type);
    return {
      ok: true, daysBack: days, total: rows.length,
      byType: countBy(rows, l => l.type), byStatus: countBy(rows, l => l.status), byCity: countBy(rows, l => l.city),
      byService: countBy(rows, l => l.serviceLabel || l.service), bySource: countBy(rows, l => l.utm_source || l.source),
      rows: rows.slice(0, 60).map(compactLead), truncated: rows.length > 60
    };
  }

  return { ok: false, error: 'Unknown tool' };
}

// ---------- prompts ----------
function customerPrompt(settings, context) {
  return `You are the booking concierge for ${settings.business && settings.business.name || 'Sparkle & Bling Mobile Auto Detailing'}, chatting on their website.
Current date and time: ${nowLine()} (Pacific time).

Your goals, in order: answer the question accurately; recommend the right package; book them on the calendar (or capture a request).

BUSINESS SETTINGS (prices in USD; source: ${settings._source}):
${JSON.stringify({ packages: settings.packages, addons: settings.addons, sizeLabels: settings.sizeLabels, ceramicPrepCredit: settings.ceramicVoucher, serviceCities: settings.serviceCities, hours: settings.hours, phone: settings.business && settings.business.phone })}

FACTS:${SITE_FACTS}

HOW TO SELL:
- Be warm, brief and confident: 1-3 short sentences per message, plain text with **bold** for prices/package names. No long lists.
- Ask one question at a time. Figure out vehicle (year/make/model -> size), condition and goal (clean vs. protect), then recommend ONE package with its exact price for their size, and mention one relevant add-on only if it fits (e.g. pet hair).
- For people who keep their car a long time, park outside or fight hard-water spots/sun, recommend ceramic and mention the prep credit for new ceramic clients.
- Prices: only quote numbers from BUSINESS SETTINGS. Ceramic prices already include paint correction. Never invent discounts, guarantees or "scratch-proof" claims.
- If they ask something you don't know (specific stains, odd vehicles, commercial fleets), say the owner will confirm and use save_request.

HOW TO BOOK:
1. Know service + vehicle size, then call find_open_times and offer 2-4 real times.
2. Collect: name, mobile number, street address + city, year/make/model, email (optional, for confirmation).
3. Check the city is in serviceCities. If not, don't book; offer save_request so the owner can confirm (Henderson/Las Vegas ceramic quotes always go to save_request).
4. Read back a one-line summary (service, vehicle, day/time, address, total) and ask "Shall I lock it in?". Only after a clear yes, call book_appointment with the exact "start".
5. If booking succeeds, confirm warmly in one or two sentences (the page shows the booking card). If a tool fails, offer show_booking_button or save_request; never claim a booking you didn't make.
Use quick_replies when there are obvious short answers (sizes, times, yes/no).

Page context from the visitor's browser (may be empty): ${JSON.stringify(context || {}).slice(0, 600)}`;
}

function ownerPrompt(settings) {
  return `You are the private business assistant for the owner of ${settings.business && settings.business.name || 'Sparkle & Bling Mobile Auto Detailing'}, inside the admin page of the website.
Current date and time: ${nowLine()} (Pacific time).

Answer the owner's questions about the business using your tools: leads and quote requests (get_leads), upcoming jobs (get_schedule), open calendar time (find_open_times) and settings (get_settings).
- Always use tools for numbers; never guess. Say which date range you looked at.
- Be short and practical: lead with the answer, then up to 5 bullet points. Use names, phone numbers and times so the owner can act (e.g. who to call back first).
- Point out useful patterns: unanswered requests older than a day, which service or city is asked about most, which ad source (utm_source) brings leads.
- Test rows are excluded unless asked.
- For "my calendar", "what's booked", "am I free" questions use get_calendar (Joe's real calendar). Use get_schedule/get_leads for customer details of website bookings.
- You CAN add events (add_calendar_event), cancel bookings (cancel_booking) and reschedule bookings (reschedule_booking). Before any of these, show a one-line summary of exactly what will change (who, what, when, customer emailed or not) and ask the owner to reply "yes". Only call the tool after they say yes. Never invent times: for reschedules, offer times from find_open_times.
- To block a day so online booking skips it, add an all-day event titled "Off".
- You can't change prices or settings; that's the Settings tab.
Public settings snapshot: ${JSON.stringify({ packages: settings.packages, serviceCities: settings.serviceCities, hours: settings.hours }).slice(0, 2500)}`;
}

// ---------- the AI loop ----------
async function callClaude(system, messages, tools) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system, messages, tools })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error('AI ' + r.status + ': ' + (data && data.error && data.error.message || 'request failed'));
  return data;
}

function toHistory(history) {
  const out = [];
  (Array.isArray(history) ? history : []).slice(-20).forEach(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = String(m.text || '').slice(0, 1500).trim();
    if (!text) return;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + text;
    else out.push({ role, content: text });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function runAgent({ mode, message, history, context, sessionId, testMode, adminKey, attribution }) {
  const settings = await getSettings();
  const ctx = { mode, settings, sessionId, testMode, adminKey, attribution, log: [], booking: null, openBooking: null, suggestions: [] };
  const system = mode === 'owner' ? ownerPrompt(settings) : customerPrompt(settings, context);
  const tools = mode === 'owner' ? OWNER_TOOLS : CUSTOMER_TOOLS;
  ctx.confirmed = mode === 'owner' && /^\s*(yes|yeah|yep|yup|y|confirm(ed)?|do it|go ahead|please do|sure|ok(ay)?|correct|that'?s right|sounds good|book it|cancel it|move it|add it)\b/i.test(message);
  const messages = toHistory(history);
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n' + message;
  else messages.push({ role: 'user', content: message });

  let text = '';
  for (let turn = 0; turn < 6; turn++) {
    const res = await callClaude(system, messages, tools);
    const blocks = res.content || [];
    text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || text;
    const uses = blocks.filter(b => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) break;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await runTool(u.name, u.input, ctx); } catch (e) { out = { ok: false, error: String(e.message || e) }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: text || 'Sorry, I didn\'t catch that. Could you rephrase?', booking: ctx.booking, openBooking: ctx.openBooking, suggestions: ctx.suggestions, debug: ctx.log };
}

// ---------- HTTP handler ----------
module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.some(re => re.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (origin && !ALLOWED_ORIGINS.some(re => re.test(origin))) return res.status(403).json({ error: 'Origin not allowed' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (body.event === 'ping') return res.status(200).json({ ok: true, agent: 'vercel', model: MODEL, aiKey: !!process.env.ANTHROPIC_API_KEY });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set in Vercel' });

  const message = String(body.message || '').trim().slice(0, 1500);
  if (!message) return res.status(400).json({ error: 'message required' });

  const mode = body.mode === 'owner' ? 'owner' : 'customer';
  const adminKey = req.headers['x-admin-key'] || '';
  if (mode === 'owner') {
    if (!adminKey) return res.status(401).json({ error: 'Admin key required' });
    const v = await post(API.admin, { action: 'verify' }, { 'X-Admin-Key': adminKey }, 15000);
    if (v.status === 401 || v.status === 403) return res.status(401).json({ error: 'Admin key rejected' });
  }

  try {
    const out = await runAgent({
      mode, message, history: body.history, context: body.context, sessionId: String(body.sessionId || '').slice(0, 80),
      testMode: !!body.testMode, adminKey, attribution: body.attribution && typeof body.attribution === 'object' ? body.attribution : null
    });
    if (out.debug.length) console.warn('agent tool issues:', out.debug.join('; '));
    delete out.debug;
    return res.status(200).json(out);
  } catch (e) {
    console.error('agent error', e);
    return res.status(502).json({ error: 'agent_failed', reply: 'Sorry, I\'m having trouble right now. Please call or text ' + DEFAULT_SETTINGS.business.phone + ' or use the booking form.' });
  }
};

module.exports.runAgent = runAgent;
module.exports.runTool = runTool;
