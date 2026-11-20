/* ==========================================================================
   QRush — natural-sounding voice
   Uses a cached natural voice first, then picks the best installed
   Neural/Natural/Google voice as a fallback instead of the robotic default.
   ========================================================================== */

(() => {
  if (typeof TN === 'undefined') return;

  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let voices = [];
  let currentAudio = null;
  let speakSeq = 0;

  const NATURAL = /natural|neural|premium|enhanced|online/i;
  const GOOD = /swara|neerja|raveena|aditi|heera|kalpana|priya|ananya|aria|jenny|sonia|libby|emily|olivia/i;
  const BAD = /espeak|compact|pico|festival|robot|robotic|default|sam\b/i;

  function normalizeLang(value) {
    return String(value || '').toLowerCase().replace(/_/g, '-');
  }

  function refreshVoices() {
    if (!synth) return [];
    try {
      const list = synth.getVoices() || [];
      if (list.length) voices = list;
    } catch (_) { /* browser without voices */ }
    return voices;
  }

  refreshVoices();
  if (synth) {
    try {
      synth.addEventListener('voiceschanged', refreshVoices);
    } catch (_) {
      synth.onvoiceschanged = refreshVoices;
    }
  }

  function scoreVoice(voice, lang, mode) {
    const vl = normalizeLang(voice.lang);
    const wanted = normalizeLang(lang);
    const primary = wanted.slice(0, 2);
    const name = String(voice.name || '');
    let score = 0;

    if (vl === wanted) score += 110;
    else if (vl.startsWith(primary + '-')) score += 45;
    else if (vl === primary) score += 35;

    if (mode === 'hi' && vl.startsWith('hi')) score += 55;
    if (mode === 'en' && vl.startsWith('en')) score += 40;

    if (NATURAL.test(name)) score += 90;
    if (GOOD.test(name)) score += 24;
    if (/google/i.test(name)) score += 34;
    if (/microsoft/i.test(name)) score += 12;
    if (BAD.test(name)) score -= 130;

    // A natural voice in a nearby English accent sounds far better than a
    // legacy robotic voice in the exact locale.
    if (voice.localService === false && NATURAL.test(name)) score += 8;
    return score;
  }

  function pickVoice(lang, mode) {
    const list = voices.length ? voices : refreshVoices();
    if (!list.length) return null;

    const primary = normalizeLang(lang).slice(0, 2);
    const sameLanguage = list.filter((v) => normalizeLang(v.lang).startsWith(primary));
    const pool = sameLanguage.length ? sameLanguage : list;
    const ranked = pool
      .map((voice) => ({ voice, score: scoreVoice(voice, lang, mode) }))
      .sort((a, b) => b.score - a.score);
    return ranked.length ? ranked[0].voice : null;
  }

  function waitForVoices(ms) {
    refreshVoices();
    if (voices.length || !synth) return Promise.resolve(voices);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { synth.removeEventListener('voiceschanged', onChange); } catch (_) { /* ignore */ }
        clearTimeout(timer);
        refreshVoices();
        resolve(voices);
      };
      const onChange = () => {
        refreshVoices();
        if (voices.length) finish();
      };
      try { synth.addEventListener('voiceschanged', onChange); } catch (_) { /* ignore */ }
      const timer = setTimeout(finish, ms);
    });
  }

  /**
   * Same-origin cached audio. Gives every device the same pleasant voice
   * instead of relying on whatever robotic SAPI voice happens to be installed.
   * If autoplay is blocked or the proxy is down, the caller falls back to the
   * browser's SpeechSynthesis voice.
   */
  function speakRemote(text, opts) {
    if (!window.Audio) return Promise.resolve(false);
    if (currentAudio) {
      try { currentAudio.pause(); } catch (_) { /* ignore */ }
      currentAudio = null;
    }

    const url = '/api/voice/tts?lang=' + encodeURIComponent(opts.lang || 'en-IN') +
      '&text=' + encodeURIComponent(text);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.volume = opts.volume != null ? opts.volume : 1;

    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok && currentAudio === audio) {
          try { audio.pause(); audio.src = ''; } catch (_) { /* ignore */ }
          currentAudio = null;
        }
        resolve(ok);
      };

      audio.onplaying = () => finish(true);
      audio.onended = () => {
        if (currentAudio === audio) currentAudio = null;
        finish(true);
      };
      audio.onerror = () => finish(false);

      const timer = setTimeout(() => finish(false), opts.remoteTimeout || 2400);
      let played;
      try { played = audio.play(); } catch (_) { finish(false); return; }
      if (played && typeof played.then === 'function') {
        played
          .then(() => {
            // onplaying usually arrives immediately; this covers browsers
            // that resolve play() without firing the event.
            if (!done) setTimeout(() => finish(true), 650);
          })
          .catch(() => finish(false));
      }
    });
  }

  function doSpeak(text, opts) {
    if (!synth) return Promise.resolve(false);
    const lang = opts.lang || 'en-IN';
    const voice = pickVoice(lang, opts.mode);
    if (opts.mode === 'hi' && !voice) return Promise.resolve(false);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice ? (voice.lang || lang) : lang;
    if (voice) utterance.voice = voice;
    utterance.rate = opts.rate != null ? opts.rate : 0.94;
    utterance.pitch = opts.pitch != null ? opts.pitch : 1;
    utterance.volume = opts.volume != null ? opts.volume : 1;

    let started = false;
    let settled = false;

    return new Promise((resolve) => {
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      utterance.onstart = () => { started = true; finish(true); };
      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(false);

      try { synth.cancel(); } catch (_) { /* ignore */ }
      // A tiny gap avoids a Chrome bug where speak() right after cancel()
      // is silently ignored.
      setTimeout(() => {
        try { synth.speak(utterance); } catch (_) { finish(false); }
      }, 40);

      setTimeout(() => { if (!started) finish(false); }, opts.timeout || 1700);
    });
  }

  function speakBrowser(text, options) {
    if (!synth) return Promise.resolve(false);
    return waitForVoices(900).then(() => doSpeak(text, options));
  }

  function isSpeaking() {
    if (currentAudio && !currentAudio.paused && !currentAudio.ended) return true;
    return !!(synth && (synth.speaking || synth.pending));
  }

  /**
   * Speak text naturally. Returns Promise<boolean> (true once playback starts).
   * opts: { lang, mode:'en'|'hi', rate, pitch, volume, retryGesture, remote }
   *
   * retryGesture attaches the retry *before* playback so a tap that arrives
   * while mobile autoplay is still being blocked is not wasted.
   */
  function speak(text, opts = {}) {
    if (!text || opts.mode === 'off') return Promise.resolve(false);
    const options = Object.assign({ lang: 'en-IN', mode: 'en', remote: true }, opts);
    const seq = ++speakSeq;

    let onGesture = null;
    if (options.retryGesture) {
      onGesture = () => {
        document.removeEventListener('pointerdown', onGesture, true);
        if (isSpeaking()) return;
        stop();
        speak(text, Object.assign({}, options, { retryGesture: false })).catch(() => false);
      };
      document.addEventListener('pointerdown', onGesture, { once: true, capture: true });
    }

    const attempt = options.remote
      ? speakRemote(text, options)
        .catch(() => false)
        .then((ok) => {
          if (seq !== speakSeq) return false; // a gesture retry replaced us
          return ok ? true : speakBrowser(text, options);
        })
      : speakBrowser(text, options);

    return attempt.then((ok) => {
      if (ok && onGesture) document.removeEventListener('pointerdown', onGesture, true);
      return ok;
    });
  }

  function stop() {
    speakSeq += 1;
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ''; } catch (_) { /* ignore */ }
      currentAudio = null;
    }
    try { if (synth) synth.cancel(); } catch (_) { /* ignore */ }
  }

  /** Human-readable name of the auto-selected voice (for tooltips/debug). */
  function bestName(mode) {
    const lang = mode === 'hi' ? 'hi-IN' : 'en-IN';
    const voice = pickVoice(lang, mode || 'en');
    return voice ? voice.name : '';
  }

  TN.voice = { speak, stop, bestName, isSpeaking, refresh: refreshVoices };
})();
