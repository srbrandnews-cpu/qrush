'use strict';

/**
 * One-shot setup for a PERMANENT public URL.
 *
 * What this does for you:
 *   1. logs you into Cloudflare (opens a browser once)
 *   2. creates a named tunnel
 *   3. points your hostname at that tunnel (DNS CNAME)
 *   4. builds the tunnel token and writes TUNNEL_TOKEN + PUBLIC_HOSTNAME
 *      into .env
 *
 * After that, `start-tunnel.bat` / `npm run tunnel` always serves the SAME
 * https://yourdomain.com URL — so printed QR codes never break and staff
 * stay logged in.
 *
 * Prerequisites:
 *   - a domain whose nameservers point to Cloudflare  (docs/DOMAIN-SETUP.md)
 *   - cloudflared installed  (winget install Cloudflare.cloudflared)
 *
 * Run:  node scripts/setup-domain.js <your-domain> [tunnel-name]
 *   e.g. node scripts/setup-domain.js myhotel.in tablenest
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const CF_DIR = path.join(os.homedir(), '.cloudflared');

const domain = (process.argv[2] || '').trim().toLowerCase();
const tunnelName = (process.argv[3] || 'tablenest').trim();

function say(msg) { console.log(msg); }
function fail(msg, extra) {
  console.error('\n❌ ' + msg + '\n');
  if (extra) console.error(extra + '\n');
  process.exit(1);
}

function cloudflared() {
  const r = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    fail('cloudflared nahi mila.',
      'Install karne ke liye:\n  winget install Cloudflare.cloudflared');
  }
}

/** Read .env into an object. */
function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function writeEnv(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const re = new RegExp('^' + key + '=.*$', 'm');
  content = re.test(content)
    ? content.replace(re, key + '=' + value)
    : content.trimEnd() + '\n' + key + '=' + value + '\n';
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function main() {
  if (!domain) {
    fail('Domain ka naam chahiye.',
      'Usage:  node scripts/setup-domain.js <your-domain> [tunnel-name]\n' +
      'Example: node scripts/setup-domain.js myhotel.in tablenest');
  }
  if (!domain.includes('.')) fail('Sahi domain daalein (jaise myhotel.in)');

  cloudflared();
  say('\n=== TableNest · Permanent domain setup ===\n');
  say('Domain : ' + domain);
  say('Tunnel : ' + tunnelName + '\n');

  // --- 1. Cloudflare login (once) ---
  const certPath = path.join(CF_DIR, 'cert.pem');
  if (!fs.existsSync(certPath)) {
    say('Step 1/4  Cloudflare login (browser khul jayega)...');
    say('         Browser mein apna domain wala Cloudflare account choose karein.');
    const r = spawnSync('cloudflared', ['tunnel', 'login'], { stdio: 'inherit', shell: true });
    if (r.status !== 0 || !fs.existsSync(certPath)) {
      fail('Cloudflare login complete nahi hua. Phir se try karein.');
    }
    say('         ✔ logged in\n');
  } else {
    say('Step 1/4  ✔ Cloudflare login pehle se hai\n');
  }

  // --- 2. Create the tunnel ---
  say('Step 2/4  Named tunnel bana rahe hain...');
  const existing = listTunnels();
  let tunnelId = existing.find((t) => t.name === tunnelName);

  if (tunnelId) {
    say('         ✔ tunnel pehle se hai: ' + tunnelName + ' (' + tunnelId.id + ')\n');
  } else {
    const r = spawnSync('cloudflared', ['tunnel', 'create', tunnelName], { encoding: 'utf8', shell: true });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (!m) fail('Tunnel nahi ban paya.', out.slice(0, 500));
    tunnelId = { id: m[1], name: tunnelName };
    say('         ✔ bana: ' + tunnelName + ' (' + tunnelId.id + ')\n');
  }

  // --- 3. DNS route ---
  const hostname = 'order.' + domain;
  say('Step 3/4  DNS record bana rahe hain: ' + hostname + ' → tunnel');
  const dns = spawnSync('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname], { encoding: 'utf8', shell: true });
  const dnsOut = ((dns.stdout || '') + (dns.stderr || '')).trim();
  if (dns.status !== 0 && !/already exists|record with that host already exists/i.test(dnsOut)) {
    fail('DNS record nahi bana.', dnsOut.slice(0, 500));
  }
  say('         ✔ ' + hostname + ' → tunnel\n');

  // --- 4. Build the token + write .env ---
  const credPath = path.join(CF_DIR, tunnelId.id + '.json');
  if (!fs.existsSync(credPath)) {
    fail('Tunnel credentials file nahi mili: ' + credPath,
      'Yeh file tab banti hai jab tunnel aapke Cloudflare account mein ban ho.');
  }
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const token = Buffer.from(JSON.stringify({
    a: cred.AccountTag, t: cred.TunnelID, s: cred.TunnelSecret,
  })).toString('base64');

  writeEnv('TUNNEL_TOKEN', token);
  writeEnv('PUBLIC_HOSTNAME', hostname);
  writeEnv('BASE_URL', 'https://' + hostname);

  say('Step 4/4  .env update ho gaya\n');
  say('  TUNNEL_TOKEN    = (set)');
  say('  PUBLIC_HOSTNAME = ' + hostname);
  say('  BASE_URL        = https://' + hostname + '\n');
  say('  ✔ QR codes ab https://' + hostname + ' par jayenge\n');
  say('  Ab `npm run tunnel` (ya start-tunnel.bat) chalao.\n');
}

/** Ask Cloudflare for the list of existing tunnels (uses cert.pem). */
function listTunnels() {
  try {
    const out = execSync('cloudflared tunnel list --output json', { encoding: 'utf8', shell: true });
    const arr = JSON.parse(out);
    return arr.map((t) => ({ id: t.id, name: t.name }));
  } catch (_) {
    return [];
  }
}

main();
