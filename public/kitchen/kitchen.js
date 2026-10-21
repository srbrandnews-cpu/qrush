/* Kitchen Display System — live order queue with sound alerts. */

(() => {
  const $ = (id) => document.getElementById(id);
  const STATUS = ['placed', 'accepted', 'preparing', 'ready'];

  // What the kitchen should advance an order to next.
  const NEXT = {
    placed:   { to: 'accepted',  label: 'Accept',            cls: 'accept' },
    accepted: { to: 'preparing', label: 'Start preparing',   cls: 'start'  },
    preparing:{ to: 'ready',     label: 'Mark ready',        cls: 'ready'  },
  };

  let orders = [];
  let role = 'kitchen';
  let soundOn = true;
  let audioCtx = null;

  /* ----------------------------- audio alert ----------------------------- */
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep() {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    // Two rising notes = "new order".
    [[880, 0], [1320, 0.18]].forEach(([freq, t]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.35, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.16);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(now + t); osc.stop(now + t + 0.2);
    });
  }
  document.addEventListener('click', ensureAudio, { once: true });

  /* ------------------------------- loading ------------------------------- */
  async function load() {
    const data = await TN.fetchMe();
    role = data.user.role;
    if (role === 'cashier') { window.location.href = '/cashier'; return; }
    $('r-name').textContent = data.tenant ? data.tenant.name : '';
    $('me').textContent = (data.user.name || 'K').charAt(0).toUpperCase();
    await refresh();
    connect();
    setInterval(tickTimers, 20000);
  }

  async function refresh() {
    try {
      const data = await TN.api('/api/orders?board=open&limit=200');
      const known = new Set(orders.map((o) => o.id));
      orders = data.orders || [];
      // Any order we had not seen before is "fresh" (triggers flash + sound).
      orders.forEach((o) => { if (!known.has(o.id) && known.size > 0) o._fresh = true; });
      render();
    } catch (err) { console.error(err); }
  }

  /* ------------------------------- render -------------------------------- */
  function render() {
    const byStatus = Object.fromEntries(STATUS.map((s) => [s, []]));
    orders.forEach((o) => { if (byStatus[o.status]) byStatus[o.status].push(o); });

    STATUS.forEach((s) => {
      $('cnt-' + s).textContent = byStatus[s].length;
      const body = $('col-' + s);
      body.innerHTML = '';
      // Oldest first within each column so the kitchen works FIFO.
      byStatus[s].sort((a, b) => a.id - b.id).forEach((o) => body.appendChild(card(o)));
      if (!byStatus[s].length) {
        body.innerHTML = '<div class="col-empty">—</div>';
      }
    });

    $('empty').classList.toggle('hidden', orders.length > 0);
    document.querySelector('.board').classList.toggle('hidden', orders.length === 0);

    // Play the alert once per batch of new orders.
    if (orders.some((o) => o._fresh)) {
      beep();
      orders.forEach((o) => delete o._fresh);
    }
  }

  function card(o) {
    const el = document.createElement('div');
    el.className = 'ocard' + (o._fresh ? ' fresh' : '');
    el.dataset.id = o.id;

    const mins = TN.minutesSince(o.created_at);
    const late = mins >= 20;

    let actions = '';
    const nx = NEXT[o.status];
    if (nx && (role === 'kitchen' || role === 'owner')) {
      actions += `<button class="kact ${nx.cls}" data-to="${nx.to}">${nx.label}</button>`;
    }
    if (role === 'owner' && ['placed', 'accepted', 'preparing'].includes(o.status)) {
      actions += `<button class="kact ghost" data-to="cancelled" title="Cancel order">✕</button>`;
    }

    el.innerHTML = `
      <div class="ocard-head">
        <span class="ocard-no">#${o.order_no}</span>
        <span class="ocard-table">${TN.escapeHtml(o.table_name)}</span>
      </div>
      <div class="ocard-time ${late ? 'late' : ''}">⏱ <span data-timer="${o.created_at}">${mins} min ago</span></div>
      ${o.customer_name ? `<div class="ocard-cust">👤 ${TN.escapeHtml(o.customer_name)}</div>` : ''}
      <div class="ocard-items">
        ${o.items.map((it) => `
          <div class="oitem">
            <span class="veg-mark ${it.is_veg ? '' : 'nonveg'}"></span>
            <span class="q">${it.qty}×</span>
            <span class="n">${TN.escapeHtml(it.name)}</span>
          </div>
          ${it.notes ? `<div class="ocard-notes">↳ ${TN.escapeHtml(it.notes)}</div>` : ''}`).join('')}
      </div>
      ${o.notes ? `<div class="ocard-notes">📝 ${TN.escapeHtml(o.notes)}</div>` : ''}
      ${actions ? `<div class="ocard-actions">${actions}</div>` : ''}`;

    el.querySelectorAll('.kact').forEach((btn) =>
      btn.addEventListener('click', () => advance(o.id, btn.dataset.to, btn)));
    return el;
  }

  function tickTimers() {
    document.querySelectorAll('[data-timer]').forEach((sp) => {
      const mins = TN.minutesSince(sp.dataset.timer);
      sp.textContent = `${mins} min ago`;
      sp.parentElement.classList.toggle('late', mins >= 20);
    });
  }

  /* ------------------------------ transitions ---------------------------- */
  async function advance(orderId, to, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    if (!btn.classList.contains('ghost')) btn.innerHTML = '<span class="spinner"></span>';
    try {
      await TN.api(`/api/orders/${orderId}/transition`, { body: { to } });
      await refresh();
      if (to === 'ready') TN.toast('Order marked ready ✅', 'success');
      if (to === 'cancelled') TN.toast('Order cancelled', 'error');
    } catch (err) {
      TN.toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  /* -------------------------------- socket ------------------------------- */
  function connect() {
    const token = TN.getToken();
    if (!token) return; // not logged in — no point connecting
    const socket = io({ auth: { token } });
    socket.on('unauthorized', () => {
      TN.toast('Session expire ho gaya — dobara login karein', 'error');
      setTimeout(() => { window.location.href = '/login?expired=1'; }, 900);
    });
    socket.on('connect', () => {
      $('conn').className = 'conn live';
      $('conn').innerHTML = '<span class="dot"></span> Live';
      refresh();
    });
    socket.on('disconnect', () => {
      $('conn').className = 'conn off';
      $('conn').innerHTML = '<span class="dot"></span> Offline — retrying…';
    });
    socket.on('order:update', refresh);
  }

  /* --------------------------------- misc -------------------------------- */
  $('sound').addEventListener('click', () => {
    soundOn = !soundOn;
    $('sound').textContent = soundOn ? '🔔 Sound' : '🔕 Muted';
    $('sound').classList.toggle('muted-on', !soundOn);
    if (soundOn) { ensureAudio(); beep(); }
  });
  $('logout').addEventListener('click', () => TN.logout());

  // Poll as a safety net (covers missed socket events / sleeping tabs).
  setInterval(refresh, 30000);

  load().catch((err) => { if (err.status !== 401) TN.toast(err.message, 'error'); });
})();
