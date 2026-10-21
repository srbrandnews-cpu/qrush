/* Cash counter — serve orders and collect payments. */

(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS = ['placed', 'accepted', 'preparing', 'ready', 'served', 'paid', 'cancelled'];

  let orders = [];
  let currency = '₹';
  let tab = 'active';
  let role = 'cashier';
  let paying = null;   // order currently in the payment modal
  let method = 'cash';

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
    connect();
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

  /* -------------------------------- render ------------------------------- */
  function visible() {
    if (tab === 'active') return orders.filter((o) => o.status === 'ready' || o.status === 'served');
    if (tab === 'paid') return orders.filter((o) => o.status === 'paid');
    return orders;
  }

  function render() {
    const host = $('list');
    host.innerHTML = '';
    const list = visible().sort((a, b) => b.id - a.id);

    list.forEach((o) => host.appendChild(card(o)));
    $('empty').classList.toggle('hidden', list.length > 0);
  }

  function card(o) {
    const el = document.createElement('div');
    el.className = 'ccard';
    const mins = TN.minutesSince(o.created_at);

    let actions = '';
    if (o.status === 'ready' && role !== 'kitchen') {
      actions = `<button class="btn btn-primary" data-act="served">🍽️ Mark served</button>`;
    } else if (o.status === 'served') {
      actions = `<button class="btn btn-success" data-act="pay">💰 Collect ${TN.fmtMoney(o.total, currency)}</button>`;
    }

    let billRows = o.items.map((it) =>
      `<div class="row-line"><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currency)}</span></div>`).join('');
    billRows += `<div class="row-line total"><span>Total</span><span>${TN.fmtMoney(o.total, currency)}</span></div>`;

    el.innerHTML = `
      <div class="ccard-head">
        <span class="ccard-no">#${o.order_no}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <span class="ccard-table">${TN.escapeHtml(o.table_name)}</span>
          <span class="badge ${o.status}">${o.status}</span>
        </span>
      </div>
      <div class="ccard-body">
        <div class="ccard-meta">
          <span>⏱ ${mins} min</span>
          ${o.customer_name ? `<span>👤 ${TN.escapeHtml(o.customer_name)}</span>` : ''}
          ${o.payment_status === 'paid' && o.payment_method ? `<span class="paid-tag">✓ ${o.payment_method.toUpperCase()}</span>` : ''}
        </div>
        <div class="bill">${billRows}</div>
      </div>
      ${actions ? `<div class="ccard-actions">${actions}</div>` : ''}`;

    const actBtn = el.querySelector('[data-act]');
    if (actBtn) {
      actBtn.addEventListener('click', () => {
        if (actBtn.dataset.act === 'served') advance(o.id, 'served');
        else openPay(o);
      });
    }
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

  /* ------------------------------ payment modal -------------------------- */
  function openPay(o) {
    paying = o;
    method = 'cash';
    $('pm-order').textContent = `#${o.order_no} • ${o.table_name}`;
    $('pm-bill').innerHTML = o.items.map((it) =>
      `<div class="row-line"><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currency)}</span></div>`).join('')
      + `<div class="row-line total"><span>Amount due</span><span>${TN.fmtMoney(o.total, currency)}</span></div>`;
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
    const id = paying.id;
    const btn = $('pm-confirm');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      await advance(id, 'paid', { payment_method: method });
      closePay();
      TN.toast('Payment collected ✅', 'success');
    } catch (_) { /* toast shown in advance */ }
    finally { btn.disabled = false; btn.textContent = 'Confirm payment'; }
  });

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
    const socket = io({ auth: { token: TN.getToken() } });
    socket.on('connect', () => { $('conn').className = 'conn live'; refresh(); });
    socket.on('disconnect', () => { $('conn').className = 'conn off'; $('conn').innerHTML = '<span class="dot"></span> Offline'; });
    socket.on('order:update', () => { refresh(); loadStats(); });
  }

  $('logout').addEventListener('click', () => TN.logout());
  setInterval(refresh, 45000);

  load().catch((err) => { if (err.status !== 401) TN.toast(err.message, 'error'); });
})();
