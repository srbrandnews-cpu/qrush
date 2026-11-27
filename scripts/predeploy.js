'use strict';

/**
 * Local pre-deploy gate. Run `npm run predeploy` before pushing to main.
 * It refuses a dirty worktree and prints the release checklist.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20e6 });

function main() {
  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.error('Working tree is not clean. Commit every file before deploying:\n' + dirty);
    process.exit(1);
  }

  const tracked = run('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/);
  const leaked = tracked.filter((f) => /(^|\/)\.env$|\.pem$|\.key$/i.test(f));
  if (leaked.length) {
    console.error('Secret-looking files are tracked in git:\n' + leaked.join('\n'));
    process.exit(1);
  }

  if (!fs.existsSync(path.join(ROOT, 'scripts', 'backup-db.js'))) {
    console.error('Backup script missing - refusing to deploy.');
    process.exit(1);
  }

  console.log('Pre-deploy checks passed.');
  console.log(`
Release checklist
  1. npm run verify                 # syntax + smoke test + npm audit
  2. npm run backup:db -- --out backups/pre-deploy-<date>.json
     (needs DATABASE_URL in .env; skip only if the DB has no real data)
  3. Push to the staging branch first and smoke-test there
  4. Merge to main, watch the deploy, then re-run the production smoke checks
  5. git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push --follow-tags
  6. docs/CHANGELOG.md: add the release note
`);
}

main();
