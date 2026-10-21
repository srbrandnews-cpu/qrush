'use strict';

/**
 * Verifies that Indic / emoji / currency text survives the full round-trip
 * (browser -> API -> database -> API -> browser) byte for byte.
 *
 * Run:  node scripts/test-encoding.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SAMPLES = [
  'असल कोल्हापुरी',              // Devanagari
  'होटल रेस्तराँ',              // Devanagari with matras
  'South Indian ₹ Café',        // rupee sign + accents
  'मसाला Dosa 🍛',              // emoji
  'Zé Café Crème',         // latin accents
];

async function main() {
  console.log('\n=== UTF-8 round-trip test ===\n');

  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@demo.com', password: 'pass1234' }),
  })).json();

  if (!login.token) throw new Error('login failed');
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };

  const original = (await (await fetch(BASE + '/api/admin/restaurant', { headers: auth })).json()).restaurant.name;

  let failed = 0;
  for (const sample of SAMPLES) {
    const saved = await (await fetch(BASE + '/api/admin/restaurant', {
      method: 'PUT', headers: auth, body: JSON.stringify({ name: sample }),
    })).json();
    const readBack = saved.restaurant.name;
    const ok = readBack === sample;
    if (!ok) failed++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + JSON.stringify(sample) +
      (ok ? ' -> stored & read back intact' : ' -> GOT ' + JSON.stringify(readBack)));
  }

  // Restore whatever the restaurant was called before the test.
  await fetch(BASE + '/api/admin/restaurant', {
    method: 'PUT', headers: auth, body: JSON.stringify({ name: original }),
  });
  const restored = (await (await fetch(BASE + '/api/admin/restaurant', { headers: auth })).json()).restaurant.name;
  console.log('\n  original name restored: ' + JSON.stringify(restored));

  if (failed) throw new Error(failed + ' string(s) were corrupted in transit');
  console.log('\n✅ All text round-trips byte-for-byte — no encoding corruption.\n');
}

main().catch((err) => {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
});
