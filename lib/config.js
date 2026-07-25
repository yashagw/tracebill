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

const DB_PATH = env('TRACEBILL_DB', path.join(ROOT, 'data', 'tracebill.db'));
// Written by scripts/bootstrap-signoz.js; lives next to the database so the
// containers that share that volume also share the credentials.
const SIGNOZ_OPERATOR_FILE = env('SIGNOZ_OPERATOR_FILE', path.join(path.dirname(DB_PATH), 'signoz-operator.json'));

// Env always wins; this is the fallback for a Docker run nobody configured.
function loadOperator() {
  try {
    return JSON.parse(fs.readFileSync(SIGNOZ_OPERATOR_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const operator = loadOperator();

module.exports = {
  ROOT,
  env,
  DB_PATH,
  SIGNOZ_OPERATOR_FILE,
  GATEWAY_PORT: parseInt(env('GATEWAY_PORT', '4400'), 10),
  APP_PORT: parseInt(env('APP_PORT', '4500'), 10),
  DEMO_PORT: parseInt(env('DEMO_PORT', '3002'), 10),
  // Internal telemetry backend; never exposed to tenants.
  SIGNOZ_URL: env('SIGNOZ_URL', 'http://localhost:8080'),
  SIGNOZ_OTLP: env('SIGNOZ_OTLP', 'http://localhost:4318'),
  SIGNOZ_EMAIL: env('SIGNOZ_EMAIL', operator.email || ''),
  SIGNOZ_PASSWORD: env('SIGNOZ_PASSWORD', operator.password || ''),
  SIGNOZ_ORG_ID: env('SIGNOZ_ORG_ID', operator.orgId || ''),
  SIGNOZ_PAT: env('SIGNOZ_PAT', ''), // preferred over email/password if set
  PERIOD_MINUTES: parseInt(env('PERIOD_MINUTES', '5'), 10),
  METER_INTERVAL_MS: parseInt(env('METER_INTERVAL_MS', '15000'), 10),
  // Grace before closing a period, so in-flight telemetry lands before the
  // final meter pass.
  CLOSE_GRACE_MS: parseInt(env('CLOSE_GRACE_MS', '20000'), 10),
  WEBHOOK_SECRET: env('TRACEBILL_WEBHOOK_SECRET', 'change-me-webhook-secret'),
  PRICING_PATH: env('PRICING_PATH', path.join(ROOT, 'pricing.yaml')),
};
