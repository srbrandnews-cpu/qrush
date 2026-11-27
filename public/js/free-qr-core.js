    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const TOKEN_KEY = 'fq_token';
    let ownerToken = '';
    let current = null;        // publicFreeQr() payload
    let currentStats = null;   // stats payload
    let revision = 0;          // cache-buster for logo/menu previews
    let pendingLogo = null;    // data-URI chosen in the modal
    let pendingMenu = null;    // { data, type } chosen in the modal
    let currentItems = [];     // orderable items (free_qr_items)
    let itemsDirty = false;    // true while the owner is typing in the items box

    function setToken(t) {
      ownerToken = t || '';
      try {
        if (t) localStorage.setItem(TOKEN_KEY, t);
        else localStorage.removeItem(TOKEN_KEY);
      } catch (_) { /* private mode */ }
    }

    function getStoredToken() {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
    }

    function toast(msg, isError) {
      const el = $('toast');
      el.textContent = msg;
      el.className = 'show' + (isError ? ' err' : '');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { el.className = ''; }, 2600);
    }

    /* Inline feedback for the generator form (no browser alert pop-ups). */
    function genError(msg) {
      const el = $('g-error');
      if (!el) return;
      el.textContent = msg || '';
      if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function genClearError() {
      const el = $('g-error');
      if (el) el.textContent = '';
    }

    /* ---------------------------- small helpers ---------------------------- */
    // Every QR code and shared menu link must point at the live QRush domain,
    // never at the old website URL. Local development keeps localhost.
    const PUBLIC_BASE = 'https://www.qrush.in';
    function publicBase() {
      const h = String(location.hostname || '');
      if (!h || h === 'localhost' || h === '127.0.0.1' || /^192\.168\./.test(h) || h === '[::1]') {
        return location.origin;
      }
      if (/(^|\.)qrush\.in$/i.test(h)) return location.origin;
      return PUBLIC_BASE;
    }

    function absoluteMenuUrl(restaurant) {
      const rel = (restaurant && (restaurant.url || ('/m/' + restaurant.slug))) || '/';
      return rel.startsWith('http') ? rel : publicBase() + rel;
    }

    function prettyPhone(value) {
      const d = String(value || '').replace(/\D/g, '');
      if (d.length === 12 && d.startsWith('91')) return '+91 ' + d.slice(2, 7) + ' ' + d.slice(7);
      if (d.length === 10) return '+91 ' + d.slice(0, 5) + ' ' + d.slice(5);
      return String(value || '');
    }

    function withRev(url) {
      if (!url || !String(url).startsWith('/')) return url || '';
      return url + (String(url).includes('?') ? '&' : '?') + 'v=' + revision;
    }

    function isPdf() {
      return !!(current && (current.menu_type === 'pdf' || /\.pdf$/i.test(current.menu_url || '')));
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }

    // Phone cameras produce 3–8MB photos; base64 makes them ~35% bigger, which
    // used to hit the API body limit. Re-encode big images down to a
    // web-friendly size before uploading. Small files are sent untouched.
    function prepareImageFile(file, opts) {
      const o = opts || {};
      const maxDim = o.maxDim || 1600;
      const quality = o.quality || 0.84;
      const keepUnder = o.keepUnder || 700 * 1024;

      if (!/^image\//i.test(file.type || '')) return readFileAsDataUrl(file);
      if (file.size <= keepUnder) return readFileAsDataUrl(file);

      return new Promise((resolve) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        const fallback = () => {
          try { URL.revokeObjectURL(objectUrl); } catch (_) {}
          readFileAsDataUrl(file).then(resolve);
        };

        img.onload = () => {
          try {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            const scale = Math.min(1, maxDim / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            const isPng = /png/i.test(file.type || '');
            if (!isPng) {
              // JPEG has no alpha — paint white so transparent areas don't go black.
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, w, h);
            }
            ctx.drawImage(img, 0, 0, w, h);
            try { URL.revokeObjectURL(objectUrl); } catch (_) {}

            const out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
            // Keep original if compression did not actually help.
            if (out && out.length < file.size * 1.37) resolve(out);
            else readFileAsDataUrl(file).then(resolve);
          } catch (_) {
            fallback();
          }
        };
        img.onerror = fallback;
        img.src = objectUrl;
      });
    }

    // Menu pages: big pixel size is fine, just keep the file small.
    async function prepareMenuImage(file) {
      const dataUrl = await prepareImageFile(file, { maxDim: 1600, quality: 0.84 });
      if (dataUrl && dataUrl.length > 6 * 1024 * 1024) {
        throw new Error('Image bahut badi hai — chhoti photo try karein');
      }
      return dataUrl;
    }

    // Logos: small and crisp, keep PNG transparency.
    async function prepareLogoImage(file) {
      const dataUrl = await prepareImageFile(file, { maxDim: 600, quality: 0.9, keepUnder: 400 * 1024 });
      if (dataUrl && dataUrl.length > 2 * 1024 * 1024) {
        throw new Error('Logo bahut bada hai — chhoti image try karein');
      }
      return dataUrl;
    }

    function fmtDate(value) {
      if (!value) return '—';
      const d = new Date(String(value).replace(' ', 'T') + 'Z');
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /* --------------------------- orderable items --------------------------- */
    function rupees(n) {
      const v = Number(n) || 0;
      return '₹' + (v % 1 === 0 ? String(v) : v.toFixed(2));
    }

    // "Chicken Tikka, 299, Starters" -> { name, price, category }
    // Also accepts tabs / pipes and "Chicken Tikka 299" without a delimiter.
    function parseItemsText(text) {
      const out = [];
      String(text || '').split(/\r?\n/).forEach((line) => {
        const raw = line.trim();
        if (!raw) return;
        const parts = raw.split(/\s*[,\t|]\s*/).filter((p) => p !== '');
        if (!parts.length) return;

        let priceIdx = -1;
        for (let i = 1; i < parts.length; i += 1) {
          if (/^(?:₹|rs\.?|inr)?\s*\d+(?:\.\d+)?$/i.test(parts[i])) { priceIdx = i; break; }
        }

        let name;
        let price;
        let category;
        if (priceIdx >= 0) {
          name = parts.slice(0, priceIdx).join(', ');
          price = Number(String(parts[priceIdx]).replace(/[^\d.]/g, '')) || 0;
          category = parts.slice(priceIdx + 1).join(', ');
        } else {
          const tail = /^(.*?)\s+[₹]?\s*(\d+(?:\.\d+)?)$/.exec(raw);
          if (tail) {
            name = tail[1];
            price = Number(tail[2]) || 0;
          } else {
            name = raw;
            price = 0;
          }
          category = '';
        }

        name = String(name || '').trim();
        if (!name) return;
        out.push({
          name: name.slice(0, 120),
          price: Math.max(0, Math.min(1000000, price)),
          category: String(category || '').trim().slice(0, 60),
          available: true,
        });
      });
      return out;
    }

    function itemsToText(items) {
      return (items || []).map((it) => {
        const bits = [it.name, it.price];
        if (it.category) bits.push(it.category);
        return bits.join(', ');
      }).join('\n');
    }

    function updateKitchenLink() {
      if (!current) return;
      const base = absoluteMenuUrl(current).replace(/\/+$/, '');
      const el = $('d-kitchen');
      if (el) el.href = base + '/kitchen#t=' + encodeURIComponent(ownerToken || '');
    }

    /* ------------------------------ QR code -------------------------------- */
    function makeQr(container, text, size) {
      container.innerHTML = '';
      new QRCode(container, {
        text,
        width: size,
        height: size,
        colorDark: '#06183F',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
      const qrImg = container.querySelector('img');
      if (qrImg) qrImg.alt = 'QR code';
      return container.querySelector('canvas');
    }

    function loadQrushLogo() {
      return new Promise((resolve) => {
        try {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = '/img/qrush-logo.png?v=3';
        } catch (_) {
          resolve(null);
        }
      });
    }

    async function qrDataUrl(size) {
      const tmp = document.createElement('div');
      tmp.style.position = 'fixed';
      tmp.style.left = '-9999px';
      tmp.style.top = '0';
      document.body.appendChild(tmp);
      let url = '';
      try {
        const canvas = makeQr(tmp, absoluteMenuUrl(current), size);
        if (canvas) {
          const pad = Math.round(size * 0.07);
          const footH = Math.round(size * 0.26);
          const out = document.createElement('canvas');
          out.width = size + pad * 2;
          out.height = size + pad * 2 + footH;
          const ctx = out.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(canvas, pad, pad);

          // ---- Premium branding footer: restaurant name + tagline + QRush logo ----
          const footTop = size + pad * 2;
          const cx = out.width / 2;
          const name = (current.restaurant || 'My Restaurant').trim();

          ctx.fillStyle = '#0b1220';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const nameSize = Math.max(14, Math.round(size * 0.055));
          ctx.font = '800 ' + nameSize + 'px "Segoe UI", Arial, sans-serif';
          ctx.fillText(name, cx, footTop + Math.round(size * 0.02), out.width - pad * 2);

          ctx.fillStyle = '#64748b';
          ctx.font = '500 ' + Math.max(11, Math.round(size * 0.032)) + 'px "Segoe UI", Arial, sans-serif';
          ctx.fillText('Scan to view our menu', cx, footTop + Math.round(size * 0.02) + nameSize + Math.round(size * 0.012));

          const logo = await loadQrushLogo();
          if (logo && logo.naturalWidth && logo.naturalHeight) {
            const logoH = Math.round(size * 0.07);
            const logoW = Math.min(
              Math.round((logo.naturalWidth / logo.naturalHeight) * logoH),
              out.width - pad * 2
            );
            const logoY = out.height - logoH - Math.round(size * 0.02);
            ctx.drawImage(logo, cx - logoW / 2, logoY, logoW, logoH);
          } else {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '600 ' + Math.max(10, Math.round(size * 0.028)) + 'px "Segoe UI", Arial, sans-serif';
            ctx.fillText('Powered by QRush', cx, out.height - Math.round(size * 0.05));
          }

          url = out.toDataURL('image/png');
        } else {
          const img = tmp.querySelector('img');
          url = img ? img.src : '';
        }
      } finally {
        document.body.removeChild(tmp);
      }
      return url;
    }

    /* ---------------------------- dashboard render -------------------------- */
    function renderDashboard() {
      if (!current) return;

      $('d-name').textContent = current.restaurant || 'My Restaurant';
      const bits = [];
      if (current.owner_name) bits.push('By ' + current.owner_name);
      if (current.phone) bits.push('📞 ' + prettyPhone(current.phone));
      $('d-sub').textContent = bits.join(' · ');

      const logo = $('d-logo');
      const fallback = $('d-fallback');
      if (current.logo_url) {
        logo.src = withRev(current.logo_url);
        logo.classList.remove('hidden');
        fallback.classList.add('hidden');
      } else {
        logo.classList.add('hidden');
        fallback.classList.remove('hidden');
        fallback.textContent = (current.restaurant || 'R').charAt(0).toUpperCase();
      }

      // Stats (real recorded data)
      const s = currentStats || {};
      const views = s.views || { total: 0, today: 0, unique: 0, week: 0, month: 0 };
      const clicks = s.clicks || {};
      const clickTotal = s.click_total || { total: 0, today: 0 };
      $('s-view-total').textContent = views.total || 0;
      $('s-view-unique').textContent = views.unique || 0;
      if ($('s-week')) $('s-week').textContent = views.week || 0;
      if ($('s-month')) $('s-month').textContent = views.month || 0;
      const clickTotalAll = s.click_total
        ? (Number(s.click_total.total) || 0)
        : Object.keys(clicks).reduce((sum, k) => sum + (Number(clicks[k] && clicks[k].total) || 0), 0);
      if ($('s-click-total')) $('s-click-total').textContent = clickTotalAll;
      $('s-view-today').textContent = (views.today || 0) + ' today';
      const pc = (current.profile_completion || { percent: 0, done: 0, total: 0 });
      $('s-profile').textContent = (pc.percent || 0) + '%';
      $('s-profile-hint').textContent = (pc.done || 0) + ' of ' + (pc.total || 0) + ' complete';
      const planName = String(current.plan || 'free').charAt(0).toUpperCase() + String(current.plan || 'free').slice(1);
      $('s-plan').textContent = 'Plan: ' + planName + ' · ' + (current.plan_status || 'active');
      const menuOk = (current.menu_status === 'active');
      $('s-status').textContent = (menuOk ? 'Menu ready' : 'Menu missing') + ' · QR ' + (current.qr_status || 'active');
      $('s-live').textContent = 'Menu live since ' + fmtDate(current.created_at);
      const missing = (pc.checks || []).filter(c => !c.ok).map(c => c.key);
      if ($('s-profile-missing')) {
        $('s-profile-missing').textContent = missing.length
          ? 'Missing: ' + missing.join(', ')
          : 'Your profile is complete.';
      }

      const publicUrl = absoluteMenuUrl(current);
      if ($('qa-open')) $('qa-open').href = publicUrl;
      if ($('d-open')) $('d-open').href = publicUrl;

      // Recent activity
      const recentEl = $('d-recent');
      if (recentEl) {
        const recent = Array.isArray(s.recent) ? s.recent : [];
        if (!recent.length) {
          recentEl.innerHTML = '<li class="click-row"><span class="click-name">No activity recorded yet</span><span class="click-count">—</span></li>';
        } else {
          const label = (k) => ({ view: 'Menu view/scan', whatsapp: 'WhatsApp click', instagram: 'Instagram click', facebook: 'Facebook click', website: 'Website click', order: 'Order placed' }[k] || k);
          recentEl.innerHTML = recent.slice(0, 10).map(r => (
            '<li class="click-row">' +
            '<span class="click-dot" style="background:#94a3b8"></span>' +
            '<span class="click-name">' + label(r.kind) + '</span>' +
            '<span class="click-today">' + fmtDate(r.created_at) + '</span>' +
            '</li>'
          )).join('');
        }
      }

      // 7-day daily views (real)
      const dailyEl = $('d-daily');
      if (dailyEl) {
        const daily = Array.isArray(s.daily) ? s.daily : [];
        const map = new Map(daily.map((d) => [d.day, Number(d.views) || 0]));
        const days = [];
        const now = new Date();
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
          const key = d.toISOString().slice(0, 10);
          days.push({ key, views: map.get(key) || 0 });
        }
        const max = Math.max(1, ...days.map((d) => d.views));
        dailyEl.innerHTML = days.map((d) => {
          const label = new Date(d.key + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
          return '<div style="display:flex;align-items:center;gap:10px">' +
            '<span class="tiny muted" style="width:64px;flex:none">' + label + '</span>' +
            '<span style="flex:1;background:#f1f5f9;border-radius:6px;height:10px;overflow:hidden"><span style="display:block;height:100%;width:' + Math.round((d.views / max) * 100) + '%;background:var(--primary,#ea580c)"></span></span>' +
            '<span class="small" style="width:34px;text-align:right;flex:none">' + d.views + '</span>' +
            '</div>';
        }).join('');
      }

      // Per-network click breakdown
      const nets = [
        { key: 'whatsapp', label: 'WhatsApp', color: '#25d366', on: !!current.whatsapp },
        { key: 'instagram', label: 'Instagram', color: '#dc2743', on: !!current.instagram },
        { key: 'facebook', label: 'Facebook', color: '#1877f2', on: !!current.facebook },
        { key: 'website', label: 'Website', color: '#ea580c', on: !!current.website },
      ];
      $('d-click-list').innerHTML = nets.map((n) => {
        const c = clicks[n.key] || { total: 0, today: 0 };
        return '<li class="click-row' + (n.on ? '' : ' off') + '">' +
          '<span class="click-dot" style="background:' + n.color + '"></span>' +
          '<span class="click-name">' + n.label + (n.on ? '' : ' <span class="tiny">(not set)</span>') + '</span>' +
          '<span class="click-count">' + (c.total || 0) + '</span>' +
          '<span class="click-today">' + (c.today || 0) + ' today</span>' +
          '</li>';
      }).join('');

      // Menu gallery (supports multiple uploaded images)
      const gallery = $('d-menu-gallery');
      if (gallery) {
        const urls = Array.isArray(current.menu_urls) ? current.menu_urls : (current.menu_url ? [current.menu_url] : []);
        if (!urls.length) {
          gallery.innerHTML = '<div class="menu-gallery-empty">Koi menu upload nahi hua. Upar se images add karein.</div>';
        } else {
          gallery.innerHTML = urls.map((u, i) =>
            '<div class="menu-gallery-item" data-idx="' + i + '">' +
            '<img src="' + withRev(u) + '" alt="Menu ' + (i + 1) + '" />' +
            '<button class="mg-remove" type="button" data-act="remove-image" data-idx="' + i + '" title="Remove">✕</button>' +
            '</div>'
          ).join('');
        }
      }

      // OCR button — only for image menus.
      const ocrBtn = $('d-ocr');
      if (ocrBtn) {
        const hasImage = !!(current.menu_urls && current.menu_urls.length) || (current.menu_url && !isPdf());
        ocrBtn.style.display = hasImage ? '' : 'none';
      }
      makeQr($('d-qr'), absoluteMenuUrl(current), 200);
      $('g-open-menu').href = absoluteMenuUrl(current);

      // Dish list (item-wise menu)
      if (typeof renderDishes === 'function') renderDishes();

      // Load billing info
      loadFqBilling();
    }

    async function loadFqBilling() {
      if (!current) return;
      const token = ownerToken || getStoredToken();
      try {
        const res = await fetch('/api/public/free-qr/billing', { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load billing');
        const r = data.restaurant || {};
        const plan = String(r.plan || 'free').toLowerCase();
        const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
        const price = plan === 'starter' ? '₹149/month' : plan === 'business' ? '₹299/month' : '₹0';
        const remaining = data.remaining_days;
        const expiry = r.plan_expires_at ? (TN.fmtDate ? TN.fmtDate(r.plan_expires_at) : r.plan_expires_at) : 'N/A';
        const whatsappNumber = data.whatsapp_number || '';

        const el = $('fq-billing-current');
        if (el) {
          el.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px">
              <div class="mini-stat"><div class="label">Current Plan</div><div class="value" style="font-size:20px">${esc(planLabel)}</div><div class="sub">${price}</div></div>
              <div class="mini-stat"><div class="label">Status</div><div class="value" style="font-size:20px">${esc(r.plan_status || 'active')}</div></div>
              <div class="mini-stat"><div class="label">Expires</div><div class="value" style="font-size:16px">${esc(expiry)}</div><div class="sub">${remaining !== null ? remaining + ' days left' : 'No expiry'}</div></div>
            </div>
            ${plan === 'free' ? `
            <div class="tiny muted" style="margin-bottom:10px">Upgrade to Starter (₹149/month) or Business (₹299/month) for enhanced features. Contact us on WhatsApp to subscribe.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-primary btn-sm" id="fq-upgrade-starter">Upgrade to Starter ₹149</button>
              <button class="btn btn-outline btn-sm" id="fq-upgrade-business">Upgrade to Business ₹299</button>
            </div>
            ` : `
            <div class="tiny muted">Your plan is active. To renew or change plan, contact us on WhatsApp.</div>
            <div style="margin-top:10px">
              <button class="btn btn-outline btn-sm" id="fq-renew">Renew / Change Plan via WhatsApp</button>
            </div>
            `}
          `;
        }

        // Wire upgrade buttons
        const bindUpgrade = (btnId, p) => {
          const btn = $(btnId);
          if (btn) btn.addEventListener('click', () => fqRequestUpgrade(p));
        };
        bindUpgrade('fq-upgrade-starter', 'starter');
        bindUpgrade('fq-upgrade-business', 'business');
        if ($('fq-renew')) {
          $('fq-renew').addEventListener('click', () => fqRequestUpgrade(plan === 'starter' ? 'business' : 'starter'));
        }

        // Plan comparison
        const prices = data.plan_prices || {};
        const features = data.plan_features || {};
        const plans = ['free', 'starter', 'business'];
        const planNames = { free: 'Free', starter: 'Starter', business: 'Business' };
        const planPrices = { free: '₹0', starter: '₹' + (prices.starter || '149') + '/month', business: '₹' + (prices.business || '299') + '/month' };
        const plansEl = $('fq-billing-plans');
        if (plansEl) {
          plansEl.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
              ${plans.map((p) => `
                <div class="dash-card" style="border:2px solid ${p === plan ? 'var(--primary)' : 'var(--line)'};padding:12px">
                  <div style="font-weight:800;font-size:16px;margin-bottom:2px">${planNames[p]}</div>
                  <div style="font-size:20px;font-weight:900;margin-bottom:6px">${planPrices[p]}</div>
                  <div class="tiny muted" style="margin-bottom:8px">${features[p] || ''}</div>
                  ${p === plan ? '<span class="badge ready">Current</span>' : (p === 'free' ? '' : `<button class="btn btn-sm btn-primary" data-fq-upgrade="${p}">Upgrade</button>`)}
                </div>
              `).join('')}
            </div>
          `;
          plansEl.querySelectorAll('[data-fq-upgrade]').forEach((btn) => {
            btn.addEventListener('click', () => fqRequestUpgrade(btn.dataset.fqUpgrade));
          });
        }

        // Payment history
        const payments = data.payments || [];
        const histEl = $('fq-billing-history');
        if (histEl) {
          histEl.innerHTML = payments.length ? `
            <div class="tiny muted" style="margin-bottom:6px"><b>Payment History</b></div>
            ${payments.map((p) => `
              <div class="click-row" style="padding:6px 0">
                <span class="click-name">${esc(p.plan)} · ₹${p.amount}</span>
                <span class="badge ${p.status === 'confirmed' ? 'ready' : p.status === 'pending' ? 'preparing' : 'muted'}" style="margin-left:auto">${esc(p.status)}</span>
              </div>
            `).join('')}
          ` : '';
        }
      } catch (err) {
        console.error('FQ billing load error:', err);
        const el = $('fq-billing-current');
        if (el) el.innerHTML = '<div class="tiny muted">Could not load billing info.</div>';
      }
    }

    async function fqRequestUpgrade(plan) {
      try {
        const token = ownerToken || getStoredToken();
        const reqRes = await fetch('/api/public/free-qr/billing/request-upgrade', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        });
        const reqData = await reqRes.json();
        if (!reqRes.ok) throw new Error(reqData.error || 'Request failed');
        const wlRes = await fetch('/api/public/free-qr/billing/whatsapp-link?plan=' + plan, { headers: { Authorization: 'Bearer ' + token } });
        const wlData = await wlRes.json();
        if (wlData.link) {
          window.open(wlData.link, '_blank');
          toast('WhatsApp opened. Please complete payment and wait for admin confirmation.', false);
        } else {
          toast(wlData.message || 'WhatsApp not configured. Please contact support.', true);
        }
        loadFqBilling();
      } catch (err) {
        toast(err.message || 'Upgrade request failed', true);
      }
    }


    function showOwner(restaurant, stats, items) {
      current = restaurant;
      currentStats = stats || null;
      currentItems = Array.isArray(items) ? items : [];
      itemsDirty = false;
      revision = Date.now();

      document.body.classList.add('owner-mode');
      $('login-card').classList.add('hidden');
      $('side-panel').classList.add('hidden');
      $('generator-panel').classList.add('hidden');
      $('generator').classList.add('hidden');
      $('dashboard').classList.remove('hidden');
      $('jump-login').classList.add('hidden');

      renderDashboard();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showLogin() {
      current = null;
      currentStats = null;
      currentItems = [];
      itemsDirty = false;
      document.body.classList.remove('owner-mode');
      $('dashboard').classList.add('hidden');
      $('generator').classList.remove('hidden');
      $('generator-panel').classList.remove('hidden');
      $('side-panel').classList.remove('hidden');
      $('login-card').classList.remove('hidden');
      $('jump-login').classList.remove('hidden');
      $('g-error').textContent = '';
    }

    /* ------------------------------- edit modal ----------------------------- */
    function openEdit() {
      if (!current) return;
      pendingLogo = null;
      pendingMenu = null;
      $('m-error').textContent = '';
      $('m-pass').value = '';

      $('m-rest').value = current.restaurant || '';
      $('m-owner').value = current.owner_name || '';
      $('m-phone').value = current.phone || '';
      $('m-address').value = current.address || '';
      $('m-open').value = current.opening_hours || '';
      $('m-close-time').value = current.closing_hours || '';
      $('m-desc').value = current.description || '';
      $('m-whatsapp').value = current.whatsapp || '';
      $('m-instagram').value = current.instagram || '';
      $('m-facebook').value = current.facebook || '';
      $('m-website').value = current.website || '';

      $('m-logo').src = current.logo_url ? withRev(current.logo_url) : '';
      $('m-logo').style.visibility = current.logo_url ? 'visible' : 'hidden';

      const thumb = $('m-menu-thumb');
      if (!current.menu_url) thumb.innerHTML = '<span class="tiny muted">No file</span>';
      else if (isPdf()) thumb.innerHTML = '<span style="font-size:22px">📄</span>';
      else thumb.innerHTML = '<img src="' + withRev(current.menu_url) + '" alt="Menu" />';

      $('edit-modal').classList.remove('hidden');
      setTimeout(() => $('m-rest').focus(), 60);
    }

    function closeEdit() {
      $('edit-modal').classList.add('hidden');
    }

    $('d-edit').addEventListener('click', openEdit);
    $('m-close').addEventListener('click', closeEdit);
    $('m-cancel').addEventListener('click', closeEdit);
    $('edit-modal').addEventListener('click', (e) => {
      if (e.target === $('edit-modal')) closeEdit();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('edit-modal').classList.contains('hidden')) closeEdit();
    });

    $('m-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!/^image\//i.test(file.type || '')) { toast('Logo ke liye image chunein', true); e.target.value = ''; return; }
      try {
        pendingLogo = await prepareLogoImage(file);
        $('m-logo').src = pendingLogo;
        $('m-logo').style.visibility = 'visible';
      } catch (err) {
        toast(err.message || 'Logo upload nahi hua', true);
      } finally {
        e.target.value = '';
      }
    });

    $('m-menu-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!/^image\//i.test(file.type || '') && !/pdf/i.test(file.type || '')) {
        toast('Sirf image ya PDF upload kar sakte hain', true);
        e.target.value = '';
        return;
      }
      if (file.size > 20 * 1024 * 1024) { toast('File bahut badi hai (max 20MB)', true); e.target.value = ''; return; }
      try {
        const isPdfFile = /pdf/i.test(file.type || '');
        const isHeicFile = /hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');
        const data = isPdfFile ? await readFileAsDataUrl(file) : await prepareMenuImage(file);
        pendingMenu = { data, type: isPdfFile ? 'pdf' : 'image' };
        // HEIC previews do not render in most browsers; the server turns the
        // photo into JPEG on save, so show a friendly placeholder here.
        $('m-menu-thumb').innerHTML = pendingMenu.type === 'pdf'
          ? '<span style="font-size:22px">📄</span>'
          : (isHeicFile
            ? '<span style="font-size:22px" title="iPhone photo — save karte hi dikhegi">📷</span>'
            : '<img src="' + data + '" alt="Menu" />');
      } catch (err) {
        toast(err.message || 'Image upload nahi hui', true);
      } finally {
        e.target.value = '';
      }
    });

    async function patchOwner(body) {
      let res;
      try {
        res = await fetch('/api/public/free-qr/me', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + ownerToken,
          },
          body: JSON.stringify(body),
        });
      } catch (_) {
        throw new Error('Internet connection check karein');
      }
      if (res.status === 413) throw new Error('File bahut badi hai — chhoti image upload karein');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save nahi hua (' + res.status + ')');
      return data;
    }

    // The owner endpoints all return { restaurant, stats, items }.
    function applyOwnerPayload(data) {
      if (!data) return;
      if (data.restaurant) current = data.restaurant;
      if (data.stats) currentStats = data.stats;
      if (Array.isArray(data.items)) currentItems = data.items;
    }

    async function saveItems(payload) {
      const res = await fetch('/api/public/free-qr/items', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ownerToken,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Items save nahi hue');
      return data;
    }

    $('m-save').addEventListener('click', async () => {
      const rest = $('m-rest').value.trim();
      if (!rest) { $('m-error').textContent = 'Restaurant ka naam zaroori hai.'; return; }

      const body = {
        restaurant: rest,
        owner_name: $('m-owner').value.trim(),
        phone: $('m-phone').value.trim(),
        address: $('m-address').value.trim(),
        opening_hours: $('m-open').value.trim(),
        closing_hours: $('m-close-time').value.trim(),
        description: $('m-desc').value.trim(),
        whatsapp: $('m-whatsapp').value.trim(),
        instagram: $('m-instagram').value.trim(),
        facebook: $('m-facebook').value.trim(),
        website: $('m-website').value.trim(),
      };
      if (pendingLogo) body.logo_url = pendingLogo;
      if (pendingMenu) { body.menu_data = pendingMenu.data; body.menu_type = pendingMenu.type; }
      const pw = $('m-pass').value;
      if (pw) body.password = pw;

      $('m-error').textContent = '';
      $('m-save').disabled = true;
      $('m-save').textContent = 'Saving...';
      try {
        const data = await patchOwner(body);
        const wasMenuUpload = !!pendingMenu;
        const wasPdf = pendingMenu && pendingMenu.type === 'pdf';
        pendingLogo = null;
        pendingMenu = null;
        applyOwnerPayload(data);
        revision = Date.now();
        renderDashboard();
        closeEdit();
        toast('✅ Page update ho gaya!');
        if (wasMenuUpload && !wasPdf && typeof autoGenerateFromCard === 'function') {
          setTimeout(() => { autoGenerateFromCard(true); }, 400);
        }
      } catch (err) {
        $('m-error').textContent = err.message;
      } finally {
        $('m-save').disabled = false;
        $('m-save').textContent = 'Save changes';
      }
    });

    // Add one or more menu images (appended to the existing ones).
    $('d-menu-file').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      for (const f of files) {
        if (!/^image\//i.test(f.type || '') && !/pdf/i.test(f.type || '')) {
          toast('Sirf image ya PDF upload kar sakte hain', true);
          e.target.value = '';
          return;
        }
        if (f.size > 20 * 1024 * 1024) {
          toast('File bahut badi hai (max 20MB)', true);
          e.target.value = '';
          return;
        }
      }
      toast('Images upload ho rahi hain...');
      try {
        const newUrls = await Promise.all(
          files.map((f) => (/pdf/i.test(f.type || '') ? readFileAsDataUrl(f) : prepareMenuImage(f)))
        );
        const type = files[0] && /pdf/i.test(files[0].type) ? 'pdf' : 'image';

        const exRes = await fetch('/api/public/free-qr/menu-data', { headers: { Authorization: 'Bearer ' + ownerToken } });
        const exData = await exRes.json();
        const existing = Array.isArray(exData.images) ? exData.images : [];
        const combined = existing.concat(newUrls);

        const out = await patchOwner({ menu_data: JSON.stringify(combined), menu_type: type });
        applyOwnerPayload(out);
        revision = Date.now();
        renderDashboard();
        toast('✅ ' + newUrls.length + ' image(s) add ho gayi!');
        // Auto-detect dishes from the uploaded menu card (OCR) — no manual button needed.
        if (typeof autoGenerateFromCard === 'function') {
          setTimeout(() => { autoGenerateFromCard(true); }, 300);
        }
      } catch (err) {
        toast(err.message, true);
      } finally {
        e.target.value = '';
      }
    });

    // Remove a single image from the gallery.
    $('d-menu-gallery').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act="remove-image"]');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-idx'));
      if (!Number.isFinite(idx)) return;
      toast('Removing image...');
      try {
        const exRes = await fetch('/api/public/free-qr/menu-data', { headers: { Authorization: 'Bearer ' + ownerToken } });
        const exData = await exRes.json();
        const existing = Array.isArray(exData.images) ? exData.images : [];
        existing.splice(idx, 1);
        const type = existing.length ? 'image' : (current.menu_type || 'image');
        const out = await patchOwner({ menu_data: existing.length ? JSON.stringify(existing) : '', menu_type: type });
        applyOwnerPayload(out);
        revision = Date.now();
        renderDashboard();
        toast(existing.length ? '✅ Image remove ho gayi' : '✅ All images removed');
      } catch (err) {
        toast(err.message, true);
      }
    });

    /* ----------------------------- OCR Converter ----------------------------- */
    function parseOcrText(text) {
      const lines = String(text || '').split(/\r?\n/);
      let currentCategory = 'Menu';
      const items = [];
      const noiseRe = /^(menu|welcome|tax|gst|service charge|phone|mobile|tel|address|contact|order|timing|pure veg|non veg|page \d+)$/i;

      for (const rawLine of lines) {
        let line = rawLine.trim().replace(/\s+/g, ' ');
        if (!line || line.length < 2) continue;
        if (noiseRe.test(line)) continue;

        const priceMatch = /(?:(?:rs\.?|inr|₹)\s*)?(\d{2,5})(?:\s*[\/\-]{1,2})?\s*$/i.exec(line);

        if (priceMatch) {
          const price = Number(priceMatch[1]);
          let namePart = line.slice(0, priceMatch.index).trim();
          namePart = namePart.replace(/[\.\s\:\-\_\|]+$/, '').trim();
          namePart = namePart.replace(/^(?:\d+[\.\)\-]|[\u2022\u2023\u25E6\u2043\u2219\*\-])\s*/, '').trim();

          if (namePart && namePart.length >= 2 && !noiseRe.test(namePart) && price > 0 && price <= 50000) {
            items.push({
              name: namePart,
              price: price,
              category: currentCategory,
              available: true,
            });
            continue;
          }
        }

        if (!/\d/.test(line) && line.length <= 40) {
          const cleanCat = line.replace(/^[\*\-\#\s]+|[\*\-\#\s]+$/g, '').trim();
          if (cleanCat && cleanCat.length >= 3 && !noiseRe.test(cleanCat)) {
            currentCategory = cleanCat.charAt(0).toUpperCase() + cleanCat.slice(1);
          }
        }
      }
      return items;
    }

    function preprocessForOcr(imageUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const maxDim = 2200;
            let w = img.naturalWidth || img.width || 1;
            let h = img.naturalHeight || img.height || 1;
            const scale = Math.min(1, maxDim / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h);
            const px = data.data;
            for (let i = 0; i < px.length; i += 4) {
              const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
              let v = (g - 128) * 1.35 + 128;
              if (v < 0) v = 0; else if (v > 255) v = 255;
              // binarize lightly to help OCR on menu cards
              v = v > 150 ? 255 : (v < 95 ? 0 : v);
              px[i] = px[i + 1] = px[i + 2] = v;
            }
            ctx.putImageData(data, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          } catch (_) {
            resolve(imageUrl);
          }
        };
        img.onerror = () => resolve(imageUrl);
        img.src = imageUrl;
      });
    }

    async function runMenuOcr(imageUrl) {
      const statusEl = $('d-ocr-status');
      const btn = $('d-ocr');
      if (!imageUrl || isPdf()) {
        if (statusEl) statusEl.textContent = 'Image file zaroori hai OCR ke liye.';
        return;
      }

      if (btn) btn.disabled = true;
      if (statusEl) statusEl.textContent = '⏳ Menu card se text padh rahe hain (English + Hindi OCR)...';

      try {
        if (typeof Tesseract === 'undefined') {
          throw new Error('Tesseract OCR library load nahi hui.');
        }

        let worker;
        try { worker = await Tesseract.createWorker('eng+hin'); }
        catch (_) { worker = await Tesseract.createWorker('eng'); }
        const processedUrl = await preprocessForOcr(imageUrl);
        const ret = await worker.recognize(processedUrl);
        await worker.terminate();

        const rawText = ret && ret.data && ret.data.text ? ret.data.text : '';
        const parsed = parseOcrText(rawText);

        if (parsed.length) {
          const out = await saveItems({ items: parsed });
          applyOwnerPayload(out);
          renderDashboard();

          if (statusEl) statusEl.textContent = '✅ Success! ' + parsed.length + ' items photo se text menu me convert ho gaye!';
          toast('✨ Menu photo se ' + parsed.length + ' items text me convert ho gaye!');
        } else if (rawText.trim()) {
          if (statusEl) statusEl.textContent = 'ℹ️ Text nikala gaya hai lekin items nahi pehchane. Image clear upload karein.';
        } else {
          if (statusEl) statusEl.textContent = '⚠️ Image me text nahi mila. Clear image upload karein.';
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = '⚠️ OCR: ' + (err.message || 'Text nahi nikal paya.');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    $('d-ocr').addEventListener('click', () => {
      if (current && current.menu_url) {
        runMenuOcr(withRev(current.menu_url));
      } else {
        toast('Pehle menu image upload karein', true);
      }
    });

    /* ------------------------------- actions -------------------------------- */
    async function copyMenuLink(btn) {
      if (!btn) return;
      const link = absoluteMenuUrl(current);
      const original = btn.textContent;
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch (_) {
        // Fallback for browsers/contexts without the async clipboard API.
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        ta.remove();
      }
      if (copied) {
        btn.textContent = '✅ Link copied!';
        setTimeout(() => { btn.textContent = original; }, 1800);
      } else {
        // Last resort: show the link so the owner can copy it manually.
        try { window.prompt('Copy this link:', link); }
        catch (_) { toast('Link: ' + link); }
      }
    }

    $('d-copy').addEventListener('click', () => copyMenuLink($('d-copy')));

    $('d-download').addEventListener('click', async () => {
      const url = await qrDataUrl(1024);
      if (!url) { toast('QR banane mein problem hui', true); return; }
      const a = document.createElement('a');
      const name = (current.restaurant || 'menu').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      a.download = name + '-qr.png';
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast('⬇️ QR download ho gaya');
    });

    $('d-print').addEventListener('click', async () => {
      const url = await qrDataUrl(1024);
      if (!url) { toast('QR banane mein problem hui', true); return; }
      const name = current.restaurant || 'My Restaurant';
      const w = window.open('', '_blank', 'width=520,height=720');
      if (!w) { toast('Popup blocked — download QR use karein', true); return; }
      w.document.write(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR — ' + name.replace(/[<>&]/g, '') + '</title>' +
        '<style>body{font-family:Arial,sans-serif;text-align:center;padding:34px;margin:0}</style></head>' +
        '<body onload="window.focus();window.print()">' +
        '<h2 style="margin:0 0 4px">' + name.replace(/[<>&]/g, '') + '</h2>' +
        '<p style="color:#64748b;margin:0 0 18px">Scan to view the menu</p>' +
        '<img src="' + url + '" style="width:360px;height:360px" />' +
        '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Powered by QRush · Free Digital Menu</p>' +
        '</body></html>'
      );
      w.document.close();
    });

    // Quick action mirrors
    if ($('qa-copy')) $('qa-copy').addEventListener('click', () => copyMenuLink($('qa-copy')));
    if ($('qa-download')) $('qa-download').addEventListener('click', () => $('d-download').click());
    if ($('qa-print')) $('qa-print').addEventListener('click', () => $('d-print').click());

    $('d-logout').addEventListener('click', () => {
      setToken('');
      showLogin();
      $('l-pass').value = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    /* ---------------------------- nav / anchor links ------------------------ */
    const navToggle = $('nav-toggle');
    const mobileNav = $('mobile-nav');

    function closeMobileNav() {
      if (!mobileNav) return;
      mobileNav.classList.remove('open');
      if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
    }

    if (navToggle && mobileNav) {
      navToggle.addEventListener('click', () => {
        const open = mobileNav.classList.toggle('open');
        navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      mobileNav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMobileNav));
    }

    function goToLogin() {
      closeMobileNav();
      if (current) return; // already signed in
      $('login-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { const el = $('l-phone'); if (el) el.focus(); }, 380);
    }

    ['jump-login', 'mobile-login', 'foot-login'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', (e) => { e.preventDefault(); goToLogin(); });
    });

    $('brand-home').addEventListener('click', () => {
      closeMobileNav();
      if (document.body.classList.contains('owner-mode')) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    $('d-newqr').addEventListener('click', () => {
      // Reveal the generator so another QR can be created without logging out.
      $('generator').classList.remove('hidden');
      $('generator-panel').classList.remove('hidden');
      $('generator').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => { const el = $('g-rest'); if (el) el.focus(); }, 400);
    });

    /* ---------------------------- generator files --------------------------- */
    $('g-logo-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!/^image\//i.test(file.type || '')) { toast('Logo ke liye image chunein', true); e.target.value = ''; return; }
      try {
        $('g-logo').value = await prepareLogoImage(file);
      } catch (err) {
        toast(err.message || 'Logo upload nahi hua', true);
      } finally {
        e.target.value = '';
      }
    });

    let generatorMenuType = 'image';
    let genMenuMode = 'card';
    const gMtCard = $('g-mt-card');
    const gMtItems = $('g-mt-items');
    function setGenMenuMode(mode) {
      genMenuMode = mode === 'items' ? 'items' : 'card';
      const cardPane = $('g-card-pane');
      const itemsPane = $('g-items-pane');
      if (cardPane) cardPane.hidden = (genMenuMode !== 'card');
      if (itemsPane) itemsPane.hidden = (genMenuMode !== 'items');
      if (gMtCard) gMtCard.classList.toggle('on', genMenuMode === 'card');
      if (gMtItems) gMtItems.classList.toggle('on', genMenuMode === 'items');
    }
    if (gMtCard) gMtCard.addEventListener('click', () => setGenMenuMode('card'));
    if (gMtItems) gMtItems.addEventListener('click', () => setGenMenuMode('items'));
    $('g-menu-file').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      
      for (const file of files) {
        if (!/^image\//i.test(file.type || '') && !/pdf/i.test(file.type || '')) {
          toast('Sirf image ya PDF upload kar sakte hain', true);
          e.target.value = '';
          return;
        }
        if (file.size > 20 * 1024 * 1024) { toast('File bahut badi hai (max 20MB)', true); e.target.value = ''; return; }
      }

      toast('Images upload ho rahi hain...');
      try {
        const isPdf = files.some(f => /pdf/i.test(f.type || ''));
        if (isPdf && files.length > 1) { throw new Error('PDF sirf ek hi file upload kar sakte hain'); }

        generatorMenuType = isPdf ? 'pdf' : 'image';
        const data = await Promise.all(
          files.map(f => (generatorMenuType === 'pdf' ? readFileAsDataUrl(f) : prepareMenuImage(f)))
        );
        $('g-menu').value = generatorMenuType === 'pdf' ? data[0] : JSON.stringify(data);
        toast('✅ ' + data.length + ' page(s) ready!');
      } catch (err) {
        toast(err.message || 'Image upload nahi hui', true);
      } finally {
        e.target.value = '';
      }
    });

    /* -------------------------------- login --------------------------------- */
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = $('l-phone').value.trim();
      const password = $('l-pass').value;
      if (!phone || !password) return;

      $('login-error').textContent = '';
      $('login-submit').disabled = true;
      $('login-submit').textContent = 'Logging in...';

      try {
        const res = await fetch('/api/public/free-qr/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        setToken(data.token);
        showOwner(data.restaurant, data.stats, data.items);
        $('l-pass').value = '';
      } catch (err) {
        $('login-error').textContent = err.message;
      } finally {
        $('login-submit').disabled = false;
        $('login-submit').textContent = 'Login';
      }
    });

    /* ----------------------------- reset password ---------------------------- */
    function openReset() {
      const phone = $('l-phone').value.trim();
      const text = 'Hi QRush, password bhool gaya. Phone: ' + (phone || '____') + '. Restaurant ka naam bhi de raha hoon.';
      $('reset-wa').href = 'https://wa.me/919172941524?text=' + encodeURIComponent(text);
      $('reset-modal').classList.remove('hidden');
      setTimeout(() => $('reset-wa').focus(), 60);
    }
    function closeReset() { $('reset-modal').classList.add('hidden'); }

    $('forgot-link').addEventListener('click', (e) => { e.preventDefault(); openReset(); });
    $('reset-close').addEventListener('click', closeReset);
    $('reset-cancel').addEventListener('click', closeReset);
    $('reset-modal').addEventListener('click', (e) => { if (e.target === $('reset-modal')) closeReset(); });

        /* -------------------------------- generate -------------------------------- */
    let otpSent = false;
    $('g-gen').addEventListener('click', async () => {
      const rest = $('g-rest').value.trim();
      const owner = $('g-owner').value.trim();
      const phone = $('g-phone').value.trim();
      const pass = $('g-pass').value.trim();
      const menu = $('g-menu').value.trim();
      const logo = $('g-logo').value.trim();
      const genItemsText = ($('g-items') && $('g-items').value) ? $('g-items').value.trim() : '';
      let genItems = [];
      if (genMenuMode === 'items') {
        genItems = (typeof parseItemsText === 'function') ? parseItemsText(genItemsText) : [];
        // auto photos
        genItems.forEach(it => { if (!it.image) { const a = (typeof autoDishPhoto === 'function') ? autoDishPhoto(it.name) : ''; if (a) it.image = a; } });
      }

      if (!rest || !phone || !pass) {
        genError('Kripya zaroori fields (* waale) bhariye — restaurant name, contact number, password.');
        return;
      }
      if (genMenuMode === 'card' && !menu) {
        genError('Menu photo / PDF upload karein.');
        return;
      }
      if (genMenuMode === 'items' && !genItems.length) {
        genError('Kam se kam ek dish daalein (Naam, price, category).');
        return;
      }

      const digits = phone.replace(/\D/g, '');
      if (digits.length < 10) {
        genError('Contact number kam se kam 10 digit ka hona chahiye.');
        $('g-phone').focus();
        return;
      }
      if (digits.length > 15) {
        genError('Contact number 15 digit se zyada nahi hona chahiye.');
        $('g-phone').focus();
        return;
      }
      if (pass.length < 4) {
        genError('Password kam se kam 4 character ka rakhein.');
        $('g-pass').focus();
        return;
      }

      genClearError();

      if (!otpSent) {
        $('g-gen').disabled = true;
        $('g-gen').textContent = 'Sending OTP...';
        try {
          const res = await fetch('/api/public/free-qr/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: digits }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'OTP send nahi hua');
          otpSent = true;
          $('g-otp-wrap').style.display = '';
          const hint = $('g-otp-hint');
          if (data.otp) {
            hint.textContent = 'Demo OTP: ' + data.otp + ' (SMS provider configure hone par yeh screen par nahi dikhega)';
            hint.style.color = 'var(--primary-700)';
          } else {
            hint.textContent = 'OTP aapke phone par bhej diya gaya hai.';
          }
          $('g-gen').textContent = 'Verify & Generate';
          toast('OTP bhej diya gaya!');
          setTimeout(() => $('g-otp').focus(), 100);
        } catch (err) {
          genError(err.message);
        } finally {
          $('g-gen').disabled = false;
        }
        return;
      }

      const otp = $('g-otp').value.trim();
      if (!otp || otp.length < 4) {
        genError('Kripya phone par aaya OTP enter karein.');
        $('g-otp').focus();
        return;
      }

      genClearError();
      $('g-gen').disabled = true;
      $('g-gen').textContent = 'Verifying...';

      try {
        const res = await fetch('/api/public/free-qr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurant: rest,
            owner_name: owner,
            phone: digits,
            password: pass,
            otp: otp,
            logo_url: logo || null,
            menu_data: genMenuMode === 'items' ? '' : menu,
            menu_type: genMenuMode === 'items' ? 'items' : generatorMenuType,
            items: genMenuMode === 'items' ? genItems : undefined,
            whatsapp: $('g-whatsapp').value.trim() || null,
            instagram: $('g-instagram').value.trim() || null,
            facebook: $('g-facebook').value.trim() || null,
            website: $('g-website').value.trim() || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');

        $('qr-code').innerHTML = '';
        $('qr-subtitle').textContent = rest + ' • Owner: ' + owner;
        makeQr($('qr-code'), data.url, 220);
        $('g-open-menu').classList.remove('hidden');
        $('qr-container').classList.remove('hidden');

        if (data.token && data.restaurant) {
          setToken(data.token);
          showOwner(data.restaurant, data.stats, data.items);
          toast('QR ready! Yeh raha aapka dashboard.');
        } else {
          $('qr-container').scrollIntoView({ behavior: 'smooth' });
        }

        otpSent = false;
        genClearError();
        $('g-otp-wrap').style.display = 'none';
        $('g-otp').value = '';
        $('g-gen').textContent = 'Generate Free QR Code';
      } catch (err) {
        genError(err.message);
        if (!/OTP/i.test(err.message)) {
          otpSent = false;
          $('g-otp-wrap').style.display = 'none';
          $('g-gen').textContent = 'Generate Free QR Code';
        }
      } finally {
        $('g-gen').disabled = false;
        if (otpSent) $('g-gen').textContent = 'Verify & Generate';
      }
    });

    $('g-print').addEventListener('click', () => window.print());

    /* ------------------------- hero demo QR (marketing) --------------------- */
    (function initHeroQr() {
      const box = $('lp-qr');
      if (!box || typeof QRCode === 'undefined') return;
      try {
        makeQr(box, publicBase() + '/demo-menu.html', 104);
      } catch (_) {
        box.innerHTML = '';
      }
    })();

    /* --------------------- restore a saved owner session -------------------- */
    (async function restore() {
      const token = getStoredToken();
      if (!token) return;
      try {
        const res = await fetch('/api/public/free-qr/me', {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new Error('expired');
        const data = await res.json();
        setToken(token);
        showOwner(data.restaurant, data.stats, data.items);
      } catch (_) {
        setToken('');
        showLogin();
      }
    })();
