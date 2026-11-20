'use strict';

/**
 * Consistent snapshot of the OpenCode chat database, safe to run while the app
 * is open (uses SQLite `VACUUM INTO`, so a half-written WAL is never copied).
 *
 *   npm run backup:chat
 *
 * Output: backups/opencode-chat-<timestamp>.db
 * Naye PC par is file ko `...\.local\share\opencode\opencode.db` bana kar rakho.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const dir = path.join(__dirname, '..', 'backups');
const dest = path.join(dir, 'opencode-chat-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');

if (!fs.existsSync(src)) {
  console.error('Chat database nahi mili:', src);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(dest)) fs.unlinkSync(dest);

const db = new DatabaseSync(src);
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const mb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log('✔ Chat backup saved:', dest, '(' + mb + ' MB)');
console.log('  Naye PC par: is file ko %USERPROFILE%\\.local\\share\\opencode\\opencode.db bana do (OpenCode band karke).');
