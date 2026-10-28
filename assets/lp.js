// Quote form for the Henderson-area landing pages. Sends a lead to n8n Lead Intake (Leads sheet).
(function () {
  var f = document.getElementById('quoteForm');
  if (!f) return;
  var tiers = window.SB_TIERS || [];
  var msg = document.getElementById('formMsg');
  var est = document.getElementById('estimate');
  var credit = Number(f.dataset.credit) || 0;
  var money = function (n) { return '$' + Number(n).toLocaleString('en-US'); };

  // "Quote this package" buttons preselect the package.
  document.querySelectorAll('.tier-btn').forEach(function (b) {
    b.addEventListener('click', function () { f.service.value = b.dataset.tier; showEstimate(); });
  });

  function priceFor() {
    var t = tiers.filter(function (x) { return x.key === f.service.value; })[0];
    return t && f.vehicleSize.value ? { name: t.name, price: t.prices[f.vehicleSize.value] } : null;
  }
  function showEstimate() {
    var p = priceFor();
    if (!p) { est.classList.add('hidden'); return; }
    est.innerHTML = 'Estimated: <strong class="text-gold-400">' + money(p.price - credit) + '</strong> for the ' + p.name +
      ' after your ' + money(credit) + ' new-client credit (list ' + money(p.price) + '). Final price is confirmed after we see the paint.';
    est.classList.remove('hidden');
  }
  f.service.addEventListener('change', showEstimate);
  f.vehicleSize.addEventListener('change', showEstimate);

  function setMsg(text, ok) { msg.textContent = text; msg.className = 'sm:col-span-2 text-center text-sm ' + (ok ? 'text-emerald-400' : 'text-red-400'); }

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    if (f.website.value) { setMsg('Thanks! We\'ll be in touch.', true); return; } // spam trap
    var digits = f.phone.value.replace(/\D/g, '');
    var missing = [];
    if (!f.name.value.trim()) missing.push('name');
    if (digits.length < 10) missing.push('a valid mobile number');
    if (!f.vehicle.value.trim()) missing.push('vehicle');
    if (!f.vehicleSize.value) missing.push('vehicle size');
    if (missing.length) { setMsg('Please add ' + missing.join(', ') + '.', false); return; }

    var tier = tiers.filter(function (x) { return x.key === f.service.value; })[0];
    var p = priceFor();
    var payload = {
      type: 'request',
      source: 'Henderson LP – ' + f.dataset.city,
      name: f.name.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(),
      service: f.service.value || 'ceramic', serviceLabel: tier ? tier.name : 'Ceramic coating (needs recommendation)',
      vehicleSize: f.vehicleSize.value, vehicle: f.vehicle.value.trim(),
      city: f.area.value.trim() || f.dataset.city, when: f.timeframe.value,
      estimate: p ? p.price : '',
      notes: ['Ceramic quote request (Henderson area)', 'Work location: ' + f.location.value, f.notes.value.trim()].filter(Boolean).join(' | '),
      sessionId: 'lp_' + f.dataset.slug
    };
    var btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch(f.dataset.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); })
      .then(function () {
        f.reset(); f.area.value = f.dataset.city; showEstimate();
        btn.textContent = 'Request sent ✓';
        setMsg('Got it, ' + payload.name.split(' ')[0] + '! We\'ll text you at ' + payload.phone + ' with your quote and open dates.', true);
        if (window.gtag) window.gtag('event', 'generate_lead', { source: payload.source });
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Send My Free Quote Request';
        setMsg('Sorry, that didn\'t go through. Please call or text us at the number below.', false);
      });
  });
})();
