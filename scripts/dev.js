/**
 * Runs the gateway, app and demo tenant together with prefixed, colored logs,
 * so the demo needs one terminal instead of three. Ctrl-C stops all of them.
 *
 *   npm run dev
 *   npm run dev -- --traffic     # also start continuous demo traffic
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const cfg = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const COLORS = { gateway: '\x1b[35m', app: '\x1b[36m', demo: '\x1b[33m', traffic: '\x1b[32m' };
const RESET = '\x1b[0m';
const WIDTH = 8;

const procs = [
  { name: 'gateway', script: 'gateway/server.js' },
  { name: 'app', script: 'app/server.js' },
  { name: 'demo', script: 'demo/server.js' },
];
if (process.argv.includes('--traffic')) {
  procs.push({ name: 'traffic', script: 'demo/traffic.js', delayMs: 3000 });
}

const children = [];
let shuttingDown = false;

function prefix(name, chunk) {
  const tag = `${COLORS[name] || ''}${name.padEnd(WIDTH)}${RESET}│ `;
  for (const line of chunk.toString().split('\n')) {
    if (line.length) process.stdout.write(tag + line + '\n');
  }
}

function start({ name, script }) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => prefix(name, c));
  child.stderr.on('data', (c) => prefix(name, c));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    prefix(name, `exited with code ${code}`);
    if (code !== 0) shutdown(1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`TraceBill: portal on http://localhost:${cfg.APP_PORT}, ingest on :${cfg.GATEWAY_PORT}, demo API on :${cfg.DEMO_PORT}`);
console.log('Ctrl-C stops everything.\n');
for (const p of procs) {
  if (p.delayMs) setTimeout(() => start(p), p.delayMs);
  else start(p);
}
