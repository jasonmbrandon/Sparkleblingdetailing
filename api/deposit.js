// Deposit endpoint for the booking widget and the chat agent.
//   POST { action: 'quote', service, vehicleSize, addons[] }            -> { required, deposit, total, percent, policy }
//   POST { action: 'start', ...booking fields }                         -> { ok, url } (redirect the customer to url)
//   POST { action: 'status', sessionId }                                -> { paid, status: confirmed|processing|needs_reschedule|unpaid|expired, ... }
const D = require('./_deposit');
const { DEFAULT_SETTINGS } = require('./_defaults');

const ALLOWED = [/^https:\/\/(www\.)?sparkleblingdetailing\.com$/, /^https:\/\/[a-z0-9-]+\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  const okOrigin = ALLOWED.some(re => re.test(origin));
  if (okOrigin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (origin && !okOrigin) return res.status(403).json({ error: 'Origin not allowed' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const addons = Array.isArray(b.addons) ? b.addons : String(b.addons || '').split(',').filter(Boolean);

  try {
    if (b.action === 'quote') {
      const s = await D.getSettings(DEFAULT_SETTINGS);
      const q = D.quote(s, b.service, b.vehicleSize, addons);
      return res.status(200).json(q ? Object.assign({ ok: true, policy: D.POLICY }, q) : { ok: false, error: 'BAD_SERVICE' });
    }
    if (b.action === 'start') {
      const site = okOrigin ? origin : 'https://sparkleblingdetailing.com';
      const out = await D.startCheckout(Object.assign({}, b, { addons, source: b.source || 'Website' }), site, DEFAULT_SETTINGS);
      return res.status(out.ok ? 200 : 409).json(out);
    }
    if (b.action === 'status') {
      if (!/^cs_[A-Za-z0-9_]+$/.test(String(b.sessionId || ''))) return res.status(400).json({ error: 'bad session id' });
      return res.status(200).json(Object.assign({ ok: true }, await D.status(b.sessionId)));
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('deposit error', e);
    return res.status(502).json({ ok: false, error: 'DEPOSIT_FAILED', message: String(e.message || e).replace(/sk_[A-Za-z0-9_]+/g, '***') });
  }
};
