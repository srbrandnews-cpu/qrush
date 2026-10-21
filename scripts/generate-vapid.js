'use strict';

/**
 * Generates a stable VAPID key pair for web push.
 *
 * Run this ONCE, then copy both values into your environment variables
 * (Firebase App Hosting / VPS / Railway):
 *
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *
 * Why it matters: on platforms with a temporary filesystem (Firebase App
 * Hosting, Cloud Run, Railway) the auto-generated keys would change on every
 * deploy — and every customer's saved notification subscription would break.
 * Setting them as environment variables keeps them stable forever.
 *
 * Run:  node scripts/generate-vapid.js
 */

const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const keys = webpush.generateVAPIDKeys();

console.log('\n=== TableNest · VAPID keys (web push) ===\n');
console.log('Copy these into your environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nVAPID_SUBJECT=mailto:support@yourdomain.com');
console.log('\nSave them now — if you lose the private key, every customer has to');
console.log('re-allow notifications on their phone.\n');

// Also drop them into .env for local use (if not already set there).
const envFile = path.join(__dirname, '..', '.env');
try {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const set = (key, value) => {
    const re = new RegExp('^' + key + '=.*$', 'm');
    content = re.test(content)
      ? content.replace(re, key + '=' + value)
      : content.trimEnd() + '\n' + key + '=' + value + '\n';
  };
  set('VAPID_PUBLIC_KEY', keys.publicKey);
  set('VAPID_PRIVATE_KEY', keys.privateKey);
  fs.writeFileSync(envFile, content, 'utf8');
  console.log('(.env mein bhi daal diya — wahi keys production mein use karein)');
} catch (err) {
  console.log('(.env update nahi hua: ' + err.message + ')');
}

// Keep the local data/vapid.json in sync, so the running dev server uses the
// same keys (otherwise old subscriptions would silently stop working).
try {
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'vapid.json'), JSON.stringify(keys), 'utf8');
  console.log('(data/vapid.json bhi update kar diya — local server consistent rahega)');
} catch (err) {
  console.log('(data/vapid.json update nahi hua: ' + err.message + ')');
}
console.log('');
