/* ==========================================================================
   QRush — platform console
   Super-admin only. Reads one aggregate endpoint and manages every tenant.
   ========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => TN.escapeHtml(s);
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const money = (n, currency) => TN.fmtMoney(Number(n) || 0, currency || '₹');
  const plural = (n, one, many) => num(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));

  const TAB_TITLES = { overview: 'Overview', restaurants: 'Restaurants', access: 'Access & health' };

  const state = {
    me: null,
    tenantName: '',
    stats: null,
    tenants: [],
    meta: null,
    tab: 'overview',
    q: '',
    status: 'all',
    sort: 'newest',
    denied: false,
  };

  /* ------------------------------- helpers ------------------------------- */

  function toDate(sql) {
    if (!sql) return null;
    const raw = String(sql);
    const d = new Date(raw.replace(' ', 'T') + (raw.includes('Z') ? '' : 'Z'));
    return isNaN(d) ? null : d;
  }

  function fmtDate(sql) {
    const d = toDate(sql);
    return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  }

  function fmtDateTime(sql) {
    const d = toDate(sql);
    return d
      ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' +
        d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '—';
  }

  function fmtUptime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function avClass(seed) {
    let hash = 0;
    const text = String(seed || '');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 997;
    return 'av-' + (hash % 6);
  }

  function statusBadge(t) {
    return Number(t && t.is_active)
      ? '<span class="badge ready">Active</span>'
      : '<span class="badge cancelled">Suspended</span>';
  }

  function menuUrl(t) {
    if (!t || !t.sample_table_token) return '';
    return '/menu?table=' + encodeURIComponent(t.sample_table_token);
  }

  function findTenant(id) {
    return state.tenants.find((t) => Number(t.id) === Number(id));
  }

  function setSync(mode, text) {
    const el = $('sa-sync');
    if (!el) return;
    el.className = 'sa-sync' + (mode === 'busy' ? ' busy' : mode === 'bad' ? ' bad' : '');
    el.innerHTML = '<i></i> ' + esc(text);
  }

  /* ------------------------------- loading ------------------------------- */

  async function load(opts = {}) {
    try {
      setSync('busy', 'Syncing…');
      const data = await TN.api('/api/admin/super-admin/overview');
      state.stats = data.stats;
      state.tenants = data.tenants || [];
      state.meta = data.meta || null;
      renderAll();
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      setSync('ok', 'Live · ' + time);
    } catch (err) {
      setSync('bad', 'Offline');
      if (!opts.silent) TN.toast(err.message, 'error');
    }
  }

  function renderAll() {
    $('nav-tenant-count').textContent = num(state.tenants.length);
    renderStats();
    renderOverviewLists();
    renderTenantTable();
    renderAccess();
  }

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    $('p-tenants').textContent = num(s.tenants_total);
    $('p-tenants-sub').textContent = `${num(s.tenants_active)} active · ${num(s.tenants_suspended)} suspended`;
    $('p-owners').textContent = num(s.owners_total);
    $('p-owners-sub').textContent = `${num(s.staff_total)} kitchen/cashier · ${num(s.tenants_new_today)} new today`;
    $('p-orders').textContent = num(s.orders_today);
    $('p-orders-sub').textContent = `${num(s.open_orders)} open now · ${plural(s.active_tenants_today, 'venue', 'venues')} active`;
    $('p-revenue').textContent = money(s.revenue_today);
    $('p-revenue-sub').textContent = `${money(s.revenue_all)} all time`;
    $('p-setup').textContent = num(s.tables_total);
    $('p-setup-sub').textContent = `${num(s.menu_items_total)} menu items`;
    $('p-rating').textContent = Number(s.rating_count) ? `${Number(s.rating_avg).toFixed(1)} ★` : '—';
    $('p-rating-sub').textContent = `${num(s.rating_count)} guest ratings`;
  }

  /* ---------------------------- overview lists --------------------------- */

  function renderOverviewLists() {
    renderTopVenues();
    renderNewest();
    renderAttention();
  }

  function renderTopVenues() {
    const host = $('ov-top');
    const rows = state.tenants
      .filter((t) => Number(t.revenue_today) > 0)
      .sort((a, b) => Number(b.revenue_today) - Number(a.revenue_today))
      .slice(0, 5);

    if (!rows.length) {
      host.innerHTML = '<div class="sa-empty"><span class="big">🌙</span>Aaj abhi kisi venue par order nahi aaya.</div>';
      return;
    }

    const max = Number(rows[0].revenue_today) || 1;
    host.innerHTML = rows.map((t, i) => `
      <div class="sa-rank-row">
        <span class="sa-rank">${i + 1}</span>
        <button type="button" class="sa-rank-main sa-linkbtn" data-manage="${t.id}">
          <b>${esc(t.name)}</b>
          <div class="sa-bar"><i style="width:${Math.max(6, Math.round((Number(t.revenue_today) / max) * 100))}%"></i></div>
        </button>
        <div class="sa-rank-val">${money(t.revenue_today, t.currency)}<small>${num(t.orders_today)} orders</small></div>
      </div>`).join('');
  }

  function renderNewest() {
    const host = $('ov-new');
    const rows = [...state.tenants]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 5);

    if (!rows.length) {
      host.innerHTML = '<div class="sa-empty"><span class="big">🏪</span>Abhi koi restaurant nahi.</div>';
      return;
    }

    host.innerHTML = rows.map((t) => `
      <div class="sa-new-row">
        <div class="rt-avatar ${avClass(t.name)}">${esc(initials(t.name))}</div>
        <button type="button" class="sa-new-main sa-linkbtn" data-manage="${t.id}">
          <b>${esc(t.name)}</b>
          <span>${esc(t.owner_email || 'No owner')} · ${fmtDate(t.created_at)}</span>
        </button>
        ${statusBadge(t)}
      </div>`).join('');
  }

  function renderAttention() {
    const host = $('ov-attn');
    const items = [];

    state.tenants.forEach((t) => {
      if (!Number(t.is_active)) {
        items.push({ t, tone: 'danger', ico: '⏸', title: 'Suspended', note: 'QR ordering band hai' });
        return;
      }
      if (!Number(t.menu_count)) {
        items.push({ t, tone: 'warn', ico: '🍽', title: 'No menu items', note: 'Customer ko kuch bhi nahi dikhega' });
      }
      if (!Number(t.tables_count)) {
        items.push({ t, tone: 'warn', ico: '🪑', title: 'No tables / QR', note: 'Table add karke QR print karein' });
      }
      if (Number(t.open_orders) >= 8) {
        items.push({ t, tone: 'warn', ico: '🔥', title: `${num(t.open_orders)} open orders`, note: 'Kitchen / counter check karein' });
      }
    });

    const unique = new Set(items.map((i) => Number(i.t.id))).size;
    $('ov-attn-count').textContent = unique ? plural(unique, 'venue', 'venues') : 'All clear';

    if (!items.length) {
      host.innerHTML = '<div class="sa-ok">✓ Sab venues healthy hain — menu, tables aur status theek hai.</div>';
      return;
    }

    host.innerHTML = items.slice(0, 8).map((item) => `
      <div class="sa-attn-row ${item.tone === 'danger' ? 'danger' : ''}">
        <div class="sa-attn-ico">${item.ico}</div>
        <div class="sa-attn-main">
          <b>${esc(item.t.name)} — ${esc(item.title)}</b>
          <span>${esc(item.note)}</span>
        </div>
        <button class="btn btn-sm" data-manage="${item.t.id}">Open</button>
      </div>`).join('') + (items.length > 8
      ? `<div class="sa-note">+${items.length - 8} more checks — Restaurants tab dekhein.</div>`
      : '');
  }

  /* ------------------------------- tenants ------------------------------- */

  function filteredTenants() {
    const q = state.q.trim().toLowerCase();
    let rows = state.tenants.filter((t) => {
      if (state.status === 'active' && !Number(t.is_active)) return false;
      if (state.status === 'suspended' && Number(t.is_active)) return false;
      if (!q) return true;
      return [t.name, t.slug, t.owner_name, t.owner_email, t.phone]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });

    rows = [...rows];
    if (state.sort === 'revenue') rows.sort((a, b) => Number(b.revenue_today) - Number(a.revenue_today));
    else if (state.sort === 'orders') rows.sort((a, b) => Number(b.orders_today) - Number(a.orders_today));
    else if (state.sort === 'name') rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id));
    return rows;
  }

  function renderTenantTable() {
    const body = $('tenant-rows');
    if (!body) return;

    $('tenant-count').textContent = num(state.tenants.length);
    $('nav-tenant-count').textContent = num(state.tenants.length);

    const rows = filteredTenants();
    $('tenant-foot').innerHTML =
      `<span>Showing <b>${num(rows.length)}</b> of ${num(state.tenants.length)} restaurants</span>` +
      `<span>${num(state.stats ? state.stats.open_orders : 0)} open orders platform-wide</span>`;

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="sa-empty"><span class="big">🔎</span>
        ${state.tenants.length ? 'Is filter par koi restaurant nahi mila.' : 'Abhi koi restaurant nahi — pehla venue add karein.'}
      </div></td></tr>`;
      return;
    }

    body.innerHTML = rows.map((t) => {
      const url = menuUrl(t);
      return `<tr>
        <td>
          <div class="rt-cell">
            <div class="rt-avatar ${avClass(t.name)}">${esc(initials(t.name))}</div>
            <div class="rt-main">
              <button type="button" class="sa-linkbtn rt-name" data-manage="${t.id}">${esc(t.name)}</button>
              <div class="rt-slug">/${esc(t.slug)} · ${fmtDate(t.created_at)}</div>
              <div class="rt-owner-inline">${esc(t.owner_name || 'No owner')} · ${esc(t.owner_email || '—')}</div>
              <div class="rt-meta">
                <span class="${Number(t.tables_count) ? '' : 'gap'}">${plural(t.tables_count, 'table')}</span>
                <span class="${Number(t.menu_count) ? '' : 'gap'}">${plural(t.menu_count, 'item')}</span>
                <span>${plural(t.staff_count, 'staff', 'staff')}</span>
                ${Number(t.open_orders) ? `<span class="rt-open">${num(t.open_orders)} open</span>` : ''}
              </div>
            </div>
          </div>
        </td>
        <td class="rt-owner">
          <b>${esc(t.owner_name || 'No owner')}</b>
          <span>${esc(t.owner_email || '—')}</span>
        </td>
        <td><div class="num">${money(t.revenue_today, t.currency)}<small>${num(t.orders_today)} orders</small></div></td>
        <td><div class="num">${money(t.revenue_all, t.currency)}<small>${num(t.orders_all)} orders</small></div></td>
        <td>${statusBadge(t)}${t.last_order_at ? `<div class="tiny muted" style="margin-top:4px">last ${fmtDate(t.last_order_at)}</div>` : ''}</td>
        <td class="right">
          <div class="sa-actions">
            ${url ? `<a class="sa-icon-btn" href="${esc(url)}" target="_blank" rel="noopener" title="Open customer menu" aria-label="Open customer menu">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>
            </a>` : ''}
            <button class="btn btn-sm" data-manage="${t.id}">Manage</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  /* -------------------------------- access ------------------------------- */

  function renderAccess() {
    const me = state.me;
    if (!me) return;

    $('acc-session').innerHTML = `
      <div class="manage-hero">
        <div class="rt-avatar ${avClass(me.name)}">${esc(initials(me.name))}</div>
        <div>
          <h3>${esc(me.name)}</h3>
          <div class="tiny muted">${esc(me.email)}</div>
        </div>
        <span class="badge ready" style="margin-left:auto">Platform owner</span>
      </div>
      <div class="sa-kv">
        <div class="sa-kv-row"><span>Role</span><b>${esc(me.role)}</b></div>
        <div class="sa-kv-row"><span>Home venue</span><b>${esc(state.tenantName || '—')}</b></div>
        <div class="sa-kv-row"><span>Access</span><b>All restaurants · tenant CRUD</b></div>
      </div>`;

    const admins = (state.meta && state.meta.super_admins) || [];
    $('acc-admins').innerHTML = `
      <div class="sa-admin-chips">${admins.map((email) => `<span class="sa-admin-chip">🛡 ${esc(email)}</span>`).join('') || '<span class="muted">None configured</span>'}</div>
      ${state.meta && state.meta.demo_access ? `<div class="sa-warn">
        <b>owner@demo.com</b> ke paas platform access hai. Iska password strong rakhein aur staff ke saath share na karein.
        Aur admins add karne ke liye Render par <b>SUPER_ADMIN_EMAILS</b> set karein.
      </div>` : '<div class="sa-note">Sirf allowlisted emails hi tenants create / delete kar sakte hain.</div>'}`;

    const m = state.meta || {};
    const today = m.today || '—';
    $('acc-service').innerHTML = `
      <div class="sa-kv">
        <div class="sa-kv-row"><span>Database</span><b>${esc(m.database || '—')}</b></div>
        <div class="sa-kv-row"><span>Node runtime</span><b>${esc(m.node || '—')}</b></div>
        <div class="sa-kv-row"><span>Uptime</span><b>${esc(fmtUptime(m.uptime_seconds))}</b></div>
        <div class="sa-kv-row"><span>Server date (UTC)</span><b>${esc(today)}</b></div>
        <div class="sa-kv-row"><span>Snapshot</span><b>${esc(fmtDateTime(m.generated_at))}</b></div>
      </div>
      <div class="flex gap8 wrap mt16">
        <a class="btn btn-sm" href="/api/health" target="_blank" rel="noopener">Health JSON ↗</a>
        <a class="btn btn-sm" href="/admin">Venue admin ↗</a>
      </div>`;
  }

  async function checkHealth() {
    const el = $('acc-health');
    if (!el) return;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      el.className = 'sa-health ' + (res.ok ? 'ok' : 'bad');
      el.innerHTML = '<i></i> ' + esc(res.ok ? (data.name || 'healthy') : 'error');
    } catch (_) {
      el.className = 'sa-health bad';
      el.innerHTML = '<i></i> unreachable';
    }
  }

  /* -------------------------------- tabs -------------------------------- */

  function showTab(tab) {
    if (state.denied) return;
    state.tab = tab;
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-' + tab));
    $('sa-crumb-page').textContent = TAB_TITLES[tab] || tab;
    if (tab === 'restaurants') renderTenantTable();
    if (tab === 'access') { renderAccess(); checkHealth(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* -------------------------------- modal ------------------------------- */

  function openModal({ title, sub, body, actions, wide }) {
    const root = $('modal-root');
    const foot = (actions || []).map((a, i) =>
      `<button class="btn ${a.class || ''}" data-modal-act="${i}">${esc(a.label)}</button>`).join('');

    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal ${wide ? 'sa-modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            ${sub ? `<div class="sa-sub">${esc(sub)}</div>` : ''}
          </div>
          <div class="modal-body">${body}</div>
          <div class="modal-foot">${foot}</div>
        </div>
      </div>`;

    const backdrop = root.querySelector('.modal-backdrop');
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
    root.querySelectorAll('[data-modal-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = actions[Number(btn.dataset.modalAct)];
        if (action && action.onClick) action.onClick(btn);
      });
    });
  }

  function closeModal() {
    $('modal-root').innerHTML = '';
  }

  function field(id, label, value, opts = {}) {
    return `<div class="field">
      <label for="${id}">${label}</label>
      <input class="input" id="${id}" value="${esc(value || '')}" ${opts.type ? `type="${opts.type}"` : ''}
        ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}
        ${opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : ''} />
    </div>`;
  }

  function suggestPassword() {
    const chunk = Math.random().toString(36).slice(2, 8);
    return 'QRush-' + chunk + Math.floor(10 + Math.random() * 90);
  }

  /* ------------------------------- create ------------------------------- */

  function openCreate() {
    const password = suggestPassword();
    openModal({
      title: 'New restaurant',
      sub: 'Owner account turant ban jayega — credentials unhe bhejein.',
      wide: true,
      body: `
        <div class="field">
          <label for="nt-restaurant">Restaurant name <span style="color:var(--red)">*</span></label>
          <input class="input" id="nt-restaurant" placeholder="e.g. Kolhapuri Kitchen" autocomplete="organization" />
        </div>
        <div class="row">
          <div class="field">
            <label for="nt-name">Owner name <span style="color:var(--red)">*</span></label>
            <input class="input" id="nt-name" placeholder="e.g. Ramesh Patil" autocomplete="name" />
          </div>
          <div class="field">
            <label for="nt-phone">Phone</label>
            <input class="input" id="nt-phone" placeholder="e.g. 98765 43210" autocomplete="tel" />
          </div>
        </div>
        <div class="field">
          <label for="nt-email">Owner email <span style="color:var(--red)">*</span></label>
          <input class="input" id="nt-email" type="email" placeholder="owner@restaurant.com" autocomplete="email" />
        </div>
        <div class="field" style="margin-bottom:0">
          <label for="nt-password">Login password <span style="color:var(--red)">*</span></label>
          <div class="flex gap8">
            <input class="input" id="nt-password" value="${esc(password)}" autocomplete="new-password" />
            <button class="btn" type="button" id="nt-generate">Generate</button>
          </div>
          <p class="tiny muted" style="margin:5px 0 0">Minimum 8 characters. Owner ise baad mein Admin → Staff se badal sakta hai.</p>
        </div>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        { label: 'Create restaurant', class: 'btn-primary', onClick: submitCreate },
      ],
    });

    $('nt-generate').addEventListener('click', () => { $('nt-password').value = suggestPassword(); });
    $('nt-restaurant').focus();
  }

  async function submitCreate(btn) {
    const payload = {
      restaurant: $('nt-restaurant').value.trim(),
      name: $('nt-name').value.trim(),
      email: $('nt-email').value.trim(),
      password: $('nt-password').value,
      phone: $('nt-phone').value.trim(),
    };
    if (!payload.restaurant || !payload.name || !payload.email || !payload.password) {
      TN.toast('Restaurant, owner name, email aur password zaroori hain', 'error');
      return;
    }
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const data = await TN.api('/api/admin/super-admin/tenants', { method: 'POST', body: payload });
      await load({ silent: true });
      showCreated(data.tenant, payload);
      TN.toast('Restaurant created', 'success');
    } catch (err) {
      TN.toast(err.message, 'error');
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  function showCreated(tenant, payload) {
    const adminUrl = location.origin + '/admin';
    const loginUrl = location.origin + '/login';
    openModal({
      title: 'Restaurant is live',
      sub: 'Yeh credentials owner ko bhejein. Password ab dobara nahi dikhega.',
      wide: true,
      body: `
        <div class="sa-info-grid" style="margin-top:0">
          <div class="sa-info"><span>Restaurant</span><b>${esc(tenant.name)}</b></div>
          <div class="sa-info"><span>Slug</span><b>/${esc(tenant.slug)}</b></div>
        </div>
        <div class="sa-creds">
          <div class="sa-cred"><div class="sa-cred-main"><span>Owner email</span><b>${esc(payload.email)}</b></div>
            <button class="sa-copy" data-copy="${esc(payload.email)}">Copy</button></div>
          <div class="sa-cred"><div class="sa-cred-main"><span>Password</span><b>${esc(payload.password)}</b></div>
            <button class="sa-copy" data-copy="${esc(payload.password)}">Copy</button></div>
          <div class="sa-cred"><div class="sa-cred-main"><span>Admin login</span><b>${esc(adminUrl)}</b></div>
            <button class="sa-copy" data-copy="${esc(adminUrl)}">Copy</button></div>
        </div>
        <div class="sa-note">
          Agla step owner ke liye: <b>${esc(loginUrl)}</b> par login → Menu items add → Tables add →
          QR print. UPI / WiFi Settings tab mein bharein.
        </div>`,
      actions: [
        { label: 'Open restaurant list', onClick: () => { closeModal(); showTab('restaurants'); } },
        { label: 'Done', class: 'btn-primary', onClick: closeModal },
      ],
    });
  }

  /* -------------------------------- edit -------------------------------- */

  function openEdit(t) {
    openModal({
      title: 'Edit ' + t.name,
      sub: 'Restaurant ka naam, phone aur status.',
      body: `
        ${field('et-name', 'Restaurant name', t.name)}
        ${field('et-phone', 'Phone', t.phone, { placeholder: 'e.g. 98765 43210' })}
        <div class="sa-info" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div><span>Status</span><b>${Number(t.is_active) ? 'Active' : 'Suspended'}</b></div>
          <label class="switch"><input type="checkbox" id="et-active" ${Number(t.is_active) ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="sa-note">Suspend karne par customer QR menu band ho jayega; staff login chalta rahega.</div>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save changes', class: 'btn-primary',
          onClick: async (btn) => {
            const name = $('et-name').value.trim();
            if (!name) { TN.toast('Restaurant name khali nahi ho sakta', 'error'); return; }
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Saving…';
            try {
              await TN.api(`/api/admin/super-admin/tenants/${t.id}`, {
                method: 'PATCH',
                body: { name, phone: $('et-phone').value.trim(), is_active: $('et-active').checked },
              });
              closeModal();
              await load({ silent: true });
              TN.toast('Saved', 'success');
            } catch (err) {
              TN.toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Save changes';
            }
          },
        },
      ],
    });
  }

  /* ----------------------------- manage modal --------------------------- */

  function openManage(t) {
    const url = menuUrl(t);
    const info = (label, value) => `<div class="sa-info"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    openModal({
      title: 'Manage restaurant',
      sub: `/${t.slug} · created ${fmtDate(t.created_at)}`,
      wide: true,
      body: `
        <div class="manage-hero">
          <div class="rt-avatar ${avClass(t.name)}">${esc(initials(t.name))}</div>
          <div>
            <h3>${esc(t.name)}</h3>
            <div class="tiny muted">${esc(t.owner_email || 'No owner account')}</div>
          </div>
          <div style="margin-left:auto">${statusBadge(t)}</div>
        </div>
        <div class="sa-info-grid">
          ${info('Owner', t.owner_name || '—')}
          ${info('Phone', t.phone || '—')}
          ${info('Today', `${money(t.revenue_today, t.currency)} · ${num(t.orders_today)} orders`)}
          ${info('All time', `${money(t.revenue_all, t.currency)} · ${num(t.orders_all)} orders`)}
          ${info('Open orders', num(t.open_orders))}
          ${info('Setup', `${num(t.tables_count)} tables · ${num(t.menu_count)} items · ${num(t.staff_count)} staff`)}
          ${info('UPI', t.upi_id || 'Not set')}
          ${info('Last order', t.last_order_at ? fmtDateTime(t.last_order_at) : '—')}
        </div>
        <div class="manage-actions">
          ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open customer menu ↗</a>` : '<span></span>'}
          <button class="btn" data-do="edit">Edit details</button>
          <button class="btn" data-do="reset">Reset owner password</button>
          <button class="btn" data-do="toggle">${Number(t.is_active) ? 'Suspend venue' : 'Activate venue'}</button>
          <div class="danger-zone">
            <button class="btn btn-danger" data-do="delete">Delete restaurant</button>
          </div>
        </div>
        <div class="sa-note">Delete karne par menu, tables, orders aur staff — sab permanently mit jayega.</div>`,
      actions: [{ label: 'Close', onClick: closeModal }],
    });

    const root = $('modal-root');
    root.querySelector('[data-do="edit"]').addEventListener('click', () => openEdit(t));
    root.querySelector('[data-do="reset"]').addEventListener('click', () => openReset(t));
    root.querySelector('[data-do="toggle"]').addEventListener('click', () => openToggle(t));
    root.querySelector('[data-do="delete"]').addEventListener('click', () => openDelete(t));
  }

  /* --------------------------- reset password --------------------------- */

  function openReset(t) {
    const password = suggestPassword();
    openModal({
      title: 'Reset owner password',
      sub: t.owner_email || 'No owner account',
      wide: true,
      body: `
        ${field('rp-name', 'Owner name', t.owner_name)}
        ${field('rp-email', 'Owner email', t.owner_email, { type: 'email', autocomplete: 'email' })}
        <div class="field">
          <label for="rp-password">New password</label>
          <div class="flex gap8">
            <input class="input" id="rp-password" value="${esc(password)}" autocomplete="new-password" />
            <button class="btn" type="button" id="rp-generate">Generate</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label for="rp-confirm">Confirm password</label>
          <input class="input" id="rp-confirm" value="${esc(password)}" autocomplete="new-password" />
        </div>
        <div class="sa-note">Password badalne se owner ka purana session turant nahi tootta (JWT 12h tak valid rehta hai).</div>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Reset password', class: 'btn-primary',
          onClick: async (btn) => {
            const email = $('rp-email').value.trim();
            const name = $('rp-name').value.trim();
            const pass = $('rp-password').value;
            const confirm = $('rp-confirm').value;
            if (!email || !name) { TN.toast('Owner name aur email zaroori hain', 'error'); return; }
            if (pass.length < 8) { TN.toast('Password kam se kam 8 characters ka ho', 'error'); return; }
            if (pass !== confirm) { TN.toast('Dono passwords match nahi kar rahe', 'error'); return; }
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Resetting…';
            try {
              await TN.api(`/api/admin/super-admin/tenants/${t.id}/owner`, {
                method: 'PUT',
                body: { name, email, password: pass },
              });
              await load({ silent: true });
              closeModal();
              TN.toast('Owner password reset', 'success');
            } catch (err) {
              TN.toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Reset password';
            }
          },
        },
      ],
    });
    $('rp-generate').addEventListener('click', () => {
      const next = suggestPassword();
      $('rp-password').value = next;
      $('rp-confirm').value = next;
    });
  }

  /* ------------------------------ suspend ------------------------------- */

  function openToggle(t) {
    const active = Number(t.is_active);
    openModal({
      title: active ? 'Suspend venue?' : 'Activate venue?',
      sub: t.name,
      body: active
        ? '<div class="sa-warn">Customer QR menu turant band ho jayega. Owner/staff login aur data safe rahega. Wapas Activate kar sakte hain.</div>'
        : '<div class="sa-ok">QR menu aur naye orders turant chalu ho jayenge.</div>',
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: active ? 'Suspend' : 'Activate',
          class: active ? 'btn-danger' : 'btn-success',
          onClick: async (btn) => {
            btn.disabled = true;
            try {
              await TN.api(`/api/admin/super-admin/tenants/${t.id}`, {
                method: 'PATCH', body: { is_active: !active },
              });
              closeModal();
              await load({ silent: true });
              TN.toast(active ? 'Venue suspended' : 'Venue activated', 'success');
            } catch (err) {
              TN.toast(err.message, 'error');
              btn.disabled = false;
            }
          },
        },
      ],
    });
  }

  /* ------------------------------- delete ------------------------------- */

  function openDelete(t) {
    openModal({
      title: 'Delete restaurant?',
      sub: t.name,
      wide: true,
      body: `
        <div class="sa-warn danger"><b>Yeh permanent hai.</b> Menu, tables, QR tokens, orders, staff accounts aur push subscriptions — sab delete ho jayenge.</div>
        <div class="field" style="margin-top:14px">
          <label for="del-confirm">Confirm karne ke liye <b>${esc(t.name)}</b> type karein</label>
          <input class="input" id="del-confirm" autocomplete="off" placeholder="${esc(t.name)}" />
        </div>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Delete permanently', class: 'btn-danger',
          onClick: async (btn) => {
            if ($('del-confirm').value.trim() !== String(t.name).trim()) {
              TN.toast('Naam exactly match nahi hua', 'error');
              return;
            }
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Deleting…';
            try {
              await TN.api(`/api/admin/super-admin/tenants/${t.id}`, { method: 'DELETE' });
              closeModal();
              await load({ silent: true });
              TN.toast('Restaurant deleted', 'success');
            } catch (err) {
              TN.toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Delete permanently';
            }
          },
        },
      ],
    });
    const input = $('del-confirm');
    const action = $('modal-root').querySelector('[data-modal-act="1"]');
    action.disabled = true;
    input.addEventListener('input', () => {
      action.disabled = input.value.trim() !== String(t.name).trim();
    });
    input.focus();
  }

  /* -------------------------------- copy -------------------------------- */

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
    TN.toast('Copied', 'success');
  }

  /* -------------------------------- denied ------------------------------ */

  function showDenied() {
    state.denied = true;
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.add('hidden'));
    ['nav-tenant-count'].forEach((id) => $(id) && $(id).classList.add('hidden'));
    $('access-denied').classList.remove('hidden');
    $('sa-crumb-page').textContent = 'No access';
    $('refresh').classList.add('hidden');
    $('new-tenant-top').classList.add('hidden');
    setSync('bad', 'Restricted');
  }

  /* --------------------------------- boot ------------------------------- */

  async function boot() {
    try {
      const me = await TN.fetchMe();
      if (me.user.role !== 'owner') {
        window.location.href = me.user.role === 'kitchen' ? '/kitchen' : '/cashier';
        return;
      }
      state.me = me.user;
      state.tenantName = (me.tenant && me.tenant.name) || '';
      $('whoami').textContent = `${me.user.name} • Platform`;

      if (!me.user.is_super_admin) {
        showDenied();
        return;
      }

      await load();
      showTab('overview');

      setInterval(() => {
        if (!document.hidden && !state.denied) load({ silent: true });
      }, 60000);
    } catch (_) {
      // fetchMe already redirected (or showed a toast) for expired sessions.
    }
  }

  /* ------------------------------- events ------------------------------- */

  document.querySelectorAll('.nav-item[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  $('refresh').addEventListener('click', () => load());
  $('new-tenant').addEventListener('click', openCreate);
  $('new-tenant-top').addEventListener('click', openCreate);
  $('logout').addEventListener('click', () => TN.logout());
  $('denied-logout').addEventListener('click', () => TN.logout());

  $('tenant-search').addEventListener('input', (e) => {
    state.q = e.target.value;
    renderTenantTable();
  });
  $('tenant-status').addEventListener('change', (e) => {
    state.status = e.target.value;
    renderTenantTable();
  });
  $('tenant-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderTenantTable();
  });

  document.addEventListener('click', (e) => {
    const manage = e.target.closest('[data-manage]');
    if (manage) {
      const tenant = findTenant(manage.dataset.manage);
      if (tenant) openManage(tenant);
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy, copy);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  boot();
})();
