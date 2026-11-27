'use strict';

/**
 * Fast syntax gate for every active JS file (and inline <script> blocks).
 *
 * Run with: npm run check:syntax
 * Kept dependency-free so it also runs in CI right after `npm install`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20e6 })
    .split(/\r?\n/)
    .filter(Boolean)
    // Old snapshots are kept for reference only - they are not deployed.
    .filter((f) => !f.startsWith('archive/') && !f.startsWith('node_modules/'));
}

const files = trackedFiles();
let checked = 0;
const problems = [];

for (const file of files) {
  const abs = path.join(ROOT, file);
  if (file.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
      checked += 1;
    } catch (err) {
      problems.push(`${file}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    }
  } else if (file.endsWith('.html')) {
    const html = fs.readFileSync(abs, 'utf8');
    const re = /<script(?![^>]*\btype=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (!m[1].trim()) continue;
      try {
        // Compile only - never execute page code in Node.
        new Function(m[1]);
        checked += 1;
      } catch (err) {
        problems.push(`${file} inline script: ${err.message}`);
      }
    }
  }
}

if (problems.length) {
  console.error('Syntax check FAILED:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log(`Syntax OK: ${checked} JS blocks checked.`);
