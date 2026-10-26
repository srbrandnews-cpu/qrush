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
    fullMenu: false,
    reqBusy: new Set(),
  };

  let splashTimer = null;
  let splashGreeted = false;

  /* ============================== BOOT ================================== */

  async function boot() {
    if (!tableToken) return fail('Is page ko table ke QR code se kholein.', 'QR code scan karke open karein');
    try {
      // Send the saved phone + device so the server only returns this guest's
      // open bill — not the other diners' bills on the same table.
      const saved = savedCustomer();
      const qs = new URLSearchParams({ table: tableToken, deviceId: TN.deviceId() });
      if (saved.phone) qs.set('phone', saved.phone);
      const data = await TN.api(`/api/public/menu?${qs.toString()}`, { noRedirect: true });
      state.restaurant = data.restaurant;
      state.table = data.table;
      state.menu = data.menu.filter((c) => c.items && c.items.length);
      state.fullMenu = sessionStorage.getItem('tn_full_menu') === '1';

      $('r-name').textContent = data.restaurant.name;
      $('t-name').textContent = data.table.name;
      $('s-table').textContent = data.table.name;
      $('r-addr').textContent = data.restaurant.address || '';
      document.title = `${data.table.name} — ${data.restaurant.name}`;
      $('cs-table').textContent = `• ${data.table.name}`;

      renderCats();
      renderMenu();
      renderQuickRequests();
      renderInfo();

      // Returning customer: keep their name/number handy (one less typing).
      if (saved.name) $('co-name').value = saved.name;
      if (saved.phone) $('co-phone').value = saved.phone;

      showView('menu');
      connectSocket();
      restorePushState();

      // A branded welcome note + spoken greeting greets every scan, before
      // anything else. The name prompt follows only for new guests.
      showWelcomeSplash(saved);

      // If this guest already has an open order, surface it right away.
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

  /**
   * Rush mode: during peak hours only quick items are shown, with a one-tap
   * switch back to the full menu. Falls back to the full menu if no item is
   * marked quick, so a venue can never end up with an empty menu.
   */
  function visibleMenu() {
    if (!state.restaurant || !Number(state.restaurant.rush_mode) || state.fullMenu) return state.menu;
    const quick = state.menu
      .map((c) => ({ ...c, items: c.items.filter((i) => Number(i.is_quick)) }))
      .filter((c) => c.items.length);
    return quick.length ? quick : state.menu;
  }

  function renderCats() {
    const nav = $('cats');
    nav.innerHTML = '';
    visibleMenu().forEach((cat, i) => {
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

    if (Number(state.restaurant.rush_mode)) {
      const banner = document.createElement('div');
      banner.className = 'rush-banner';
      banner.innerHTML = `
        <div><b>⚡ Rush menu</b><br><span class="tiny muted">Quick items only — kitchen is busy</span></div>
        <button>${state.fullMenu ? 'Rush menu' : 'Full menu'}</button>`;
      banner.querySelector('button').addEventListener('click', () => {
        state.fullMenu = !state.fullMenu;
        sessionStorage.setItem('tn_full_menu', state.fullMenu ? '1' : '0');
        renderCats();
        renderMenu();
        renderRepeatBar();
      });
      host.appendChild(banner);
    }

    visibleMenu().forEach((cat, i) => {
      const sec = document.createElement('section');
      sec.className = 'menu-section';
      sec.id = 'sec-' + i;
      sec.innerHTML = `<h2 class="section-title">${TN.escapeHtml(cat.name)}</h2>`;
      cat.items.forEach((item) => sec.appendChild(renderItem(item, currency)));
      host.appendChild(sec);
    });

    renderRepeatBar();
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

  /* --------------------------- my usual (repeat) ------------------------- */

  function menuItemById(id) {
    for (const cat of state.menu) {
      const item = cat.items.find((i) => i.id === Number(id));
      if (item) return item;
    }
    return null;
  }

  function lastOrderKey() { return 'tn_last_' + tableToken; }

  function lastOrder() {
    try { return JSON.parse(localStorage.getItem(lastOrderKey()) || 'null'); } catch (_) { return null; }
  }

  function saveLastOrder(items) {
    try {
      localStorage.setItem(lastOrderKey(), JSON.stringify({ items, at: Date.now() }));
    } catch (_) { /* private mode */ }
  }

  function renderRepeatBar() {
    document.querySelectorAll('.repeat-bar').forEach((el) => el.remove());
    const last = lastOrder();
    if (!last || !Array.isArray(last.items) || !last.items.length) return;
    const host = $('menu-list');
    if (!host) return;

    const bar = document.createElement('div');
    bar.className = 'repeat-bar';
    const qtyTotal = last.items.reduce((sum, line) => sum + (Number(line.qty) || 1), 0);
    bar.innerHTML = `
      <div><b>My usual</b><span class="tiny muted"> · ${qtyTotal} item${qtyTotal > 1 ? 's' : ''} from last time</span></div>
      <button type="button">＋ Add again</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      let added = 0;
      let skipped = 0;
      for (const line of last.items) {
        const item = menuItemById(line.item_id);
        if (item && item.is_available) {
          state.cart.set(item.id, { item, qty: Math.min(20, Number(line.qty) || 1) });
          added += 1;
        } else {
          skipped += 1;
        }
      }
      if (!added) { TN.toast('Last order ke items abhi available nahi hain', 'error'); return; }
      renderMenu();
      updateCartBar();
      TN.toast(skipped ? `${added} items added (${skipped} unavailable)` : 'Last order cart mein add ho gaya ✅', 'success');
    });
    const rushBanner = host.querySelector('.rush-banner');
    if (rushBanner) rushBanner.after(bar);
    else host.insertBefore(bar, host.firstChild);
  }

  /* --------------------------- quick requests ---------------------------- */

  const REQ_META = {
    water: { icon: '💧', label: 'Water' },
    spoon: { icon: '🍴', label: 'Spoon / tissue' },
    bill: { icon: '🧾', label: 'Bill' },
    ac: { icon: '❄️', label: 'AC' },
    waiter: { icon: '🙋', label: 'Waiter' },
  };
  const REQ_ORDER = ['water', 'spoon', 'bill', 'ac', 'waiter'];

  function renderQuickRequests() {
    if (!state.restaurant) return;
    $('req-wrap').style.display = '';
    const row = $('req-row');
    row.innerHTML = '';
    REQ_ORDER.forEach((type) => {
      const meta = REQ_META[type];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'req-chip';
      btn.dataset.type = type;
      btn.innerHTML = `<span class="ico">${meta.icon}</span><span class="lbl">${meta.label}</span>`;
      btn.addEventListener('click', () => sendQuickRequest(type, btn));
      row.appendChild(btn);
    });
  }

  async function sendQuickRequest(type, btn) {
    if (state.reqBusy.has(type)) return;
    state.reqBusy.add(type);
    btn.disabled = true;
    try {
      await TN.api('/api/public/requests', {
        body: { table: tableToken, type },
        noRedirect: true,
      });
      btn.classList.add('sent');
      btn.querySelector('.lbl').textContent = 'Sent ✓';
      $('req-status').textContent = 'Staff ko request chali gayi ✅';
      TN.toast('Request sent — staff ko turant dikh gaya ✅', 'success');
      if (navigator.vibrate) navigator.vibrate(80);
      setTimeout(() => {
        btn.classList.remove('sent');
        btn.disabled = false;
        btn.querySelector('.lbl').textContent = REQ_META[type].label;
        state.reqBusy.delete(type);
        $('req-status').textContent = 'One tap — staff ko turant dikhega';
      }, 20000);
    } catch (err) {
      btn.disabled = false;
      state.reqBusy.delete(type);
      TN.toast(err.message, 'error');
    }
  }

  /* ------------------------------- venue info ---------------------------- */

  function renderInfo() {
    const r = state.restaurant || {};
    const rows = [];
    if (state.table) rows.push({ k: 'You are at', v: state.table.name });
    if (r.wifi_name) {
      rows.push({
        k: 'WiFi',
        v: r.wifi_name + (r.wifi_password ? ' · ' + r.wifi_password : ''),
        copy: r.wifi_password || r.wifi_name,
      });
    }
    if (r.upi_id) rows.push({ k: 'Pay via UPI', v: r.upi_id, copy: r.upi_id });
    if (r.address) rows.push({ k: 'Address', v: r.address });
    if (r.phone) rows.push({ k: 'Call restaurant', v: r.phone, href: 'tel:' + String(r.phone).replace(/\s/g, '') });
    if (r.slug) rows.push({ k: 'Live wait time', v: 'View queue →', href: '/r/' + encodeURIComponent(r.slug) });

    $('info-list').innerHTML = rows.map((row) => `
      <div class="info-item">
        <div>
          <div class="k">${TN.escapeHtml(row.k)}</div>
          <div class="v">${row.href
            ? `<a href="${TN.escapeHtml(row.href)}">${TN.escapeHtml(row.v)}</a>`
            : TN.escapeHtml(row.v)}</div>
        </div>
        ${row.copy ? `<button class="info-copy" type="button" data-copy="${TN.escapeHtml(row.copy)}">Copy</button>` : ''}
      </div>`).join('');

    $('info-list').querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch (_) { TN.toast('Copy nahi hua', 'error'); }
      });
    });
  }

  $('m-info').addEventListener('click', () => $('info-sheet').classList.remove('hidden'));
  $('info-close').addEventListener('click', () => $('info-sheet').classList.add('hidden'));
  $('info-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'info-sheet') $('info-sheet').classList.add('hidden');
  });

  /* --------------------------- customer details -------------------------- */

  const CUST_KEY = 'tn_customer';

  function savedCustomer() {
    try { return JSON.parse(localStorage.getItem(CUST_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function rememberCustomer(name, phone) {
    const prev = savedCustomer();
    const next = { name: name || prev.name || '', phone: phone || prev.phone || '' };
    try { localStorage.setItem(CUST_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  }

  /** Realtime updates are for the whole table; only react to our own bill. */
  function isMyOrder(order) {
    if (!order) return false;
    const myPhone = canonicalPhone(savedCustomer().phone);
    if (myPhone && canonicalPhone(order.customer_phone) === myPhone) return true;
    return !!(order.device_id && order.device_id === TN.deviceId());
  }

  /* -------------------------- welcome splash ----------------------------- */

  function speakWelcome(saved) {
    if (!state.restaurant || !TN.voice) return;
    const venue = state.restaurant.name;
    const guest = (saved && saved.name) || '';
    const hindi = /[\u0900-\u097F]/.test(venue + ' ' + guest);
    const text = hindi
      ? `${venue} में आपका स्वागत है${guest ? ', ' + guest : ''}। हमें आपकी सेवा करके खुशी होगी।`
      : `Welcome to ${venue}${guest ? ', ' + guest : ''}. We are happy to serve you.`;
    TN.voice.speak(text, {
      lang: hindi ? 'hi-IN' : 'en-IN',
      mode: hindi ? 'hi' : 'en',
      rate: 0.95,
      pitch: 1,
      retryGesture: true,
    });
  }

  function showWelcomeSplash(saved) {
    splashGreeted = false;
    $('ws-venue').textContent = state.restaurant.name;
    $('ws-table').textContent = state.table.name;
    const guest = (saved && saved.name) || '';
    $('ws-hello').textContent = guest ? `Welcome back, ${guest}!` : 'We are happy to serve you';
    $('welcome-splash').classList.remove('hidden');
    requestAnimationFrame(() => $('welcome-splash').classList.add('show'));
    speakWelcome(saved);
    clearTimeout(splashTimer);
    splashTimer = setTimeout(hideWelcomeSplash, 3200);
  }

  function hideWelcomeSplash() {
    const el = $('welcome-splash');
    if (!el || el.classList.contains('hidden')) return;
    clearTimeout(splashTimer);
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 220);
    if (splashGreeted) return;
    splashGreeted = true;
    // A guest with an open bill is looking at status — don't cover it.
    if (!$('view-menu').classList.contains('hidden')) greet(true);
  }

  $('ws-enter').addEventListener('click', hideWelcomeSplash);

  /** Greet the guest; ask for the name only when we do not know it yet. */
  function greet(allowAskName = true) {
    const saved = savedCustomer();
    if (saved.name) return; // splash already said "welcome back"
    if (!allowAskName || sessionStorage.getItem('tn_welcome_skipped')) {
      TN.toast(`Welcome to ${state.restaurant.name}! 👋`, 'success');
      return;
    }
    $('w-title').textContent = `Welcome to ${state.restaurant.name}!`;
    $('welcome').classList.remove('hidden');
    setTimeout(() => $('w-name').focus(), 250);
  }

  function closeWelcome() { $('welcome').classList.add('hidden'); }

  $('w-go').addEventListener('click', () => {
    const name = $('w-name').value.trim();
    if (!name) { $('w-name').focus(); TN.toast('Apna naam likhein', 'error'); return; }
    rememberCustomer(name);
    $('co-name').value = name;
    closeWelcome();
    TN.toast(`Welcome, ${name}! 👋`, 'success');
  });

  $('w-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-go').click(); });

  $('w-skip').addEventListener('click', () => {
    sessionStorage.setItem('tn_welcome_skipped', '1');
    closeWelcome();
    TN.toast(`Welcome to ${state.restaurant.name}! 👋`, 'success');
  });

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  /** Match the server: +91 / 0 prefixes must not create a second bill. */
  function canonicalPhone(value) {
    let d = digitsOnly(value);
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
  }

  $('co-phone').addEventListener('blur', () => {
    const normalized = canonicalPhone($('co-phone').value);
    if (normalized) $('co-phone').value = normalized;
  });

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

  function updateCheckoutNote() {
    const el = $('co-bill-note');
    const openBill = state.orders.some((o) => o.payment_status !== 'paid');
    if (!openBill) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = '<b>Open bill found.</b> Same mobile number rakhne par yeh naye items aapke <b>usi bill</b> mein add honge — alag bill nahi banega.';
  }

  $('to-checkout').addEventListener('click', () => {
    $('cart-sheet').classList.add('hidden');
    $('checkout-bill').innerHTML = billHtml();
    updateCheckoutNote();
    $('checkout-sheet').classList.remove('hidden');
  });
  $('checkout-close').addEventListener('click', () => $('checkout-sheet').classList.add('hidden'));
  $('checkout-sheet').addEventListener('click', (e) => { if (e.target.id === 'checkout-sheet') $('checkout-sheet').classList.add('hidden'); });

  /* ============================ PLACE ORDER ============================= */

  $('place-order').addEventListener('click', async () => {
    if (!state.cart.size) return;

    const name = $('co-name').value.trim();
    const phone = canonicalPhone($('co-phone').value);
    if (phone.length < 10) {
      TN.toast('Mobile number daalein — isi number se bill banega', 'error');
      $('co-phone').focus();
      return;
    }
    $('co-phone').value = phone;

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
      saveLastOrder(cartList().map(({ item, qty }) => ({
        item_id: item.id, name: item.name, price: item.price, qty,
      })));
      state.cart.clear();
      updateCartBar();
      $('checkout-sheet').classList.add('hidden');

      await refreshOrders();
      renderStatus();
      showView('status');
      TN.toast('Order placed! Kitchen ko bhej diya ✅', 'success');
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
      const saved = savedCustomer();
      const qs = new URLSearchParams({ deviceId: TN.deviceId() });
      if (saved.phone) qs.set('phone', saved.phone);
      const res = await TN.api(
        `/api/public/tables/${encodeURIComponent(tableToken)}/orders?${qs.toString()}`,
        { noRedirect: true }
      );
      state.orders = res.orders || [];
    } catch (_) { /* keep previous */ }
  }

  const EMOJI = { placed: '📨', accepted: '👍', preparing: '👨‍🍳', ready: '🔔', served: '🍽️', paid: '💳', cancelled: '❌' };
  const RATING_EMOJI = { 5: '🤩', 4: '🙂', 3: '😐', 2: '🙁', 1: '😞' };
  const RATING_LABEL = { 5: 'Loved it', 4: 'Good', 3: 'Okay', 2: 'Not great', 1: 'Bad' };
  const HEADLINE = {
    placed: 'Order mil gaya', accepted: 'Kitchen ne accept kar liya', preparing: 'Aapka khana ban raha hai',
    ready: 'Order ready hai!', served: 'Order table par serve ho gaya', paid: 'Payment ho gaya', cancelled: 'Order cancel ho gaya',
  };
  const SUBTEXT = {
    placed: 'Kitchen jaldi hi shuru karega.', accepted: 'Thodi der mein banana shuru honge.',
    preparing: 'Bas kuch hi minutes… ready hote hi notification aayegi.',
    ready: 'Server aapke table par lane wala hai.', served: 'Enjoy your meal!', paid: 'Dhanyavaad!', cancelled: '',
  };

  function billKeyOf(order) {
    if (order.bill_key) return order.bill_key;
    const phone = canonicalPhone(order.customer_phone);
    if (phone) return 'phone:' + phone;
    if (order.device_id) return 'device:' + order.device_id;
    return 'order:' + order.id;
  }

  function renderStatus() {
    const host = $('status-cards');
    host.innerHTML = '';
    const c = state.restaurant.currency || '₹';
    const currencySym = c;

    if (!state.orders.length) {
      host.innerHTML = '<div class="empty"><div class="icon">🍽️</div><p>Koi active order nahi.</p></div>';
      return;
    }

    // Add-on orders with the same phone/device are one bill. Show that once,
    // instead of making the guest think each order is a separate bill.
    const multi = state.orders.length > 1 &&
      state.orders.every((o) => billKeyOf(o) === billKeyOf(state.orders[0]));
    if (multi) {
      host.insertAdjacentHTML('beforeend', billSummaryHtml(currencySym));
      const summary = host.querySelector('.bill-summary');
      const payBox = summary && summary.querySelector('.bs-pay');
      if (payBox) {
        const total = Number(payBox.dataset.total) || 0;
        payBox.querySelectorAll('[data-bill-split]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const n = Number(btn.dataset.billSplit);
            payBox.querySelectorAll('[data-bill-split]').forEach((b) => b.classList.toggle('on', b === btn));
            const per = total / n;
            const perEl = payBox.querySelector('[data-bill-per]');
            perEl.innerHTML = `${n === 1 ? 'Full amount' : `${TN.fmtMoney(per, currencySym)} per person`} · <a href="${TN.escapeHtml(upiHrefRaw(payBox.dataset.upiLink, per))}">Open UPI app →</a>`;
          });
        });
      }
    }

    state.orders.forEach((order, index) => {
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
          <span class="no">${multi && index > 0 ? 'Add-on <span class="addon-inline">same bill</span>' : 'Aapka order'}</span>
          <span class="badge ${order.status}">${order.status_label || order.status}</span>
        </div>
        <div class="big-status">
          <div class="emoji">${EMOJI[order.status] || '🍽️'}</div>
          <h2>${HEADLINE[order.status] || ''}</h2>
          ${isCancelled ? '' : `<p>${SUBTEXT[order.status] || ''}</p>`}
          ${order.queue ? `<div class="queue-chip"><span class="dot"></span>Queue #${order.queue.position} · ~${order.queue.eta_minutes} min</div>` : ''}
        </div>
        <div class="order-card-body">
          ${isCancelled ? '<div class="cancelled-note">Yeh order cancel kar diya gaya hai.</div>' : stepsHtml}
          <div class="order-items-mini">
            ${order.items.map((it) => `<div><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currencySym)}</span></div>`).join('')}
            ${multi ? '' : `<div style="border-top:1px dashed var(--line);margin-top:6px;padding-top:6px;font-weight:700;color:var(--ink)">
              <span>Total</span><span>${TN.fmtMoney(order.total, currencySym)}</span>
            </div>`}
            ${multi
              ? (order.payment_status === 'paid'
                ? '<div style="color:var(--green);font-weight:700;margin-top:6px">✓ Paid</div>'
                : '<div style="margin-top:6px" class="tiny muted">🧾 Included in your bill above</div>')
              : (order.payment_status === 'paid'
                ? '<div style="color:var(--green);font-weight:700;margin-top:6px">✓ Paid</div>'
                : (order.upi
                  ? ''
                  : '<div style="margin-top:6px" class="tiny muted">💳 Pay at cash counter</div>'))}
          </div>
          ${multi ? '' : (order.payment_status !== 'paid' && order.upi ? payBoxHtml(order, currencySym) : '')}
          ${feedbackHtml(order)}
        </div>`;
      host.appendChild(card);

      // Split-the-bill selector (equal split — no gateway, just UPI).
      if (order.payment_status !== 'paid' && order.upi) {
        card.querySelectorAll('[data-split]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const n = Number(btn.dataset.split);
            card.querySelectorAll('[data-split]').forEach((b) => b.classList.toggle('on', b === btn));
            const amount = Number(order.total) / n;
            const per = card.querySelector('[data-per]');
            per.innerHTML = `${n === 1
              ? 'Full amount'
              : `${TN.fmtMoney(amount, currencySym)} per person`} · <a href="${upiHref(order, amount)}">Open UPI app →</a>`;
          });
        });
      }

      // One-tap emoji feedback.
      card.querySelectorAll('[data-fb]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const rating = Number(btn.dataset.fb);
          card.querySelectorAll('[data-fb]').forEach((b) => { b.disabled = true; });
          try {
            await TN.api(`/api/public/orders/${order.id}/feedback`, {
              body: {
                table: tableToken,
                rating,
                phone: savedCustomer().phone || null,
                deviceId: TN.deviceId(),
              },
              noRedirect: true,
            });
            TN.toast('Thanks for the feedback! 🙏', 'success');
            await refreshOrders();
            renderStatus();
          } catch (err) {
            card.querySelectorAll('[data-fb]').forEach((b) => { b.disabled = false; });
            TN.toast(err.message, 'error');
          }
        });
      });
    });
  }

  function upiHrefRaw(link, amount) {
    return String(link || '').replace(/([?&])am=[^&]*/, `$1am=${encodeURIComponent(Number(amount).toFixed(2))}`);
  }

  function upiHref(order, amount) {
    return upiHrefRaw(order.upi && order.upi.link, amount);
  }

  function billSummaryHtml(currency) {
    const unpaid = state.orders.filter((o) => o.payment_status !== 'paid' && !o.is_cancelled);
    const total = Math.round(unpaid.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100) / 100;
    const payable = unpaid.length > 0 && unpaid.every((o) => ['ready', 'served'].includes(o.status));
    const withUpi = unpaid.find((o) => o.upi);
    const link = withUpi ? withUpi.upi.link : '';

    const items = state.orders.map((o, i) => `
      <div class="bs-order">
        <div class="bs-order-head">
          <span>${i === 0 ? 'First order' : 'Add-on'}</span>
          <span class="badge ${o.status}">${o.status_label || o.status}</span>
        </div>
        ${o.items.map((it) => `<div class="row-line"><span>${it.qty} × ${TN.escapeHtml(it.name)}</span><span>${TN.fmtMoney(it.line_total, currency)}</span></div>`).join('')}
      </div>`).join('');

    let pay = '';
    if (payable && withUpi) {
      pay = `
        <div class="pay-box bs-pay" data-total="${total}" data-upi-link="${TN.escapeHtml(link)}">
          <div class="pay-top">
            <div>
              <b>Pay ${TN.fmtMoney(total, currency)}</b>
              <div class="tiny muted">UPI · ${TN.escapeHtml(withUpi.upi.id)}</div>
            </div>
            <a class="btn btn-primary btn-sm" href="${TN.escapeHtml(upiHrefRaw(link, total))}">Pay now</a>
          </div>
          <div class="pay-split">
            ${[1, 2, 3, 4].map((n) => `<button type="button" data-bill-split="${n}" class="${n === 1 ? 'on' : ''}">${n === 1 ? 'Full' : '÷' + n}</button>`).join('')}
          </div>
          <div class="pay-per" data-bill-per>Full amount · <a href="${TN.escapeHtml(upiHrefRaw(link, total))}">Open UPI app →</a></div>
        </div>`;
    } else if (!payable) {
      pay = '<div class="tiny muted bs-pay-note">🔔 Payment link sabhi items ready hone par yahan aa jayega.</div>';
    } else {
      pay = '<div class="tiny muted bs-pay-note">💳 Pay at cash counter — cash / UPI.</div>';
    }

    return `
      <div class="bill-summary">
        <div class="bs-head">
          <div>
            <div class="bs-kicker">One bill</div>
            <h3>Your bill</h3>
          </div>
          <span class="bs-count">${state.orders.length} orders</span>
        </div>
        <div class="bs-items">${items}</div>
        <div class="bs-total"><span>Amount due</span><span>${TN.fmtMoney(total, currency)}</span></div>
        ${pay}
        <div class="bs-foot">Same mobile number se add kiye gaye items ek hi bill mein aate hain.</div>
      </div>`;
  }

  function payBoxHtml(order, currency) {
    const amounts = [1, 2, 3, 4];
    return `
      <div class="pay-box">
        <div class="pay-top">
          <div>
            <b>Pay ${TN.fmtMoney(order.total, currency)}</b>
            <div class="tiny muted">UPI · ${TN.escapeHtml(order.upi.id)}</div>
          </div>
          <a class="btn btn-primary btn-sm" href="${TN.escapeHtml(order.upi.link)}">Pay now</a>
        </div>
        <div class="pay-split">
          ${amounts.map((n) => `<button type="button" data-split="${n}" class="${n === 1 ? 'on' : ''}">${n === 1 ? 'Full' : '÷' + n}</button>`).join('')}
        </div>
        <div class="pay-per" data-per>Full amount · <a href="${TN.escapeHtml(order.upi.link)}">Open UPI app →</a></div>
      </div>`;
  }

  function feedbackHtml(order) {
    if (order.rating) {
      return `
        <div class="feedback-box">
          <div class="feedback-done">${RATING_EMOJI[order.rating] || '🙏'} Thanks for the feedback!</div>
          ${order.feedback ? `<p class="tiny muted" style="margin-top:6px">“${TN.escapeHtml(order.feedback)}”</p>` : ''}
        </div>`;
    }
    if (!['served', 'paid'].includes(order.status)) return '';
    return `
      <div class="feedback-box">
        <h4>How was the food?</h4>
        <p>One tap — aapka feedback seedha restaurant tak jaata hai.</p>
        <div class="emoji-row">
          ${[5, 4, 3, 2, 1].map((n) => `
            <button type="button" data-fb="${n}" aria-label="${RATING_LABEL[n]}">
              ${RATING_EMOJI[n]}<span>${RATING_LABEL[n]}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }

  $('btn-back-menu').addEventListener('click', () => {
    showView('menu');
    renderMenu(); // refresh quantities + \"my usual\" after the last order
    if (!savedCustomer().name) greet();
  });

  /* ============================== SOCKET ================================ */

  function connectSocket() {
    if (typeof io === 'undefined') return; // socket client not loaded; polling still works
    state.socket = io({ query: { tableToken } });

    state.socket.on('order:update', async ({ order }) => {
      if (!order || order.table_token !== tableToken) return;
      // Another guest on the same table must not trigger our celebration.
      if (!isMyOrder(order)) return;
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
      <h2>Aapka order ready hai! 🎉</h2>
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
