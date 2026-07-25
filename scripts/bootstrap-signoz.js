/**
 * Claims the first-user slot on a fresh telemetry backend and saves the operator
 * credentials for engine/signoz.js. Idempotent.
 *
 * The account exists because the query API needs a credential and this SigNoz
 * build cannot mint an access token — see docs/ARCHITECTURE.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');

const BASE = cfg.SIGNOZ_URL;
const OUT = cfg.SIGNOZ_OPERATOR_FILE;
const EMAIL = cfg.env('SIGNOZ_BOOTSTRAP_EMAIL', 'ops@tracebill.local');
const PASSWORD = cfg.env('SIGNOZ_BOOTSTRAP_PASSWORD', 'TraceBillLocal!2026');
const ORG_NAME = cfg.env('SIGNOZ_BOOTSTRAP_ORG', 'TraceBill');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBackend({ timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/version`);
      if (res.ok) return res.json();
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(3000);
  }
  throw new Error(`telemetry backend at ${BASE} never became ready (${lastErr})`);
}

async function register() {
  const res = await fetch(`${BASE}/api/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'TraceBill Operator',
      email: EMAIL,
      password: PASSWORD,
      orgName: ORG_NAME,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  const orgId = body?.data?.orgId;
  if (!orgId) throw new Error(`register returned no orgId: ${JSON.stringify(body).slice(0, 200)}`);
  return orgId;
}

async function verifyLogin(orgId) {
  const res = await fetch(`${BASE}/api/v2/sessions/email_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, orgID: orgId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.data?.accessToken) {
    throw new Error(`operator login failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
}

function save(orgId) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ email: EMAIL, password: PASSWORD, orgId }, null, 2) + '\n', { mode: 0o600 });
}

async function main() {
  const version = await waitForBackend();
  console.log(`[bootstrap] telemetry backend ${version.version || '?'} reachable at ${BASE}`);

  if (version.setupCompleted) {
    if (fs.existsSync(OUT)) {
      const saved = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      await verifyLogin(saved.orgId);
      console.log('[bootstrap] operator account already set up and working — nothing to do');
      return;
    }
    if (cfg.SIGNOZ_PAT || (cfg.SIGNOZ_EMAIL && cfg.SIGNOZ_ORG_ID)) {
      console.log('[bootstrap] backend already initialized, using credentials from the environment');
      return;
    }
    throw new Error(
      'The telemetry backend is already initialized, but no operator credentials were found.\n' +
        `  Expected them at ${OUT}.\n` +
        '  Either set SIGNOZ_EMAIL, SIGNOZ_PASSWORD and SIGNOZ_ORG_ID yourself, or reset the\n' +
        '  backend with: docker compose down -v'
    );
  }

  const orgId = await register();
  await verifyLogin(orgId);
  save(orgId);
  console.log(`[bootstrap] created operator account ${EMAIL} (org ${orgId})`);
  console.log(`[bootstrap] credentials written to ${OUT}`);
}

main().catch((e) => {
  console.error(`[bootstrap] ${e.message}`);
  process.exit(1);
});
