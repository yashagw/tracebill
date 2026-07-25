// Container entrypoint: seed on first boot, then run the gateway and app. Kept
// separate from scripts/dev.js so a local run never silently seeds.
'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const cfg = require('../lib/config');
const { open } = require('../lib/db');

const ROOT = path.join(__dirname, '..');

function alreadySeeded() {
  try {
    const db = open(cfg.DB_PATH);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tenants').get();
    db.close();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

if (alreadySeeded()) {
  console.log('[entrypoint] database already seeded, leaving it alone');
} else {
  console.log('[entrypoint] first boot — seeding');
  const r = spawnSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const child = spawn(process.execPath, ['scripts/dev.js', '--only=gateway,app'], { cwd: ROOT, stdio: 'inherit' });
const stop = (sig) => () => child.kill(sig);
process.on('SIGTERM', stop('SIGTERM'));
process.on('SIGINT', stop('SIGINT'));
child.on('exit', (code) => process.exit(code ?? 0));
