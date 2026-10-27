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
  /* Every kitchen can pick the alert that cuts through its own noise level.
     All sounds are synthesised with Web Audio, so no files to download. */
  const SOUNDS = {
    classic:    { label: 'Classic',       type: 'sine',     notes: [{ f: 880, t: 0, d: .16 }, { f: 1320, t: .18, d: .16 }] },
    chime:      { label: 'Chime',         type: 'sine',     notes: [{ f: 523, t: 0, d: .14 }, { f: 659, t: .16, d: .14 }, { f: 784, t: .32, d: .26 }] },
    doorbell:   { label: 'Doorbell',      type: 'sine',     notes: [{ f: 659, t: 0, d: .30 }, { f: 523, t: .34, d: .42 }] },
    triple:     { label: 'Triple beep',   type: 'square',   notes: [{ f: 1000, t: 0, d: .07 }, { f: 1000, t: .12, d: .07 }, { f: 1000, t: .24, d: .07 }] },
    urgent:     { label: 'Urgent',        type: 'square',   notes: [{ f: 1200, t: 0, d: .08 }, { f: 1200, t: .12, d: .08 }, { f: 1200, t: .24, d: .08 }, { f: 1200, t: .36, d: .14 }] },
    dingdong:   { label: 'Ding dong',     type: 'triangle', notes: [{ f: 988, t: 0, d: .26 }, { f: 784, t: .30, d: .36 }] },
    bell:       { label: 'Bell',          type: 'sine',     notes: [{ f: 1046, t: 0, d: .42 }, { f: 1568, t: .03, d: .50 }] },
    buzz:       { label: 'Buzz',          type: 'sawtooth', notes: [{ f: 170, t: 0, d: .28 }, { f: 170, t: .34, d: .28 }], volume: .22 },
    sweep:      { label: 'Rising sweep',  type: 'sine',     notes: [{ f: 420, t: 0, d: .40, to: 1200 }, { f: 1200, t: .42, d: .18 }] },
    train:      { label: 'Train whistle', type: 'triangle', notes: [{ f: 740, t: 0, d: .32 }, { f: 740, t: .44, d: .32 }] },
  };
  const SOUND_KEY = 'tn_kitchen_sound';
  let soundName = localStorage.getItem(SOUND_KEY) || 'classic';
  if (!SOUNDS[soundName]) soundName = 'classic';

  let requests = [];

  /* --------------------------- voice callout ----------------------------- */
  /* The kitchen hears the order out loud, in English or Hindi. Uses the
     browser's built-in speech synthesis — free, no audio files, no network. */
  const VOICE_KEY = 'tn_kitchen_voice';
  let voiceMode = localStorage.getItem(VOICE_KEY) || 'en';
  if (!['en', 'hi', 'off'].includes(voiceMode)) voiceMode = 'en';
  const HINUM = { 1: 'एक', 2: 'दो', 3: 'तीन', 4: 'चार', 5: 'पांच', 6: 'छह', 7: 'सात', 8: 'आठ', 9: 'नौ', 10: 'दस' };
  const ENNUM = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };

  function spokenTable(label) {
    const text = String(label || 'Table').replace(/#/g, '').trim();
    if (voiceMode === 'hi') {
      const m = text.match(/^table\s*(\d+)\s*([a-z])?$/i);
      if (m) return 'टेबल ' + (HINUM[m[1]] || m[1]) + (m[2] ? ', ' + m[2].toUpperCase() : '');
      return text;
    }
    const m = text.match(/^table\s*(\d+)\s*([a-z])?$/i);
    if (m) return 'Table ' + (ENNUM[m[1]] || m[1]) + (m[2] ? ', ' + m[2].toUpperCase() : '');
    return text;
  }

  function speak(text) {
    if (voiceMode === 'off' || !text || !TN.voice) return;
    TN.voice.speak(text, {
      lang: voiceMode === 'hi' ? 'hi-IN' : 'en-IN',
      mode: voiceMode,
      rate: 0.98,
      pitch: 1,
    });
  }

  function speakOrder(order) {
    if (!order || voiceMode === 'off') return;
    const table = spokenTable(order.bill_label || order.table_name);
    const items = (order.items || []).slice(0, 8).map((it) => {
      const qty = voiceMode === 'hi' ? (HINUM[it.qty] || it.qty) : (ENNUM[it.qty] || it.qty);
      return `${qty} ${it.name}`;
    });
    if (!items.length) return;
    const label = voiceMode === 'hi' ? 'नया ऑर्डर' : 'New order';
    speak(`${label}. ${table}. ${items.join('. ')}.`);
  }

  function speakRequest(req) {
    if (!req || voiceMode === 'off') return;
    const table = spokenTable(req.table_name);
    const labels = {
      water: voiceMode === 'hi' ? 'पानी' : 'water',
      spoon: voiceMode === 'hi' ? 'चम्मच' : 'spoon',
      bill: voiceMode === 'hi' ? 'बिल' : 'bill',
      ac: 'AC',
      waiter: voiceMode === 'hi' ? 'वेटर' : 'waiter',
    };
    speak(`${table}. ${labels[req.type] || req.type}.`);
  }

  function updateVoiceTitle() {
    const sel = $('voice-pick');
    if (!sel || !TN.voice) return;
    if (voiceMode === 'off') { sel.title = 'Order voice callout is off'; return; }
    const name = TN.voice.bestName(voiceMode);
    sel.title = name
      ? `Natural online callout · browser fallback: ${name}`
      : 'Natural online order voice callout';
  }

  function initVoicePicker() {
    const sel = $('voice-pick');
    if (!sel) return;
    sel.value = voiceMode;
    sel.addEventListener('change', () => {
      voiceMode = sel.value;
      try { localStorage.setItem(VOICE_KEY, voiceMode); } catch (_) { /* private mode */ }
      updateVoiceTitle();
      if (voiceMode !== 'off') {
        speak(voiceMode === 'hi' ? 'टेबल चार. पनीर टिक्का, दो.' : 'Table four. Paneer Tikka, two.');
      }
    });
    setTimeout(updateVoiceTitle, 500);
    setTimeout(updateVoiceTitle, 1600);
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playSound(name) {
    const profile = SOUNDS[name] || SOUNDS.classic;
    ensureAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const volume = profile.volume || 0.35;

    profile.notes.forEach((n) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = profile.type || 'sine';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, now + n.t + n.d);
      gain.gain.setValueAtTime(0.0001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(volume, now + n.t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(now + n.t); osc.stop(now + n.t + n.d + 0.02);
    });
  }

  function beep() {
    if (!soundOn) return;
    playSound(soundName);
  }
  document.addEventListener('click', ensureAudio, { once: true });

  /** Fill the sound dropdown and remember the kitchen's choice. */
  function initSoundPicker() {
    const sel = $('sound-pick');
    if (!sel) return;
    sel.innerHTML = Object.entries(SOUNDS)
      .map(([key, s]) => `<option value="${key}">${s.label}</option>`).join('');
    sel.value = soundName;
    sel.addEventListener('change', () => {
      soundName = sel.value;
      try { localStorage.setItem(SOUND_KEY, soundName); } catch (_) { /* private mode */ }
      if (!soundOn) toggleSound(true);
      playSound(soundName); // instant preview
    });
  }

  /* ------------------------------- loading ------------------------------- */
  async function load() {
    const data = await TN.fetchMe();
    role = data.user.role;
    if (role === 'cashier') { window.location.href = '/cashier'; return; }
    $('r-name').textContent = data.tenant ? data.tenant.name : '';
    $('me').textContent = (data.user.name || 'K').charAt(0).toUpperCase();
    initSoundPicker();
    initVoicePicker();
    await Promise.all([refresh(), refreshRequests()]);
    connect();
    setInterval(tickTimers, 20000);
    setInterval(refreshRequests, 20000);
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

    // Play the alert once per batch of new orders, and call the newest one out.
    const fresh = orders.filter((o) => o._fresh);
    if (fresh.length) {
      beep();
      if (soundOn) speakOrder(fresh.sort((a, b) => b.id - a.id)[0]);
      orders.forEach((o) => delete o._fresh);
    }
  }

  /* --------------------------- table requests ---------------------------- */
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
    const list = $('req-list');
    if (!strip || !list) return;
    strip.classList.toggle('hidden', requests.length === 0);
    list.innerHTML = '';
    requests.forEach((req) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'req-pill-kds';
      btn.innerHTML = `<span>${REQ_ICONS[req.type] || '🔔'}</span>
        <span class="table">${TN.escapeHtml(req.table_name)}</span>
        <span>${REQ_LABELS[req.type] || req.type}</span>
        <span class="done">Done</span>`;
      btn.addEventListener('click', () => resolveRequest(req.id));
      list.appendChild(btn);
    });
  }

  async function resolveRequest(id) {
    try {
      await TN.api(`/api/requests/${id}/resolve`, { method: 'PATCH' });
      await refreshRequests();
      TN.toast('Request done ✅', 'success');
    } catch (err) { TN.toast(err.message, 'error'); }
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
        ${o.is_parcel ? '<span class="ocard-tag" style="background:#f59e0b;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px">📦 Parcel</span>' : ''}
        <span class="ocard-table">${TN.escapeHtml(o.bill_label || o.table_name)}</span>
      </div>
      <div class="ocard-time ${late ? 'late' : ''}">⏱ <span data-timer="${o.created_at}">${mins} min ago</span></div>
      ${o.customer_name ? `<div class="ocard-cust">👤 ${TN.escapeHtml(o.customer_name)}</div>` : ''}
      ${o.customer_phone ? `<div class="ocard-cust">📞 ${TN.escapeHtml(o.customer_phone)}</div>` : ''}
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
    socket.on('request:new', ({ request }) => {
      if (!request) return;
      TN.toast(`${request.table_name} — ${REQ_LABELS[request.type] || request.type}`, '');
      beep();
      if (soundOn) speakRequest(request);
      refreshRequests();
    });
    socket.on('request:update', refreshRequests);
  }

  /* --------------------------------- misc -------------------------------- */
  function toggleSound(on) {
    soundOn = typeof on === 'boolean' ? on : !soundOn;
    $('sound').textContent = soundOn ? '🔔 Sound' : '🔕 Muted';
    $('sound').classList.toggle('muted-on', !soundOn);
    if (soundOn) { ensureAudio(); beep(); }
  }

  $('sound').addEventListener('click', () => toggleSound());
  $('logout').addEventListener('click', () => TN.logout());

  // Poll as a safety net (covers missed socket events / sleeping tabs).
  setInterval(refresh, 30000);

  load().catch((err) => { if (err.status !== 401) TN.toast(err.message, 'error'); });
})();
