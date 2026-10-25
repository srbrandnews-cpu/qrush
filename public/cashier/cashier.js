/* Cash counter — one bill per table + customer phone, serve and collect. */

(() => {
  const $ = (id) => document.getElementById(id);
  const CLOSED = ['paid', 'cancelled'];

  let orders = [];
  let currency = '₹';
  let tab = 'active';
  let role = 'cashier';
  let paying = null;   // bill currently in the payment modal
  let method = 'cash';
  let requests = [];

  /* --------------------------------- load -------------------------------- */
  async function load() {
    const me = await TN.fetchMe();
    role = me.user.role;
    if (role === 'kitchen') { window.location.href = '/kitchen'; return; }
    currency = (me.tenant && me.tenant.currency) || '₹';
    $('r-name').textContent = me.tenant ? me.tenant.name : '';
    $('me').textContent = (me.user.name || 'C').charAt(0).toUpperCase();

    await refresh();
    await loadStats();
    await refreshRequests();
    connect();
    setInterval(refreshRequests, 20000);
  }

  async function refresh() {
    try {
      const data = await TN.api('/api/orders?board=all&limit=300');
      orders = data.orders || [];
      render();
    } catch (err) { console.error(err); }
  }

  async function loadStats() {
    try {
      const s = await TN.api('/api/orders/stats');
      $('st-open').textContent = s.openNow;
      $('st-orders').textContent = s.today.orders_today;
      $('st-items').textContent = s.today.items_today + ' items';
      const collected = orders.filter((o) => o.status === 'paid' && isToday(o.created_at))
        .reduce((sum, o) => sum + o.total, 0);
      const toCollect = orders.filter((o) => o.status === 'served')
        .reduce((sum, o) => sum + o.total, 0);
      $('st-collected').textContent = TN.fmtMoney(collected, currency);
      $('st-tocollect').textContent = TN.fmtMoney(toCollect, currency);
      $('today-total').textContent = TN.fmtMoney(collected, currency);
    } catch (err) { console.error(err); }
  }

  function isToday(sql) {
    return sql && sql.slice(0, 10) === new Date().toISOString().slice(0, 10);
  }

  /* -------------------------------- bills -------------------------------- */
  /* Orders from the same table AND same phone make one bill. A second phone
     on the same table is a separate bill ("Table 1" vs "Table 1A"). */

  function buildBills(list) {
    const map = new Map();
    for (const o of list) {
      const key = `${o.table_id}|${o.bill_key || 'order:' + o.id}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          table_name: o.table_name,
          label: o.bill_label || o.table_name,
          phone: o.customer_phone || null,
          name: o.customer_name || null,
          orders: [],
          total: 0,
          latestId: o.id,
        });
      }
      const bill = map.get(key);
      bill.orders.push(o);
      bill.total = Math.round((bill.total + Number(o.total || 0)) * 100) / 100;
      if (!bill.phone && o.customer_phone) bill.phone = o.customer_phone;
      if (!bill.name && o.customer_name) bill.name = o.customer_name;
      if (o.id > bill.latestId) bill.latestId = o.id;
    }
    return [...map.values()];
  }

  function billsForTab() {
    const bills = buildBills(orders);
    if (tab === 'active') {
      return bills.filter((b) => b.orders.some((o) => o.status === 'ready' || o.status === 'served'));
    }
    if (tab === 'paid') {
      return bills.filter((b) =>
        b.orders.some((o) => o.status === 'paid') && b.orders.every((o) => CLOSED.includes(o.status)));
    }
    return bills;
  }

  /* -------------------------------- render ------------------------------- */
  function render() {
    const host = $('list');
    host.innerHTML = '';
    const bills = billsForTab().sort((a, b) => b.latestId - a.latestId);

    bills.forEach((bill) => host.appendChild(card(bill)));
    $('empty').classList.toggle('hidden', bills.length > 0);
  }

  function card(bill) {
    const el = document.createElement('div');
    el.className = 'ccard';

    const inBill = bill.orders.slice().sort((a, b) => a.id - b.id);
    const ready = inBill.filter((o) => o.status === 'ready');
    const served = inBill.filter((o) => o.status === 'served');
    const mins = TN.minutesSince(inBill[0].created_at);

    let actions = '';
    if (ready.length) {
      actions += `<button class="btn btn-primary" data-act="serve">🍽️ Mark served</button>`;
    }
    if (served.length) {
      const due = Math.round(served.reduce((s, o) => s + Number(o.total || 0), 0) * 100) / 100;
      actions += `<button class="btn btn-success" data-act="pay">💰 Collect ${TN.fmtMoney(due, currency)}</button>`;
    }

    const billRows = inBill.map((o) => {
      const items = o.items.map((it) =>
        `<div class="row-line"><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currency)}</span></div>`).join('');
      return `<div class="bill-order">
          <div class="row-line tiny muted"><span>#${o.order_no} • ${o.status}</span><span></span></div>
          ${items}
        </div>`;
    }).join('');

    const badges = [...new Set(inBill.map((o) => o.status))]
      .map((s) => `<span class="badge ${s}">${s}</span>`).join('');

    el.innerHTML = `
      <div class="ccard-head">
        <span class="ccard-no">${TN.escapeHtml(bill.label)}</span>
        <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${badges}</span>
      </div>
      <div class="ccard-body">
        <div class="ccard-meta">
          <span>⏱ ${mins} min</span>
          ${bill.name ? `<span>👤 ${TN.escapeHtml(bill.name)}</span>` : ''}
          <span>📞 ${bill.phone ? TN.escapeHtml(bill.phone) : '—'}</span>
          ${inBill.some((o) => o.payment_status === 'paid' && o.payment_method)
            ? `<span class="paid-tag">✓ ${inBill.filter((o) => o.payment_method).pop().payment_method.toUpperCase()}</span>` : ''}
        </div>
        <div class="bill">${billRows}
          <div class="row-line total"><span>Bill total</span><span>${TN.fmtMoney(bill.total, currency)}</span></div>
        </div>
      </div>
      ${actions ? `<div class="ccard-actions">${actions}</div>` : ''}`;

    const serveBtn = el.querySelector('[data-act="serve"]');
    if (serveBtn) serveBtn.addEventListener('click', () => serveAll(ready, serveBtn));

    const payBtn = el.querySelector('[data-act="pay"]');
    if (payBtn) payBtn.addEventListener('click', () => openPay(bill));

    return el;
  }

  /* ----------------------------- transitions ----------------------------- */
  async function advance(orderId, to, extra = {}) {
    try {
      await TN.api(`/api/orders/${orderId}/transition`, { body: Object.assign({ to }, extra) });
      await refresh();
      await loadStats();
    } catch (err) {
      TN.toast(err.message, 'error');
    }
  }

  /** Mark every ready order in the bill as served. */
  async function serveAll(readyOrders, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Serving…';
    for (const o of readyOrders) await advance(o.id, 'served');
    TN.toast('Bill served ✅', 'success');
    btn.disabled = false;
    btn.textContent = '🍽️ Mark served';
  }

  /* ------------------------------ payment modal -------------------------- */
  function openPay(bill) {
    paying = bill;
    method = 'cash';

    const due = bill.orders.filter((o) => o.status === 'served');
    const amount = Math.round(due.reduce((s, o) => s + Number(o.total || 0), 0) * 100) / 100;
    const lines = due.flatMap((o) => o.items.map((it) =>
      `<div class="row-line"><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currency)}</span></div>`
    )).join('');

    $('pm-order').textContent = `${bill.label} • ${bill.phone || 'no phone'}`;
    $('pm-bill').innerHTML = lines
      + `<div class="row-line total"><span>Amount due</span><span>${TN.fmtMoney(amount, currency)}</span></div>`;
    document.querySelectorAll('.pm').forEach((b) => b.classList.toggle('active', b.dataset.m === 'cash'));
    $('pay-modal').classList.remove('hidden');
  }

  function closePay() { $('pay-modal').classList.add('hidden'); paying = null; }

  $('pm-close').addEventListener('click', closePay);
  $('pm-cancel').addEventListener('click', closePay);
  $('pay-modal').addEventListener('click', (e) => { if (e.target.id === 'pay-modal') closePay(); });

  document.querySelectorAll('.pm').forEach((b) =>
    b.addEventListener('click', () => {
      method = b.dataset.m;
      document.querySelectorAll('.pm').forEach((x) => x.classList.toggle('active', x === b));
    }));

  $('pm-confirm').addEventListener('click', async () => {
    if (!paying) return;
    const due = paying.orders.filter((o) => o.status === 'served');
    if (!due.length) return closePay();

    const btn = $('pm-confirm');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      // One bill may hold several orders — settle them together.
      for (const o of due) {
        await TN.api(`/api/orders/${o.id}/transition`, { body: { to: 'paid', payment_method: method } });
      }
      await refresh();
      await loadStats();
      closePay();
      TN.toast('Payment collected ✅', 'success');
    } catch (err) {
      TN.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm payment';
    }
  });

  /* --------------------------- service requests -------------------------- */
  const REQ_ICONS = { water: '💧', spoon: '🍴', bill: '🧾', ac: '❄️', waiter: '🙋' };
  const REQ_LABELS = { water: 'Water', spoon: 'Spoon', bill: 'Bill', ac: 'AC', waiter: 'Waiter' };

  async function refreshRequests() {
    try {
      const data = await TN.api('/api/requests?status=open');
      requests = data.requests || [];
      renderRequests();
    } catch (_) { /* keep previous */ }
  }

  function renderRequests() {
    const strip = $('req-strip');
    if (!strip) return;
    strip.classList.toggle('hidden', requests.length === 0);
    strip.innerHTML = '';
    requests.forEach((req) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'req-pill';
      btn.innerHTML = `<span class="ico">${REQ_ICONS[req.type] || '🔔'}</span>
        <span class="table">${TN.escapeHtml(req.table_name)}</span>
        <span>${REQ_LABELS[req.type] || req.type}</span>
        <span class="done">Done</span>`;
      btn.addEventListener('click', () => resolveRequest(req.id));
      strip.appendChild(btn);
    });
  }

  async function resolveRequest(id) {
    try {
      await TN.api(`/api/requests/${id}/resolve`, { method: 'PATCH' });
      await refreshRequests();
      TN.toast('Request done ✅', 'success');
    } catch (err) { TN.toast(err.message, 'error'); }
  }

  /* --------------------------------- tabs -------------------------------- */
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    render();
  });

  /* -------------------------------- socket ------------------------------- */
  function connect() {
    const token = TN.getToken();
    if (!token) return; // not logged in — no point connecting
    const socket = io({ auth: { token } });
    socket.on('unauthorized', () => {
      TN.toast('Session expire ho gaya — dobara login karein', 'error');
      setTimeout(() => { window.location.href = '/login?expired=1'; }, 900);
    });
    socket.on('connect', () => { $('conn').className = 'conn live'; refresh(); });
    socket.on('disconnect', () => { $('conn').className = 'conn off'; $('conn').innerHTML = '<span class="dot"></span> Offline'; });
    socket.on('order:update', () => { refresh(); loadStats(); });
    socket.on('request:new', ({ request }) => {
      if (!request) return;
      TN.toast(`${request.table_name} — ${REQ_LABELS[request.type] || request.type}`, '');
      if (navigator.vibrate) navigator.vibrate(120);
      refreshRequests();
    });
    socket.on('request:update', refreshRequests);
  }

  $('logout').addEventListener('click', () => TN.logout());
  setInterval(refresh, 45000);

  load().catch((err) => { if (err.status !== 401) TN.toast(err.message, 'error'); });
})();
