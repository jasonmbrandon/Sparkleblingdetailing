// Stripe webhook: books the appointment once a deposit is paid.
// Stripe Dashboard -> Developers -> Webhooks -> Add endpoint:
//   URL: https://sparkleblingdetailing.com/api/stripe-webhook   Event: checkout.session.completed
// Security: we never trust the webhook body. We take only the session id and re-read the session from Stripe
// with our secret key, then book only if Stripe itself says it is paid (finalize). Booking happens once per payment.
const D = require('./_deposit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let evt = req.body || {};
  if (typeof evt === 'string') { try { evt = JSON.parse(evt); } catch (e) { evt = {}; } }
  const obj = (evt.data && evt.data.object) || {};
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type) || !/^cs_/.test(String(obj.id || ''))) {
    return res.status(200).json({ received: true, ignored: true });
  }
  try {
    const out = await D.finalize(obj.id);
    return res.status(200).json({ received: true, status: out.status });
  } catch (e) {
    console.error('stripe webhook error', e);
    return res.status(500).json({ error: 'finalize_failed' }); // Stripe retries automatically
  }
};
