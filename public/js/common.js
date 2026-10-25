/* ==========================================================================
   QRush — shared client helpers (used by every screen)
   ========================================================================== */

const TN = (() => {
  const LEGACY_KEY = 'tn_token';
  const DEVICE_KEY = 'tn_device';

  // One token per staff role, so owner/kitchen/cashier can stay logged in at
  // the same time on one browser (very handy while testing on a laptop).
  const ROLE_TOKEN_KEYS = {
    owner: 'tn_token_owner',
    kitchen: 'tn_token_kitchen',
    cashier: 'tn_token_cashier',
  };

  /** Which staff screen is this? Login and the customer menu have no role. */
  function pageRole() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    if (p === '/admin' || p.startsWith('/admin/')) return 'owner';
    if (p === '/kitchen' || p.startsWith('/kitchen/')) return 'kitchen';
    if (p === '/cashier' || p.startsWith('/cashier/')) return 'cashier';
    return null;
  }

  /* ------------------------------- storage ------------------------------- */
  const getToken = () => {
    const role = pageRole();
    const key = role ? ROLE_TOKEN_KEYS[role] : LEGACY_KEY;
    return localStorage.getItem(key) || '';
  };

  const setToken = (t, role) => {
    const key = ROLE_TOKEN_KEYS[role || pageRole()] || LEGACY_KEY;
    localStorage.setItem(key, t || '');
  };

  const clearToken = () => {
    const role = pageRole();
    if (role) localStorage.removeItem(ROLE_TOKEN_KEYS[role]);
    localStorage.removeItem(LEGACY_KEY);
  };

  /**
   * A stable anonymous id for this phone/browser. Lets the server target a
   * customer's device with push notifications without collecting personal data.
   */
  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  /* --------------------------------- api --------------------------------- */
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });

    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (_) { data = { error: text }; } }

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      // Staff screens: bounce to login when the session expires.
      if (res.status === 401 && !opts.noRedirect) window.location.href = '/login';
      throw err;
    }
    return data;
  }

  /* --------------------------------- misc -------------------------------- */
  function toast(message, type = '') {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  const fmtMoney = (n, currency = '₹') =>
    currency + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** "2026-10-21 07:12" -> "7:12 AM" (relative-ish clock time) */
  function fmtTime(sql) {
    if (!sql) return '';
    const d = new Date(sql.replace(' ', 'T') + (sql.includes('Z') ? '' : 'Z'));
    if (isNaN(d)) return sql;
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function minutesSince(sql) {
    if (!sql) return 0;
    const d = new Date(sql.replace(' ', 'T') + (sql.includes('Z') ? '' : 'Z'));
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  }

  /* --------------------------------- auth -------------------------------- */

  /**
   * Fetch the logged-in user. If the session is missing or expired we send the
   * user to the login screen with a clear reason — never leave them staring
   * at an empty dashboard wondering why nothing works.
   */
  async function fetchMe() {
    try {
      return await api('/api/auth/me', { noRedirect: true });
    } catch (err) {
      if (err.status === 401) {
        toast('Session khatam ho gaya — dobara login karein', 'error');
        setTimeout(() => { window.location.href = '/login?expired=1'; }, 900);
      }
      throw err;
    }
  }

  function logout() {
    clearToken();
    window.location.href = '/login';
  }

  return { api, toast, fmtMoney, escapeHtml, fmtTime, minutesSince, deviceId,
           getToken, setToken, clearToken, fetchMe, logout };
})();
