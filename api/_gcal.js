// Direct Google Calendar access for the owner assistant (not a public endpoint).
// Uses a Google service account; Joe shares his calendar with the service account's email.
//
// Vercel environment variables:
//   GOOGLE_SERVICE_ACCOUNT_JSON  (required) the whole JSON key file of the service account, pasted as the value
//   SB_CALENDAR_ID               (optional) default: sparkleandblingautodetailing@gmail.com
const crypto = require('crypto');

const CAL_ID = process.env.SB_CALENDAR_ID || 'sparkleandblingautodetailing@gmail.com';
const TZ = 'America/Los_Angeles';
let tokenCache = { token: null, exp: 0 };

// Reads the first complete {...} in the value, so a key pasted twice or with stray text after it still works.
function firstJsonObject(raw) {
  const s = String(raw).trim().replace(/^﻿/, '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON does not contain a JSON key');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is incomplete; paste the whole key file');
}

function account() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set in Vercel');
  const j = firstJsonObject(raw);
  return { email: j.client_email, key: String(j.private_key || '').replace(/\\n/g, '\n') };
}
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function token() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const { email, key } = account();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google sign-in failed: ' + (d.error_description || d.error || r.status));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return d.access_token;
}

async function api(method, path, body) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(CAL_ID) + path, {
    method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error('Calendar not found. Joe must share his calendar with ' + account().email + ' ("Make changes to events").');
  if (!r.ok) throw new Error('Google Calendar ' + r.status + ': ' + ((d.error && d.error.message) || 'request failed'));
  return d;
}

// Offset like "-08:00" for a given local date in Pacific time (handles daylight saving).
function pacificOffset(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value; // "GMT-8"
  const m = name.match(/GMT([+-])(\d+)(?::(\d+))?/);
  return m ? m[1] + String(m[2]).padStart(2, '0') + ':' + String(m[3] || '00').padStart(2, '0') : '-08:00';
}
const dayStart = d => d + 'T00:00:00' + pacificOffset(d);
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

function fmt(ev) {
  const allDay = !!(ev.start && ev.start.date);
  const s = allDay ? ev.start.date : ev.start && ev.start.dateTime;
  const e = allDay ? ev.end.date : ev.end && ev.end.dateTime;
  const label = allDay ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) + ' (all day)'
    : new Date(s).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' - ' + new Date(e).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return { id: ev.id, title: ev.summary || '(no title)', when: label, start: s, end: e, allDay, location: ev.location || '', notes: String(ev.description || '').slice(0, 300) };
}

async function listEvents(dateFrom, dateTo) {
  const d = await api('GET', '/events?singleEvents=true&orderBy=startTime&maxResults=100&timeZone=' + TZ +
    '&timeMin=' + encodeURIComponent(dayStart(dateFrom)) + '&timeMax=' + encodeURIComponent(dayStart(addDays(dateTo, 1))));
  return (d.items || []).filter(e => e.status !== 'cancelled').map(fmt);
}

// { title, date: 'YYYY-MM-DD', startTime: 'HH:MM' (24h), endTime: 'HH:MM', allDay, endDate, location, notes }
async function createEvent(e) {
  const body = { summary: e.title, location: e.location || undefined, description: [e.notes, 'Added by the website assistant'].filter(Boolean).join('\n') };
  if (e.allDay) { body.start = { date: e.date }; body.end = { date: addDays(e.endDate || e.date, 1) }; }
  else {
    body.start = { dateTime: e.date + 'T' + e.startTime + ':00', timeZone: TZ };
    body.end = { dateTime: (e.endDate || e.date) + 'T' + e.endTime + ':00', timeZone: TZ };
  }
  return fmt(await api('POST', '/events', body));
}

module.exports = { listEvents, createEvent, CAL_ID, serviceEmail: () => { try { return account().email; } catch (e) { return null; } } };
