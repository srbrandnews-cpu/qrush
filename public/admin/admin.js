/* Owner admin dashboard — dashboard, menu, tables/QR, staff, settings. */

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = TN.escapeHtml;

  let currency = '₹';
  let menuData = { categories: [], uncategorized: [] };
  let tablesData = [];
  let qrSheet = null;

  /* ============================== MODAL ================================= */

  function openModal(title, bodyHtml, buttons) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHtml;
    const foot = $('modal-foot');
    foot.innerHTML = '';
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.class || '');
      btn.textContent = b.label;
      btn.addEventListener('click', async () => {
        if (!b.onClick) { closeModal(); return; }
        btn.disabled = true;
        const original = btn.textContent;
        btn.innerHTML = '<span class="spinner"></span>';
        try {
          // A handler returns `false` to KEEP the modal open (validation failed).
          // Any other return (including nothing) means success -> close it.
          const keepOpen = await b.onClick();
          if (keepOpen !== false) closeModal();
        } catch (err) {
          TN.toast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
      foot.appendChild(btn);
    });
    $('modal').classList.remove('hidden');
    setTimeout(() => { const f = $('modal-body').querySelector('input,select,textarea'); if (f) f.focus(); }, 60);
  }

  function closeModal() { $('modal').classList.add('hidden'); }
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const val = (id) => ($(id) ? $(id).value.trim() : '');

  /* =============================== TABS ================================= */

  const loaders = {
    dashboard: loadDashboard, menu: loadMenu, tables: loadTables,
    staff: loadStaff, settings: loadSettings, notifications: loadNotifications,
  };

  document.querySelectorAll('.nav-item[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  function showTab(tab) {
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-' + tab));
    (loaders[tab] || loadDashboard)();
  }

  /* =============================== BOOT ================================= */

  async function boot() {
    const me = await TN.fetchMe();
    if (me.user.role !== 'owner') {
      window.location.href = me.user.role === 'kitchen' ? '/kitchen' : '/cashier';
      return;
    }
    currency = (me.tenant && me.tenant.currency) || '₹';
    $('whoami').textContent = `${me.user.name} • ${me.tenant ? me.tenant.name : ''}`;
    connectSocket();
    showTab('dashboard');
  }

  /* ============================ DASHBOARD =============================== */

  async function loadDashboard() {
    const [stats, live] = await Promise.all([
      TN.api('/api/orders/stats'),
      TN.api('/api/orders?board=open&limit=50'),
    ]);
    $('d-open').textContent = stats.openNow;
    $('d-orders').textContent = stats.today.orders_today;
    $('d-items').textContent = `${stats.today.items_today} items`;
    $('d-revenue').textContent = TN.fmtMoney(stats.today.revenue_today, currency);

    const ov = await TN.api('/api/admin/overview').catch(() => null);
    if (ov) { $('d-tables').textContent = ov.tables; $('d-menu').textContent = `${ov.menuItems} menu items`; }

    const top = stats.topItems || [];
    $('top-items').innerHTML = top.length
      ? top.map((t, i) => {
          const max = top[0].qty || 1;
          return `<div class="top-item">
            <span class="rank">${i + 1}</span>
            <div class="grow"><div class="bold">${esc(t.name)}</div><div class="bar" style="width:${Math.max(8, (t.qty / max) * 100)}%"></div></div>
            <span class="qty">${t.qty}×</span>
          </div>`;
        }).join('')
      : '<div class="empty">Aaj abhi tak koi order nahi.</div>';

    const orders = live.orders || [];
    $('live-count').textContent = orders.length;
    $('live-orders').innerHTML = orders.length
      ? orders.map((o) => `<div class="live-row">
          <span class="no">#${o.order_no}</span>
          <span class="tbl">${esc(o.table_name)}</span>
          <span class="badge ${o.status}">${o.status}</span>
          <span class="amt">${TN.fmtMoney(o.total, currency)}</span>
        </div>`).join('')
      : '<div class="empty">Koi active order nahi.</div>';

    await renderSetup(ov, stats);
  }

  /**
   * Getting-started checklist. Lets a restaurant owner set the whole thing up
   * on their own, without hand-holding.
   */
  async function renderSetup(ov, stats) {
    let staff = [];
    let rest = null;
    try {
      staff = (await TN.api('/api/admin/staff')).staff || [];
      rest = (await TN.api('/api/admin/restaurant')).restaurant;
    } catch (_) { /* checklist is best-effort */ }

    const hasKitchen = staff.some((s) => s.role === 'kitchen' && s.is_active);
    const hasCashier = staff.some((s) => s.role === 'cashier' && s.is_active);
    const gstSet = rest && Number(rest.gst_percent) > 0;
    const nameSet = rest && rest.name && !/^demo$/i.test(rest.slug || '');

    const steps = [
      {
        done: !!nameSet, label: 'Restaurant ka naam aur GST set karo',
        hint: 'Settings tab mein naam, address aur GST % bharein', tab: 'settings',
      },
      {
        done: (ov && ov.menuItems > 0), label: 'Menu items add karo',
        hint: 'CSV import se 1 minute mein poora menu (📥 Import CSV)', tab: 'menu',
      },
      {
        done: (ov && ov.tables > 0), label: 'Tables add karo',
        hint: 'Bulk add se 10-20 tables ek saath (🪑 Tables & QR)', tab: 'tables',
      },
      {
        done: (ov && ov.tables > 0), label: 'QR code print karke table par lagao',
        hint: 'Tables & QR tab → Print all → sticker cut karke chipkao', tab: 'tables',
      },
      {
        done: hasKitchen, label: 'Kitchen staff account banao',
        hint: 'Staff tab → role "kitchen" → woh /kitchen screen chalayega', tab: 'staff',
      },
      {
        done: hasCashier, label: 'Cashier staff account banao',
        hint: 'Staff tab → role "cashier" → woh /cashier screen chalayega', tab: 'staff',
      },
      {
        done: (ov && ov.allOrders > 0), label: 'Ek test order karke dekho',
        hint: 'QR scan karke order place karein, kitchen screen par aayega', tab: 'tables',
      },
    ];

    const doneCount = steps.filter((s) => s.done).length;
    $('setup-progress').textContent = doneCount + ' / ' + steps.length;
    $('setup-progress').className = 'badge ' + (doneCount === steps.length ? 'ready' : 'muted');

    // The checklist stays on the dashboard until the owner switches it off
    // (the choice is remembered on this browser).
    const shown = localStorage.getItem('tn_setup_checklist') !== 'off';
    $('setup-card').classList.toggle('hidden', !shown);
    $('setup-toggle').checked = shown;

    const allDone = doneCount === steps.length;
    $('setup-list').innerHTML =
      (allDone
        ? '<div class="setup-done"><span class="big">🎉</span><span>Sab kuch set ho gaya — aapka restaurant live hai! Naya order aayega toh kitchen screen par dikhega.</span></div>'
        : '') +
      steps.map((s, i) => `
      <div class="setup-item ${s.done ? 'done' : ''}">
        <span class="setup-check">${s.done ? '✓' : ''}</span>
        <div>
          <div class="setup-label">${i + 1}. ${esc(s.label)}</div>
          ${s.done ? '' : `<div class="setup-hint">${esc(s.hint)}</div>`}
        </div>
        ${s.done ? '' : `<button class="btn btn-sm setup-go" data-goto="${s.tab}">Karein</button>`}
      </div>`).join('');

    $('setup-list').querySelectorAll('[data-goto]').forEach((b) =>
      b.addEventListener('click', () => showTab(b.dataset.goto)));
  }

  // Toggle switch for the checklist card.
  $('setup-toggle').addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem('tn_setup_checklist', on ? 'on' : 'off');
    $('setup-card').classList.toggle('hidden', !on);
  });
  $('refresh-dash').addEventListener('click', loadDashboard);

  /* =============================== MENU ================================= */

  async function loadMenu() {
    menuData = await TN.api('/api/menu');
    renderMenuEditor();
  }

  function renderMenuEditor() {
    const host = $('menu-editor');
    host.innerHTML = '';
    if (!menuData.categories.length && !menuData.uncategorized.length) {
      host.innerHTML = '<div class="card"><div class="empty"><div class="icon">🍛</div><p>Menu khali hai. Pehle category, phir items add karein.</p></div></div>';
      return;
    }

    menuData.categories.forEach((cat) => host.appendChild(catBlock(cat)));
    if (menuData.uncategorized.length) {
      host.appendChild(catBlock({ id: null, name: 'Uncategorized', items: menuData.uncategorized }));
    }
  }

  function catBlock(cat) {
    const block = document.createElement('div');
    block.className = 'card cat-block';
    block.innerHTML = `
      <div class="cat-head">
        <h3 class="grow">${esc(cat.name)}</h3>
        <span class="tiny muted">${cat.items.length} items</span>
        ${cat.id ? `
          <button class="btn btn-sm" data-act="edit-cat">Edit</button>
          <button class="btn btn-sm btn-ghost" data-act="del-cat">🗑</button>` : ''}
      </div>
      <div class="cat-items"></div>`;

    const itemsHost = block.querySelector('.cat-items');
    if (!cat.items.length) {
      itemsHost.innerHTML = '<div class="empty" style="padding:22px">Is category mein koi item nahi.</div>';
    } else {
      cat.items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'mi';
        row.innerHTML = `
          <span class="veg-mark ${it.is_veg ? '' : 'nonveg'}"></span>
          <div class="mi-body">
            <div class="mi-name">${esc(it.name)} ${it.is_available ? '' : '<span class="badge muted">unavailable</span>'}</div>
            ${it.description ? `<div class="mi-desc">${esc(it.description)}</div>` : ''}
          </div>
          <span class="mi-price">${currency}${Number(it.price).toLocaleString('en-IN')}</span>
          <button class="btn btn-sm" data-act="edit-item">Edit</button>
          <button class="btn btn-sm btn-ghost" data-act="del-item">🗑</button>`;
        row.querySelector('[data-act="edit-item"]').addEventListener('click', () => itemModal(cat, it));
        row.querySelector('[data-act="del-item"]').addEventListener('click', () => confirmDeleteItem(it));
        itemsHost.appendChild(row);
      });
    }

    const editCat = block.querySelector('[data-act="edit-cat"]');
    if (editCat) editCat.addEventListener('click', () => categoryModal(cat));
    const delCat = block.querySelector('[data-act="del-cat"]');
    if (delCat) delCat.addEventListener('click', () => confirmDeleteCategory(cat));
    return block;
  }

  $('add-cat').addEventListener('click', () => categoryModal(null));
  $('add-item').addEventListener('click', () => itemModal(menuData.categories[0] || null, null));
  $('import-csv').addEventListener('click', importCsvModal);

  /**
   * Bulk import a menu from a CSV file. This is how a real restaurant
   * onboards quickly — typing 60 items by hand is not realistic.
   */
  function importCsvModal() {
    openModal('Import menu from CSV', `
      <p class="small muted" style="margin:0 0 14px">
        Apne menu ki CSV file upload karein. Missing categories automatically ban jayengi,
        aur same naam ke items update ho jayenge.
      </p>
      <div class="field">
        <a class="btn btn-sm" href="/api/menu/template.csv" download>⬇ Download template CSV</a>
        <span class="tiny muted" style="margin-left:8px">Format samajhne ke liye template download karein</span>
      </div>
      <div class="field">
        <label>CSV file choose karein</label>
        <input class="input" type="file" id="m-csv-file" accept=".csv,text/csv" />
      </div>
      <div class="field">
        <label>Existing menu kya karein?</label>
        <select class="input" id="m-csv-mode">
          <option value="append">Add to existing (recommended)</option>
          <option value="replace">Replace everything (purana menu mita de)</option>
        </select>
      </div>
      <div id="m-csv-result"></div>
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: 'Import', class: 'btn-primary',
        onClick: async () => {
          const file = $('m-csv-file').files[0];
          if (!file) { TN.toast('Pehle ek CSV file choose karein', 'error'); return false; }
          const text = await file.text();
          const res = await TN.api('/api/menu/import', {
            method: 'POST',
            body: { csv: text, mode: $('m-csv-mode').value },
          });
          const parts = [];
          if (res.itemsCreated) parts.push(res.itemsCreated + ' items added');
          if (res.itemsUpdated) parts.push(res.itemsUpdated + ' updated');
          if (res.categoriesCreated) parts.push(res.categoriesCreated + ' categories created');
          TN.toast(parts.join(' · ') || 'Import complete', 'success');
          await loadMenu();
          // Show row-level errors inside the modal.
          if (res.errors && res.errors.length) {
            $('m-csv-result').innerHTML = `<div class="ocard-notes" style="background:#fef3c7;color:#92400e">
              ${res.errors.length} row(s) skip hui:<br>${res.errors.slice(0, 8).map(e => 'Line ' + e.line + ': ' + TN.escapeHtml(e.error)).join('<br>')}
            </div>`;
            return false; // keep modal open so they can read the errors
          }
        },
      },
    ]);
  }

  function categoryModal(cat) {
    openModal(cat ? 'Edit category' : 'New category', `
      <div class="field"><label>Category name</label><input class="input" id="m-cat-name" value="${cat ? esc(cat.name) : ''}" placeholder="e.g. Starters" /></div>
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: cat ? 'Save' : 'Add', class: 'btn-primary',
        onClick: async () => {
          const name = val('m-cat-name');
          if (!name) { TN.toast('Name required', 'error'); return false; }
          if (cat) await TN.api(`/api/menu/categories/${cat.id}`, { method: 'PUT', body: { name } });
          else await TN.api('/api/menu/categories', { method: 'POST', body: { name } });
          TN.toast('Saved', 'success');
          await loadMenu();
        },
      },
    ]);
  }

  function itemModal(cat, item) {
    const cats = menuData.categories;
    const catOptions = cats.map((c) =>
      `<option value="${c.id}" ${cat && cat.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    openModal(item ? 'Edit item' : 'New item', `
      <div class="field"><label>Category</label><select class="input" id="m-item-cat">${catOptions}</select></div>
      <div class="field"><label>Name</label><input class="input" id="m-item-name" value="${item ? esc(item.name) : ''}" placeholder="e.g. Paneer Tikka" /></div>
      <div class="field"><label>Description (optional)</label><input class="input" id="m-item-desc" value="${item && item.description ? esc(item.description) : ''}" /></div>
      <div class="row">
        <div class="field"><label>Price (${currency})</label><input class="input" id="m-item-price" type="number" min="0" step="1" value="${item ? item.price : ''}" /></div>
        <div class="field">
          <label>Type</label>
          <select class="input" id="m-item-veg">
            <option value="1" ${item && item.is_veg ? 'selected' : ''}>🟢 Veg</option>
            <option value="0" ${item && !item.is_veg ? 'selected' : ''}>🔴 Non-veg</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:10px">
          <span class="switch"><input type="checkbox" id="m-item-avail" ${!item || item.is_available ? 'checked' : ''}><span class="slider"></span></span>
          Available (customers can order)
        </label>
      </div>
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: item ? 'Save' : 'Add item', class: 'btn-primary',
        onClick: async () => {
          const name = val('m-item-name');
          const price = Number(val('m-item-price'));
          if (!name) { TN.toast('Name required', 'error'); return false; }
          if (!Number.isFinite(price) || price < 0) { TN.toast('Enter a valid price', 'error'); return false; }
          const body = {
            category_id: Number(val('m-item-cat')) || null,
            name, description: val('m-item-desc'),
            price, is_veg: val('m-item-veg') === '1',
            is_available: $('m-item-avail').checked,
          };
          if (item) await TN.api(`/api/menu/items/${item.id}`, { method: 'PUT', body });
          else await TN.api('/api/menu/items', { method: 'POST', body });
          TN.toast('Saved', 'success');
          await loadMenu();
        },
      },
    ]);
  }

  function confirmDeleteItem(item) {
    openModal('Delete item?', `<p>Delete "${esc(item.name)}"? Purane orders par iska asar nahi hoga.</p>`, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      { label: 'Delete', class: 'btn-danger', onClick: async () => { await TN.api(`/api/menu/items/${item.id}`, { method: 'DELETE' }); await loadMenu(); } },
    ]);
  }

  function confirmDeleteCategory(cat) {
    openModal('Delete category?', `<p>"${esc(cat.name)}" delete karein? Iske items menu mein rahenge (uncategorized).</p>`, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      { label: 'Delete', class: 'btn-danger', onClick: async () => { await TN.api(`/api/menu/categories/${cat.id}`, { method: 'DELETE' }); await loadMenu(); } },
    ]);
  }

  /* =============================== TABLES =============================== */

  async function loadTables() {
    const data = await TN.api('/api/tables');
    tablesData = data.tables;
    renderTables();
    qrSheet = null; // refresh lazily when printing / showing grid
    loadQrGrid();
  }

  function renderTables() {
    const body = $('tables-body');
    if (!tablesData.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty">Koi table nahi. "Add table" se shuru karein.</div></td></tr>';
      return;
    }
    body.innerHTML = '';
    tablesData.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="bold">${esc(t.name)}</td>
        <td>${t.seats}</td>
        <td><span class="badge ${t.is_active ? 'ready' : 'muted'}">${t.is_active ? 'active' : 'inactive'}</span></td>
        <td><a href="${t.menu_url}" target="_blank" class="tiny">${esc(t.menu_url.replace(/^https?:\/\//, ''))}</a></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-act="qr">QR</button>
          <button class="btn btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-sm btn-ghost" data-act="del">🗑</button>
        </td>`;
      tr.querySelector('[data-act="qr"]').addEventListener('click', () => showQr(t));
      tr.querySelector('[data-act="edit"]').addEventListener('click', () => tableModal(t));
      tr.querySelector('[data-act="del"]').addEventListener('click', () => deleteTable(t));
      body.appendChild(tr);
    });
  }

  async function loadQrGrid() {
    try {
      qrSheet = await TN.api('/api/tables/qr-sheet');
      const grid = $('qr-grid');
      grid.innerHTML = qrSheet.tables.length
        ? qrSheet.tables.map((t) => `
          <div class="qr-card">
            <img src="${t.qr}" alt="QR for ${esc(t.name)}" />
            <div class="tname">${esc(t.name)}</div>
            <div class="rname">${esc(qrSheet.restaurant.name)}</div>
            <div class="hint">Scan to open menu &amp; order</div>
          </div>`).join('')
        : '<div class="empty">QR codes ke liye pehle tables add karein.</div>';
    } catch (err) { console.error(err); }
  }

  async function showQr(t) {
    const data = await TN.api(`/api/tables/${t.id}/qr`);
    openModal(`QR — ${t.name}`, `
      <div class="qr-card" style="box-shadow:none;border:none">
        <img src="${data.qr}" alt="QR" />
        <div class="tname">${esc(t.name)}</div>
        <div class="rname">${esc(t.menu_url)}</div>
        <div class="hint">Print karke table par lagayein. Customer scan karke seedha yahi table ka menu kholega.</div>
      </div>`, [
      { label: 'Close', onClick: () => { closeModal(); } },
      { label: 'Print', class: 'btn-primary', onClick: () => { window.print(); } },
    ]);
  }

  $('add-table').addEventListener('click', () => tableModal(null));
  function tableModal(t) {
    openModal(t ? `Edit ${t.name}` : 'New table', `
      <div class="row">
        <div class="field"><label>Table name / number</label><input class="input" id="m-t-name" value="${t ? esc(t.name) : ''}" placeholder="e.g. Table 9" /></div>
        <div class="field"><label>Seats</label><input class="input" id="m-t-seats" type="number" min="1" value="${t ? t.seats : 4}" /></div>
      </div>
      ${t ? `<div class="field"><label style="display:flex;align-items:center;gap:10px">
        <span class="switch"><input type="checkbox" id="m-t-active" ${t.is_active ? 'checked' : ''}><span class="slider"></span></span> Active (QR scan kaam karega)
      </label></div>` : ''}
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: t ? 'Save' : 'Add', class: 'btn-primary',
        onClick: async () => {
          const name = val('m-t-name');
          if (!name) { TN.toast('Name required', 'error'); return false; }
          const body = { name, seats: Number(val('m-t-seats')) || 4 };
          if (t) body.is_active = $('m-t-active').checked;
          if (t) await TN.api(`/api/tables/${t.id}`, { method: 'PUT', body });
          else await TN.api('/api/tables', { method: 'POST', body });
          TN.toast('Saved', 'success');
          await loadTables();
        },
      },
    ]);
  }

  $('bulk-tables').addEventListener('click', () => {
    openModal('Bulk add tables', `
      <div class="row">
        <div class="field"><label>How many tables</label><input class="input" id="m-b-count" type="number" min="1" max="200" value="10" /></div>
        <div class="field"><label>Start numbering from</label><input class="input" id="m-b-start" type="number" min="1" value="1" /></div>
      </div>
      <div class="field"><label>Seats per table</label><input class="input" id="m-b-seats" type="number" min="1" value="4" /></div>
      <p class="tiny muted">Example: 10 tables starting at 1 → "Table 1" … "Table 10", har ek ka unique QR.</p>
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: 'Create', class: 'btn-primary',
        onClick: async () => {
          const res = await TN.api('/api/tables/bulk', { method: 'POST', body: {
            count: Number(val('m-b-count')), startNumber: Number(val('m-b-start')), seats: Number(val('m-b-seats')),
          } });
          TN.toast(`${res.created} tables added`, 'success');
          await loadTables();
        },
      },
    ]);
  });

  function deleteTable(t) {
    openModal('Delete table?', `<p>${esc(t.name)} delete karein? Iska purana QR code kaam karna band ho jayega.</p>`, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      { label: 'Delete', class: 'btn-danger', onClick: async () => { await TN.api(`/api/tables/${t.id}`, { method: 'DELETE' }); await loadTables(); } },
    ]);
  }

  $('print-qr').addEventListener('click', () => {
    if (!qrSheet) loadQrGrid().then(() => window.print());
    else window.print();
  });

  /* =============================== STAFF ================================ */

  async function loadStaff() {
    const data = await TN.api('/api/admin/staff');
    const body = $('staff-body');
    if (!data.staff.length) { body.innerHTML = '<tr><td colspan="5"><div class="empty">Koi staff nahi.</div></td></tr>'; }
    else {
      body.innerHTML = '';
      data.staff.forEach((u) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="bold">${esc(u.name)}</td>
          <td class="muted">${esc(u.email)}</td>
          <td><span class="role-pill ${u.role}">${u.role}</span></td>
          <td><span class="badge ${u.is_active ? 'ready' : 'muted'}">${u.is_active ? 'active' : 'disabled'}</span></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-sm" data-act="edit">Edit</button>
            <button class="btn btn-sm btn-ghost" data-act="del">🗑</button>
          </td>`;
        tr.querySelector('[data-act="edit"]').addEventListener('click', () => staffModal(u));
        tr.querySelector('[data-act="del"]').addEventListener('click', () => deleteStaff(u));
        body.appendChild(tr);
      });
    }
    await loadStaffScreens();
  }

  /**
   * The kitchen / cash-counter screen links + QR codes, so the owner can
   * share them with staff (or print a sticker for the tablet).
   */
  async function loadStaffScreens() {
    const host = $('staff-screens');
    try {
      const data = await TN.api('/api/admin/staff-screens');
      host.innerHTML = (data.screens || []).map((s) => `
        <div class="staff-screen">
          <img src="${s.qr}" alt="QR for ${esc(s.title)}" />
          <div class="grow">
            <div class="sc-title">${s.icon} ${esc(s.title)}</div>
            <div class="sc-url">${esc(s.url)}</div>
            <div class="flex gap8">
              <a class="btn btn-sm" href="${s.url}" target="_blank">Open ↗</a>
              <button class="btn btn-sm" data-copy="${esc(s.url)}">📋 Copy link</button>
            </div>
            <div class="sc-hint">Staff ko apna email + password do (neeche list mein). QR scan karte hi seedha yeh screen khul jayegi.</div>
          </div>
        </div>`).join('');

      host.querySelectorAll('[data-copy]').forEach((b) =>
        b.addEventListener('click', async () => {
          const text = b.dataset.copy;
          try {
            await navigator.clipboard.writeText(text);
            TN.toast('Link copy ho gaya', 'success');
          } catch (_) {
            TN.toast('Copy nahi hua — link manually select karein', 'error');
          }
        }));
    } catch (err) {
      host.innerHTML = '<div class="empty">Links load nahi ho paye.</div>';
    }
  }

  $('add-staff').addEventListener('click', () => staffModal(null));
  function staffModal(u) {
    openModal(u ? `Edit ${u.name}` : 'Add staff', `
      <div class="field"><label>Name</label><input class="input" id="m-s-name" value="${u ? esc(u.name) : ''}" /></div>
      <div class="field"><label>Email</label><input class="input" id="m-s-email" type="email" value="${u ? esc(u.email) : ''}" ${u ? 'readonly' : ''} /></div>
      <div class="field"><label>Password ${u ? '(leave blank to keep current)' : ''}</label><input class="input" id="m-s-pass" type="password" placeholder="Min 6 characters" /></div>
      <div class="field"><label>Role</label>
        <select class="input" id="m-s-role">
          <option value="kitchen" ${u && u.role === 'kitchen' ? 'selected' : ''}>👨‍🍳 Kitchen — orders accept/ready karega</option>
          <option value="cashier" ${u && u.role === 'cashier' ? 'selected' : ''}>💰 Cashier — bill &amp; payment</option>
          <option value="owner" ${u && u.role === 'owner' ? 'selected' : ''}>👑 Owner — full access</option>
        </select>
      </div>
      ${u ? `<div class="field"><label style="display:flex;align-items:center;gap:10px">
        <span class="switch"><input type="checkbox" id="m-s-active" ${u.is_active ? 'checked' : ''}><span class="slider"></span></span> Active
      </label></div>` : ''}
    `, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: u ? 'Save' : 'Add staff', class: 'btn-primary',
        onClick: async () => {
          const name = val('m-s-name');
          const email = val('m-s-email');
          const password = val('m-s-pass');
          if (!name || !email) { TN.toast('Name & email required', 'error'); return false; }
          if (!u && password.length < 6) { TN.toast('Password min 6 characters', 'error'); return false; }
          const role = val('m-s-role');
          if (u) {
            const body = { name, role, is_active: $('m-s-active').checked };
            if (password) body.password = password;
            await TN.api(`/api/admin/staff/${u.id}`, { method: 'PUT', body });
          } else {
            await TN.api('/api/admin/staff', { method: 'POST', body: { name, email, password, role } });
          }
          TN.toast('Saved', 'success');
          await loadStaff();
        },
      },
    ]);
  }

  function deleteStaff(u) {
    openModal('Delete staff?', `<p>${esc(u.name)} (${esc(u.email)}) delete karein?</p>`, [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      { label: 'Delete', class: 'btn-danger', onClick: async () => { await TN.api(`/api/admin/staff/${u.id}`, { method: 'DELETE' }); await loadStaff(); } },
    ]);
  }

  /* ============================== SETTINGS ============================== */

  async function loadSettings() {
    const data = await TN.api('/api/admin/restaurant');
    const r = data.restaurant;
    $('s-name').value = r.name || '';
    $('s-phone').value = r.phone || '';
    $('s-currency').value = r.currency || '₹';
    $('s-address').value = r.address || '';
    $('s-gst').value = r.gst_percent || 0;
  }

  $('save-settings').addEventListener('click', async () => {
    try {
      const data = await TN.api('/api/admin/restaurant', {
        method: 'PUT',
        body: {
          name: val('s-name'), phone: val('s-phone'), currency: val('s-currency') || '₹',
          address: val('s-address'), gst_percent: Number(val('s-gst')) || 0,
        },
      });
      currency = data.restaurant.currency || '₹';
      $('whoami').textContent = `${$('whoami').textContent.split('•')[0].trim()} • ${data.restaurant.name}`;
      TN.toast('Settings saved', 'success');
    } catch (err) { TN.toast(err.message, 'error'); }
  });

  /* =========================== NOTIFICATIONS ============================ */

  async function loadNotifications() {
    let data;
    try {
      data = await TN.api('/api/admin/notifications?limit=150');
    } catch (err) {
      TN.toast(err.message, 'error');
      return;
    }

    // Restaurant-level channel settings.
    const rest = (await TN.api('/api/admin/restaurant')).restaurant;
    $('n-country').value = rest.country_code || '+91';

    // Provider status — only browser push is supported.
    $('provider-badge').textContent = 'Browser push · active';
    $('provider-badge').className = 'badge ready';
    $('provider-hint').innerHTML =
      'Order <b>ready</b> ya <b>served</b> hote hi customer ke phone par browser notification jaata hai. ' +
      'Customer ko ek baar "Allow" karna hota hai — koi app install nahi karni. ' +
      'Push kaam karta hai kyunki site HTTPS par hai (public URL).';

    // Delivery log.
    const body = $('notif-body');
    const rows = data.notifications || [];
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="empty">Abhi koi notification nahi bheji gayi.</div></td></tr>';
      return;
    }
    body.innerHTML = rows.map((n) => {
      const cls = n.status === 'sent' ? 'ready' : n.status === 'failed' ? 'cancelled' : 'muted';
      const label = n.status === 'sent' ? 'sent' : n.status === 'failed' ? 'failed' : n.status;
      return `<tr>
        <td class="tiny muted">${TN.escapeHtml(TN.fmtTime(n.created_at))}</td>
        <td class="bold">${n.order_no ? '#' + n.order_no : '—'}${n.table_name ? '<div class="tiny muted">' + TN.escapeHtml(n.table_name) + '</div>' : ''}</td>
        <td>${TN.escapeHtml(n.channel)}</td>
        <td class="tiny">${TN.escapeHtml(n.recipient || '—')}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td class="tiny muted" style="max-width:320px">${TN.escapeHtml(n.body || '')}${n.error ? '<div style="color:var(--red)">' + TN.escapeHtml(n.error) + '</div>' : ''}</td>
      </tr>`;
    }).join('');
  }

  $('save-notif').addEventListener('click', async () => {
    try {
      await TN.api('/api/admin/notifications-settings', {
        method: 'PUT',
        body: { country_code: $('n-country').value.trim(), notify_channels: ['push'] },
      });
      TN.toast('Saved', 'success');
      loadNotifications();
    } catch (err) { TN.toast(err.message, 'error'); }
  });
  $('refresh-notif').addEventListener('click', loadNotifications);

  $('clear-notif').addEventListener('click', () => {
    openModal('Clear delivery log?', '<p>Saari purani notification entries mita di jayengi. Naye orders ke log bante rahenge.</p>', [
      { label: 'Cancel', onClick: () => { closeModal(); } },
      {
        label: 'Clear', class: 'btn-danger',
        onClick: async () => { await TN.api('/api/admin/notifications', { method: 'DELETE' }); loadNotifications(); },
      },
    ]);
  });

  /* ============================== SOCKET =============================== */

  function connectSocket() {
    const token = TN.getToken();
    if (!token) return; // not logged in — no point connecting
    const socket = io({ auth: { token } });
    socket.on('unauthorized', () => {
      TN.toast('Session expire ho gaya — dobara login karein', 'error');
      setTimeout(() => { window.location.href = '/login?expired=1'; }, 900);
    });
    socket.on('order:update', () => {
      if (!$('panel-dashboard').classList.contains('hidden')) loadDashboard();
    });
  }

  $('logout').addEventListener('click', () => TN.logout());

  boot().catch((err) => { if (err.status !== 401) TN.toast(err.message, 'error'); });
})();
