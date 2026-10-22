'use strict';

/**
 * One-click launcher for TRIAL / PRODUCTION mode.
 *
 * Two modes, picked automatically from .env:
 *
 *   NAMED TUNNEL (recommended — permanent URL)
 *     .env mein  TUNNEL_TOKEN=<cloudflare tunnel token>
 *                 PUBLIC_HOSTNAME=order.yourdomain.com
 *     => stable https://order.yourdomain.com, kabhi nahi badlega.
 *        QR codes ek hi baar print karo, hamesha kaam karenge.
 *
 *   QUICK TUNNEL (fallback — free, no account)
 *     .env mein TUNNEL_TOKEN khaali
 *     => random https://xxx.trycloudflare.com, har restart par badal jaata hai.
 *        Sirf testing ke liye.
 *
 * Either way the tunnel URL is written into .env (BASE_URL) so the generated
 * QR codes always point at the live address.
 *
 * Run:  npm run tunnel
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const PORT = process.env.PORT || 3000;

const children = [];

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill(); } catch (_) { /* ignore */ }
  }
  // Normalise: a force-killed child reports -1, which would show up as exit
  // code 255 and look like a crash.
  process.exit(code > 0 ? code : 0);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => { for (const c of children) { try { c.kill(); } catch (_) {} } });

/* ----------------------------- .env helpers ----------------------------- */

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Set (or replace) a key in .env, keeping everything else intact. */
function writeEnv(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp('^' + key + '=.*$', 'm');
  content = re.test(content)
    ? content.replace(re, line)
    : content.trimEnd() + '\n' + line + '\n';
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

/* -------------------------------- tunnel -------------------------------- */

/**
 * Full path to the cloudflared executable.
 * We spawn it directly (no `shell: true`) so that .kill() actually stops the
 * real process — with a shell wrapper, killing the wrapper leaves cloudflared
 * running as an orphan.
 */
function cloudflaredPath() {
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, ['cloudflared'], { encoding: 'utf8' });
  const found = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return found || 'cloudflared';
}

function spawnCloudflared(args) {
  return spawn(cloudflaredPath(), args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Quick tunnel: random trycloudflare.com URL. */
function startQuickTunnel() {
  return new Promise((resolve, reject) => {
    const proc = spawnCloudflared(['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate']);
    children.push(proc);

    let settled = false;
    const onData = (buf) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) { settled = true; resolve({ url: m[0], mode: 'quick' }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      if (!settled) reject(new Error('Could not start cloudflared: ' + err.message +
        '\nInstall it with:  winget install Cloudflare.cloudflared'));
    });
    proc.on('exit', (code) => {
      if (!settled) reject(new Error('cloudflared exited (code ' + code + ')'));
      else shutdown(1);
    });

    setTimeout(() => {
      if (!settled) reject(new Error('Timed out waiting for the tunnel URL'));
    }, 45000);
  });
}

/** Named tunnel: stable URL from our own domain. */
function startNamedTunnel(token, hostname) {
  return new Promise((resolve, reject) => {
    // NOTE: --no-autoupdate is only valid for the quick-tunnel command
    // (`cloudflared tunnel --url ...`), NOT for `tunnel run`.
    const proc = spawnCloudflared(['tunnel', 'run', '--token', token]);
    children.push(proc);

    let settled = false;
    let cloudflaredLog = '';
    const onData = (buf) => {
      const text = buf.toString();
      cloudflaredLog += text;
      // The tunnel is up once it reports a registered connection.
      if (/Registered tunnel connection|connection.*registered/i.test(text) && !settled) {
        settled = true;
        resolve({ url: 'https://' + hostname, mode: 'named' });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      if (!settled) reject(new Error('Could not start cloudflared: ' + err.message));
    });
    proc.on('exit', (code) => {
      if (!settled) {
        // Show what cloudflared actually complained about — much more useful
        // than a generic "check your token" message.
        const detail = (cloudflaredLog.split('\n')
          .map((l) => l.trim())
          .filter((l) => /ERR|error|invalid|unauth|flag|usage/i.test(l))
          .slice(0, 3).join(' | '));
        reject(new Error(
          'Tunnel start nahi hua' + (detail ? ': ' + detail : ' (cloudflared ne koi detail nahi di)') + '\n' +
          '  • TUNNEL_TOKEN sahi hai? (docs/DOMAIN-SETUP.md — Cloudflare dashboard se copy karo)\n' +
          '  • PUBLIC_HOSTNAME sahi hai? (domain Cloudflare ke nameservers par hona chahiye)\n' +
          '  • DNS propagate hua? (nslookup ' + hostname + ')'
        ));
      } else {
        shutdown(1);
      }
    });

    setTimeout(() => {
      if (!settled) reject(new Error('Tunnel did not connect in time — check the TUNNEL_TOKEN in .env'));
    }, 45000);
  });
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const env = readEnv();
  const token = env.TUNNEL_TOKEN || '';
  const hostname = (env.PUBLIC_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  console.log('\n=== TableNest · Launcher ===\n');

  let tunnel;
  if (token && hostname) {
    console.log('Mode: NAMED tunnel (permanent URL) — ' + hostname);
    try {
      tunnel = await startNamedTunnel(token, hostname);
    } catch (err) {
      console.error('\n❌ Named tunnel fail: ' + err.message);
      console.error('   .env check karein: TUNNEL_TOKEN aur PUBLIC_HOSTNAME\n');
      shutdown(1);
      return;
    }
  } else {
    console.log('Mode: QUICK tunnel (temporary URL — testing ke liye)');
    if (!token) console.log('  (Staple URL ke liye .env mein TUNNEL_TOKEN + PUBLIC_HOSTNAME daalein)');
    try {
      tunnel = await startQuickTunnel();
    } catch (err) {
      console.error('\n❌ ' + err.message + '\n');
      console.error('Fallback: aap localhost:3000 par local trial kar sakte hain\n');
      shutdown(1);
      return;
    }
  }

  const url = tunnel.url;
  writeEnv('BASE_URL', url);
  console.log('\n  ✅ Public URL   ' + url);
  console.log('  ✅ .env updated (BASE_URL) — QR codes ab is URL par jayenge');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { BASE_URL: url }),
  });
  children.push(server);
  server.on('exit', (code) => shutdown(code || 0));

  console.log('\n  Customer menu (QR):  ' + url + '/menu?table=<token>');
  console.log('  Admin panel:         ' + url + '/admin');
  console.log('  Staff login:         ' + url + '/login\n');

  if (tunnel.mode === 'quick') {
    console.log('  NOTE: yeh URL har restart par badlega. QR print karne se PEHLE');
    console.log('        yeh script dobara chala lein taaki QR sahi rahein.');
    console.log('        (Permanent ke liye: domain + named tunnel — docs/DOMAIN-SETUP.md)\n');
  } else {
    console.log('  NOTE: yeh URL permanent hai — QR ek baar print karke zindagi bhar chalega.\n');
  }
}

main();
