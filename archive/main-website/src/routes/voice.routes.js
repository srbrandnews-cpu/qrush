'use strict';

/**
 * Small, cached TTS proxy.
 *
 * Browsers expose wildly different speech voices (some are very robotic).
 * This endpoint gives every device the same natural-sounding voice, while the
 * client still falls back to the built-in SpeechSynthesis API if this service
 * is slow or unavailable. Text is short (menu callouts / welcome line), never
 * user HTML, and only the fixed Google Translate host is called.
 */

const express = require('express');

const router = express.Router();
const cache = new Map();
const MAX_CACHE = 120;
const MAX_TEXT = 280;

function cachePut(key, buffer) {
  cache.set(key, buffer);
  while (cache.size > MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }
}

router.get('/tts', async (req, res) => {
  const text = String(req.query.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) return res.status(400).json({ error: 'text required' });

  const rawLang = String(req.query.lang || 'en-IN');
  const lang = ['en', 'en-IN', 'hi'].includes(rawLang) ? rawLang : 'en';
  const key = lang + '|' + text;

  let audio = cache.get(key);
  if (!audio) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const upstream = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
        },
        signal: controller.signal,
      });
      if (!upstream.ok) throw new Error('TTS upstream ' + upstream.status);
      const type = String(upstream.headers.get('content-type') || '');
      if (!type.startsWith('audio/')) throw new Error('TTS upstream is not audio');
      audio = Buffer.from(await upstream.arrayBuffer());
      if (!audio.length) throw new Error('TTS upstream returned empty audio');
      cachePut(key, audio);
    } catch (err) {
      return res.status(502).json({ error: 'Voice temporarily unavailable' });
    } finally {
      clearTimeout(timer);
    }
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(audio);
});

module.exports = router;
