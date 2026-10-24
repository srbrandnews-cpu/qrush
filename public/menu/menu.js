/* Customer menu + order tracking screen. Opens straight from a table's QR code. */

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const tableToken = params.get('table') || '';

  const state = {
    restaurant: null,
    table: null,
    menu: [],
    cart: new Map(),      // itemId -> { item, qty }
    orders: [],           // open orders on this table
    socket: null,
    pushOn: false,
    booted: false,
  };

  /* ============================== BOOT ================================== */

  async function boot() {
    if (!tableToken) return fail('Is page ko table ke QR code se kholein.', 'QR code scan karke open karein');
    try {
      const data = await TN.api(`/api/public/menu?table=${encodeURIComponent(tableToken)}`, { noRedirect: true });
      state.restaurant = data.restaurant;
      state.table = data.table;
      state.menu = data.menu.filter((c) => c.items && c.items.length);

      $('r-name').textContent = data.restaurant.name;
      $('t-name').textContent = data.table.name;
      $('s-table').textContent = data.table.name;
      $('r-addr').textContent = data.restaurant.address || '';
      document.title = `${data.table.name} — ${data.restaurant.name}`;
      $('cs-table').textContent = `• ${data.table.name}`;

      renderCats();
      renderMenu();

      // Returning customer: keep their name/number handy (one less typing).
      const saved = savedCustomer();
      if (saved.name) $('co-name').value = saved.name;
      if (saved.phone) $('co-phone').value = saved.phone;

      showView('menu');
      connectSocket();
      restorePushState();

      // If the table already has open orders, surface them right away.
      if (data.activeOrders && data.activeOrders.length) {
        await refreshOrders();
        if (state.orders.length) {
          renderStatus();
          showView('status');
        }
      }
    } catch (err) {
      fail(err.message, 'Menu unavailable');
    }
  }

  function fail(msg, title) {
    $('boot-msg').textContent = msg;
    $('boot').innerHTML = `<div style="font-size:44px">😕</div>
      <h2 style="margin:0">${TN.escapeHtml(title || 'Error')}</h2>
      <p class="muted">${TN.escapeHtml(msg)}</p>
      <button class="btn" onclick="location.reload()">Try again</button>`;
  }

  function showView(name) {
    $('boot').classList.add('hidden');
    $('view-menu').classList.toggle('hidden', name !== 'menu');
    $('view-status').classList.toggle('hidden', name !== 'status');
    window.scrollTo(0, 0);
  }

  /* ============================== MENU ================================== */

  function renderCats() {
    const nav = $('cats');
    nav.innerHTML = '';
    state.menu.forEach((cat, i) => {
      const btn = document.createElement('button');
      btn.className = 'cat' + (i === 0 ? ' active' : '');
      btn.textContent = cat.name;
      btn.dataset.target = 'sec-' + i;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cat').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        const el = $('sec-' + i);
        if (el) window.scrollTo({ top: el.offsetTop - 118, behavior: 'smooth' });
      });
      nav.appendChild(btn);
    });
  }

  function renderMenu() {
    const host = $('menu-list');
    host.innerHTML = '';
    if (!state.menu.length) {
      host.innerHTML = '<div class="empty"><div class="icon">🍽️</div><p>Menu abhi available nahi hai.</p></div>';
      return;
    }
    const currency = state.restaurant.currency || '₹';

    state.menu.forEach((cat, i) => {
      const sec = document.createElement('section');
      sec.className = 'menu-section';
      sec.id = 'sec-' + i;
      sec.innerHTML = `<h2 class="section-title">${TN.escapeHtml(cat.name)}</h2>`;
      cat.items.forEach((item) => sec.appendChild(renderItem(item, currency)));
      host.appendChild(sec);
    });
  }

  function renderItem(item, currency) {
    const el = document.createElement('div');
    el.className = 'item' + (item.is_available ? '' : ' unavailable');
    el.dataset.id = item.id;
    el.innerHTML = `
      <div class="item-body">
        <div class="item-top">
          <span class="veg-mark ${item.is_veg ? '' : 'nonveg'}" title="${item.is_veg ? 'Veg' : 'Non-veg'}"></span>
          <span class="item-name">${TN.escapeHtml(item.name)}</span>
        </div>
        ${item.description ? `<div class="item-desc">${TN.escapeHtml(item.description)}</div>` : ''}
        <div class="item-price">${currency}${Number(item.price).toLocaleString('en-IN')}</div>
        ${item.is_available ? '' : '<div class="item-north">Currently unavailable</div>'}
      </div>
      <div class="add-wrap"></div>`;
    if (item.is_available) updateAddControl(el.querySelector('.add-wrap'), item);
    return el;
  }

  function updateAddControl(wrap, item) {
    const qty = state.cart.get(item.id)?.qty || 0;
    if (!qty) {
      wrap.innerHTML = `<button class="add-btn">ADD</button>`;
      wrap.querySelector('.add-btn').addEventListener('click', () => changeQty(item, 1));
    } else {
      wrap.innerHTML = `
        <div class="qty">
          <button aria-label="decrease">−</button>
          <span>${qty}</span>
          <button aria-label="increase">＋</button>
        </div>`;
      const [minus, plus] = wrap.querySelectorAll('button');
      minus.addEventListener('click', () => changeQty(item, -1));
      plus.addEventListener('click', () => changeQty(item, 1));
    }
  }

  function changeQty(item, delta) {
    const current = state.cart.get(item.id);
    const newQty = (current ? current.qty : 0) + delta;
    if (newQty <= 0) state.cart.delete(item.id);
    else state.cart.set(item.id, { item, qty: Math.min(20, newQty) });

    const row = document.querySelector(`.item[data-id="${item.id}"]`);
    if (row) updateAddControl(row.querySelector('.add-wrap'), item);
    updateCartBar();
  }

  function cartList() { return [...state.cart.values()]; }
  function cartCount() { return cartList().reduce((s, l) => s + l.qty, 0); }

  /* --------------------------- customer details -------------------------- */

  const CUST_KEY = 'tn_customer';

  function savedCustomer() {
    try { return JSON.parse(localStorage.getItem(CUST_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function rememberCustomer(name, phone) {
    try { localStorage.setItem(CUST_KEY, JSON.stringify({ name, phone })); } catch (_) { /* private mode */ }
  }

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function subtotal() {
    return cartList().reduce((s, l) => s + l.item.price * l.qty, 0);
  }
  function gstAmount() {
    const pct = Number(state.restaurant && state.restaurant.gst_percent) || 0;
    return Math.round((subtotal() * pct) / 100 * 100) / 100;
  }
  function total() { return Math.round((subtotal() + gstAmount()) * 100) / 100; }

  function updateCartBar() {
    const n = cartCount();
    $('cart-bar').classList.toggle('hidden', n === 0);
    $('cart-count').textContent = n;
    $('cart-total').textContent = TN.fmtMoney(total(), state.restaurant.currency);
  }

  function billHtml() {
    const c = state.restaurant.currency || '₹';
    const pct = Number(state.restaurant && state.restaurant.gst_percent) || 0;
    let html = `
      <div class="row-line"><span>Subtotal (${cartCount()} items)</span><span>${TN.fmtMoney(subtotal(), c)}</span></div>`;
    if (pct > 0) {
      html += `<div class="row-line"><span>GST (${pct}%)</span><span>${TN.fmtMoney(gstAmount(), c)}</span></div>`;
    }
    html += `<div class="row-line total"><span>Total</span><span>${TN.fmtMoney(total(), c)}</span></div>`;
    return html;
  }

  /* =============================== CART ================================= */

  $('cart-open').addEventListener('click', openCart);
  $('cart-close').addEventListener('click', () => $('cart-sheet').classList.add('hidden'));
  $('cart-sheet').addEventListener('click', (e) => { if (e.target.id === 'cart-sheet') $('cart-sheet').classList.add('hidden'); });

  function openCart() {
    renderCart();
    $('cart-sheet').classList.remove('hidden');
  }

  function renderCart() {
    const host = $('cart-items');
    const c = state.restaurant.currency || '₹';
    if (!state.cart.size) {
      host.innerHTML = '<div class="empty"><div class="icon">🛒</div><p>Your cart is empty.</p></div>';
    } else {
      host.innerHTML = '';
      cartList().forEach(({ item, qty }) => {
        const row = document.createElement('div');
        row.className = 'line-item';
        row.innerHTML = `
          <span class="veg-mark ${item.is_veg ? '' : 'nonveg'}"></span>
          <div class="grow">
            <div class="line-name">${TN.escapeHtml(item.name)}</div>
            <div class="line-price">${TN.fmtMoney(item.price, c)} each</div>
          </div>
          <div class="qty">
            <button data-d="-1">−</button><span>${qty}</span><button data-d="1">＋</button>
          </div>
          <div style="width:74px;text-align:right;font-weight:700">${TN.fmtMoney(item.price * qty, c)}</div>`;
        row.querySelectorAll('.qty button').forEach((b) =>
          b.addEventListener('click', () => {
            changeQty(item, Number(b.dataset.d));
            renderCart();
          }));
        host.appendChild(row);
      });
    }
    $('cart-bill').innerHTML = billHtml();
    $('to-checkout').disabled = !state.cart.size;
  }

  $('to-checkout').addEventListener('click', () => {
    $('cart-sheet').classList.add('hidden');
    $('checkout-bill').innerHTML = billHtml();
    $('checkout-sheet').classList.remove('hidden');
  });
  $('checkout-close').addEventListener('click', () => $('checkout-sheet').classList.add('hidden'));
  $('checkout-sheet').addEventListener('click', (e) => { if (e.target.id === 'checkout-sheet') $('checkout-sheet').classList.add('hidden'); });

  /* ============================ PLACE ORDER ============================= */

  $('place-order').addEventListener('click', async () => {
    if (!state.cart.size) return;

    const name = $('co-name').value.trim();
    const phone = digitsOnly($('co-phone').value);
    if (phone.length < 10) {
      TN.toast('Mobile number daalein — isi number se bill banega', 'error');
      $('co-phone').focus();
      return;
    }

    const btn = $('place-order');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Placing order…';

    try {
      // Turn on notifications first (best moment to ask — before the order).
      if ($('co-notify').checked) {
        try { await enablePush(); } catch (_) { /* non-blocking */ }
      }

      const payload = {
        table: tableToken,
        deviceId: TN.deviceId(),
        customerName: name || null,
        customerPhone: phone,
        notes: $('co-notes').value.trim() || null,
        items: cartList().map(({ item, qty }) => ({ item_id: item.id, qty })),
      };
      const res = await TN.api('/api/public/orders', { body: payload, noRedirect: true });

      rememberCustomer(name, phone);
      state.cart.clear();
      updateCartBar();
      $('checkout-sheet').classList.add('hidden');

      await refreshOrders();
      renderStatus();
      showView('status');
      TN.toast(`Order #${res.order.order_no} placed!`, 'success');
    } catch (err) {
      TN.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  });

  /* ============================== STATUS ================================ */

  async function refreshOrders() {
    try {
      const res = await TN.api(`/api/public/tables/${encodeURIComponent(tableToken)}/orders`, { noRedirect: true });
      state.orders = res.orders || [];
    } catch (_) { /* keep previous */ }
  }

  const EMOJI = { placed: '📨', accepted: '👍', preparing: '👨‍🍳', ready: '🔔', served: '🍽️', paid: '💳', cancelled: '❌' };
  const HEADLINE = {
    placed: 'Order mil gaya', accepted: 'Kitchen ne accept kar liya', preparing: 'Aapka khana ban raha hai',
    ready: 'Order ready hai!', served: 'Order table par serve ho gaya', paid: 'Payment ho gaya', cancelled: 'Order cancel ho gaya',
  };
  const SUBTEXT = {
    placed: 'Kitchen jaldi hi shuru karega.', accepted: 'Thodi der mein banana shuru honge.',
    preparing: 'Bas kuch hi minutes… ready hote hi notification aayegi.',
    ready: 'Server aapke table par lane wala hai.', served: 'Enjoy your meal!', paid: 'Dhanyavaad!', cancelled: '',
  };

  function renderStatus() {
    const host = $('status-cards');
    host.innerHTML = '';
    const c = state.restaurant.currency || '₹';
    const currencySym = c;

    if (!state.orders.length) {
      host.innerHTML = '<div class="empty"><div class="icon">🍽️</div><p>Koi active order nahi.</p></div>';
      return;
    }

    state.orders.forEach((order) => {
      const card = document.createElement('div');
      card.className = 'order-card';
      card.dataset.id = order.id;
      const isReady = order.status === 'ready';
      const isCancelled = order.is_cancelled;

      const stepsHtml = isCancelled ? '' : `
        <div class="progress">
          ${order.progress.steps.map((s) => `
            <div class="pstep ${s.done ? 'done' : ''} ${s.current ? 'current' : ''}">
              <div class="pbar"></div>
              <div class="pin">${s.done ? '✓' : ''}</div>
              <div class="plabel">${s.label}</div>
            </div>`).join('')}
        </div>`;

      card.innerHTML = `
        <div class="order-card-head ${isReady ? 'ready-flash' : ''}">
          <span class="no">Order #${order.order_no}</span>
          <span class="badge ${order.status}">${order.status_label || order.status}</span>
        </div>
        <div class="big-status">
          <div class="emoji">${EMOJI[order.status] || '🍽️'}</div>
          <h2>${HEADLINE[order.status] || ''}</h2>
          ${isCancelled ? '' : `<p>${SUBTEXT[order.status] || ''}</p>`}
        </div>
        <div class="order-card-body">
          ${isCancelled ? '<div class="cancelled-note">Yeh order cancel kar diya gaya hai.</div>' : stepsHtml}
          <div class="order-items-mini">
            ${order.items.map((it) => `<div><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currencySym)}</span></div>`).join('')}
            <div style="border-top:1px dashed var(--line);margin-top:6px;padding-top:6px;font-weight:700;color:var(--ink)">
              <span>Total</span><span>${TN.fmtMoney(order.total, currencySym)}</span>
            </div>
            ${order.payment_status === 'paid'
              ? '<div style="color:var(--green);font-weight:700;margin-top:6px">✓ Paid</div>'
              : '<div style="margin-top:6px" class="tiny muted">💳 Pay at cash counter</div>'}
          </div>
        </div>`;
      host.appendChild(card);
    });
  }

  $('btn-back-menu').addEventListener('click', () => showView('menu'));

  /* ============================== SOCKET ================================ */

  function connectSocket() {
    if (typeof io === 'undefined') return; // socket client not loaded; polling still works
    state.socket = io({ query: { tableToken } });

    state.socket.on('order:update', async ({ order }) => {
      if (!order || order.table_token !== tableToken) return;
      const wasReady = state.orders.find((o) => o.id === order.id && o.status === 'ready');
      await refreshOrders();
      if ($('view-status').classList.contains('hidden') === false) renderStatus();

      // Big celebration the moment the kitchen marks it ready.
      if (order.status === 'ready' && !wasReady) celebrate(order);
      // A brand-new order placed from another phone on the same table.
      if (order.status === 'placed' && !wasReady && $('view-menu').classList.contains('hidden')) {
        await refreshOrders(); renderStatus(); showView('status');
      }
    });

    state.socket.on('connect_error', () => { /* silent; will auto-retry */ });
  }

  function celebrate(order) {
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.innerHTML = `
      <div class="big">🎉🍽️</div>
      <h2>Order #${order.order_no} ready hai!</h2>
      <p>Table ${order.table_name} par serve ke liye taiyar. Server aa raha hai.</p>
      <button>Thik hai</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
    // Also vibrate if the device supports it.
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  }

  /* =============================== PUSH ================================= */

  function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      TN.toast('Is browser mein push notification support nahi hai', 'error');
      return false;
    }
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      TN.toast('Notification permission denied', 'error');
      return false;
    }
    const { publicKey } = await TN.api('/api/push/vapid-public-key', { noRedirect: true });
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(publicKey),
    });
    await TN.api('/api/push/subscribe', {
      body: { table: tableToken, deviceId: TN.deviceId(), subscription: sub.toJSON() },
      noRedirect: true,
    });
    state.pushOn = true;
    setBell(true);
    return true;
  }

  async function restorePushState() {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { state.pushOn = true; setBell(true); }
    } catch (_) { /* ignore */ }
  }

  function setBell(on) {
    [ $('bell'), $('s-bell') ].forEach((b) => {
      if (!b) return;
      b.classList.toggle('on', on);
      b.title = on ? 'Notifications enabled' : 'Enable order notifications';
    });
  }

  async function onBell() {
    if (state.pushOn) { TN.toast('Notifications already enabled ✅', 'success'); return; }
    const ok = await enablePush();
    if (ok) TN.toast('Ready! Order updates aapke phone par aayengi.', 'success');
  }
  $('bell').addEventListener('click', onBell);
  $('s-bell').addEventListener('click', onBell);

  /* ============================== START ================================= */

  boot();
})();
