// Shared config for gateway/app/demo. Reads .env (KEY=VALUE), then process.env wins.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) out[m[1]] = m[2];
    }
  } catch {
    /* no .env yet */
  }
  return out;
}

const dotenv = loadDotEnv();
const env = (k, dflt) => process.env[k] ?? dotenv[k] ?? dflt;

module.exports = {
  ROOT,
  env,
  DB_PATH: env('TRACEBILL_DB', path.join(ROOT, 'data', 'tracebill.db')),
  GATEWAY_PORT: parseInt(env('GATEWAY_PORT', '4400'), 10),
  APP_PORT: parseInt(env('APP_PORT', '4500'), 10),
  DEMO_PORT: parseInt(env('DEMO_PORT', '3002'), 10),
  // Internal telemetry backend; never exposed to tenants.
  SIGNOZ_URL: env('SIGNOZ_URL', 'http://localhost:8080'),
  SIGNOZ_OTLP: env('SIGNOZ_OTLP', 'http://localhost:4318'),
  SIGNOZ_EMAIL: env('SIGNOZ_EMAIL', ''),
  SIGNOZ_PASSWORD: env('SIGNOZ_PASSWORD', ''),
  SIGNOZ_ORG_ID: env('SIGNOZ_ORG_ID', ''),
  SIGNOZ_PAT: env('SIGNOZ_PAT', ''), // preferred over email/password if set
  PERIOD_MINUTES: parseInt(env('PERIOD_MINUTES', '5'), 10),
  METER_INTERVAL_MS: parseInt(env('METER_INTERVAL_MS', '15000'), 10),
  // Grace before closing a period, so in-flight telemetry lands before the
  // final meter pass.
  CLOSE_GRACE_MS: parseInt(env('CLOSE_GRACE_MS', '20000'), 10),
  WEBHOOK_SECRET: env('TRACEBILL_WEBHOOK_SECRET', 'change-me-webhook-secret'),
  PRICING_PATH: env('PRICING_PATH', path.join(ROOT, 'pricing.yaml')),
};
