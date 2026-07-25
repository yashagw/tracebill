/**
 * End-to-end against a live local SigNoz. Spawns the real gateway, app and demo
 * tenant, sends a known number of real HTTP requests per customer, and asserts
 * the invoices match that count exactly. Nothing is stubbed: every billed number
 * travelled SDK -> gateway -> telemetry store -> aggregation -> invoice.
 *
 * Run with `npm run test:e2e`. Takes 3-4 minutes, since periods are 1 minute here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TENANT_A = `e2e-a-${RUN}`; // unique per run -> counts in the store start at zero
const TENANT_B = `e2e-b-${RUN}`;
const GW_PORT = 4451;
const APP_PORT = 4452;
const DEMO_PORT = 4453;
const DB_PATH = path.join(os.tmpdir(), `tb-e2e-${RUN}.db`);
const PRICING_PATH = path.join(os.tmpdir(), `tb-e2e-pricing-${RUN}.yaml`);
const LOG_DIR = path.join(os.tmpdir(), `tb-e2e-logs-${RUN}`);

// ---- the exactly-known traffic plan ----
const PLAN = {
  acme: { 'get./api/products': 12, 'post./api/checkout': 5 },
  globex: { 'get./api/products': 7 },
  initech: { 'get./api/products': 3 },
};
const UNATTRIBUTED = 2; // requests with no API key: recorded, never billed
const KEYS = { acme: 'ak_acme_1', globex: 'ak_globex_1', initech: 'ak_initech_1' };
const totalFor = (c) => Object.values(PLAN[c]).reduce((a, b) => a + b, 0);

const children = [];
let ingestKeyA;
const PASSWORD_A = 'e2e-pass-a';
const PASSWORD_B = 'e2e-pass-b';
let cookieA = '';
let cookieB = '';

const api = async (p, { method = 'GET', body, cookie = cookieA, raw = false } = {}) => {
  const res = await fetch(`http://localhost:${APP_PORT}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 90000, everyMs = 2000, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn().catch((e) => ({ __err: e.message }));
    if (last && !last.__err && last.done) return last;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last).slice(0, 400)}`);
}

function spawnProc(name, script, env) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
  });
  children.push(child);
  return child;
}

/** Sums per (customer, sku) across every invoice, since traffic can straddle a period. */
async function collectTotals() {
  const { json } = await api('/invoices');
  const totals = {}; // customer -> sku -> {qty, receipts, subtotal}
  const invoicesByCustomer = {};
  for (const i of json.invoices || []) {
    const { json: inv } = await api(`/invoices/${i.id}`);
    const cust = inv.customer.external_id;
    (invoicesByCustomer[cust] ||= []).push(inv);
    totals[cust] ||= {};
    for (const l of inv.lines) {
      if (l.unit !== 'calls') continue;
      totals[cust][l.sku] ||= { qty: 0, receipts: 0, lineRefs: [] };
      totals[cust][l.sku].qty += l.quantity;
      totals[cust][l.sku].receipts += l.receipt_count;
      totals[cust][l.sku].lineRefs.push({ invoiceId: inv.id, lineId: l.id });
    }
  }
  return { totals, invoicesByCustomer };
}

function planMatches(totals) {
  for (const [cust, skus] of Object.entries(PLAN)) {
    for (const [sku, n] of Object.entries(skus)) {
      if (!totals[cust] || !totals[cust][sku]) return false;
      if (totals[cust][sku].qty !== n || totals[cust][sku].receipts !== n) return false;
    }
  }
  return true;
}

test('E2E: exact billing through the full real pipeline', async (t) => {
  // ---------- a fresh tenant pair in a fresh database ----------
  const { open } = require('../lib/db');
  const { hashPassword } = require('../app/auth');
  const { sha256, newIngestKey, newId } = require('../lib/ids');
  const db = open(DB_PATH);
  const now = Date.now();
  ingestKeyA = newIngestKey('e2e');
  const keyB = newIngestKey('e2eb');
  for (const [id, name, email, pw, key] of [
    [TENANT_A, 'E2E Tenant A', `a-${RUN}@e2e.test`, PASSWORD_A, ingestKeyA],
    [TENANT_B, 'E2E Tenant B', `b-${RUN}@e2e.test`, PASSWORD_B, keyB],
  ]) {
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
    db.prepare('INSERT INTO tenant_users (id, tenant_id, email, password_hash) VALUES (?, ?, ?, ?)')
      .run(newId('usr'), id, email, hashPassword(pw));
    db.prepare('INSERT INTO ingest_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId('ik'), id, sha256(key), key.slice(0, 12), now);
  }
  fs.writeFileSync(
    PRICING_PATH,
    `tenants:\n  ${TENANT_A}:\n    skus:\n      "get./api/products": {description: Reads, unit_price_micros: 2000, free_units: 5}\n      "post./api/checkout": {description: Checkout, unit_price_micros: 20000, free_units: 0}\n      default: {unit_price_micros: 1000, free_units: 0}\n    compute: {price_micros_per_second: 30000}\n    egress: {price_micros_per_mb: 90000}\n    quota: {calls_per_period: 1000}\n`
  );

  // ---------- the three processes, as they run in the demo ----------
  spawnProc('gateway', 'gateway/server.js', { TRACEBILL_DB: DB_PATH, GATEWAY_PORT: String(GW_PORT) });
  spawnProc('app', 'app/server.js', {
    TRACEBILL_DB: DB_PATH,
    APP_PORT: String(APP_PORT),
    PRICING_PATH,
    PERIOD_MINUTES: '1',
    METER_INTERVAL_MS: '3000',
    CLOSE_GRACE_MS: '10000',
  });
  spawnProc('demo', 'demo/server.js', {
    TRACEBILL_KEY: ingestKeyA,
    TRACEBILL_ENDPOINT: `http://localhost:${GW_PORT}/v1/traces`,
    PORT: String(DEMO_PORT),
  });
  await waitFor(async () => {
    const g = await fetch(`http://localhost:${GW_PORT}/healthz`);
    const a = await fetch(`http://localhost:${APP_PORT}/healthz`);
    const d = await fetch(`http://localhost:${DEMO_PORT}/healthz`);
    return { done: g.ok && a.ok && d.ok };
  }, { label: 'processes healthy', timeoutMs: 30000 });

  // login both tenants
  for (const [email, pw, setC] of [
    [`a-${RUN}@e2e.test`, PASSWORD_A, (c) => (cookieA = c)],
    [`b-${RUN}@e2e.test`, PASSWORD_B, (c) => (cookieB = c)],
  ]) {
    const res = await fetch(`http://localhost:${APP_PORT}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    });
    assert.strictEqual(res.status, 200, 'login works');
    setC(res.headers.get('set-cookie').split(';')[0]);
  }

  // ---------- send the traffic plan over real HTTP ----------
  await t.test('unknown ingest key is rejected at the gateway', async () => {
    const res = await fetch(`http://localhost:${GW_PORT}/v1/traces`, {
      method: 'POST',
      headers: { 'X-TraceBill-Key': 'tb_live_bogus', 'Content-Type': 'application/json' },
      body: '{"resourceSpans":[]}',
    });
    assert.strictEqual(res.status, 401);
  });

  for (const [cust, skus] of Object.entries(PLAN)) {
    for (const [sku, n] of Object.entries(skus)) {
      const [method, route] = sku.split('.');
      for (let i = 0; i < n; i++) {
        const res = await fetch(`http://localhost:${DEMO_PORT}${route}`, {
          method: method.toUpperCase(),
          headers: { 'x-api-key': KEYS[cust], 'content-type': 'application/json' },
          body: method === 'post' ? '{}' : undefined,
        });
        assert.strictEqual(res.status, 200, `${cust} ${sku} #${i}`);
      }
    }
  }
  for (let i = 0; i < UNATTRIBUTED; i++) {
    await fetch(`http://localhost:${DEMO_PORT}/api/products`); // no API key -> not billed
  }

  // ---------- billing exactness ----------
  let totals, invoicesByCustomer;
  await t.test('invoice quantities and receipt counts match sent traffic EXACTLY', async () => {
    await waitFor(async () => {
      ({ totals, invoicesByCustomer } = await collectTotals());
      return { done: planMatches(totals), totals };
    }, { label: 'exact invoice totals', timeoutMs: 120000 });
    for (const [cust, skus] of Object.entries(PLAN)) {
      for (const [sku, n] of Object.entries(skus)) {
        assert.strictEqual(totals[cust][sku].qty, n, `${cust}/${sku} quantity exact`);
        assert.strictEqual(totals[cust][sku].receipts, n, `${cust}/${sku} receipts exact`);
      }
      // and no SKUs beyond the plan
      assert.deepStrictEqual(Object.keys(totals[cust]).sort(), Object.keys(PLAN[cust]).sort());
    }
    // the unattributed requests were billed to nobody
    const allCustomers = Object.keys(totals);
    assert.deepStrictEqual(allCustomers.sort(), Object.keys(PLAN).sort());
  });

  await t.test('pricing math on the real invoice (integer money)', async () => {
    // acme products: 12 calls, 5 free -> 7 * $0.002 = $0.014 -> 1 cent (half-up)
    // acme checkout: 5 * $0.02 = $0.10 -> 10 cents
    const acmeCallCents = { 'get./api/products': 1, 'post./api/checkout': 10 };
    let seen = {};
    for (const inv of invoicesByCustomer.acme || []) {
      for (const l of inv.lines) {
        if (l.unit !== 'calls') continue;
        seen[l.sku] = (seen[l.sku] || 0) + l.amount_cents;
      }
    }
    // Only assert when everything landed in one period. The free tier is
    // per-period, so a straddle changes the split across invoices, not the total.
    if ((invoicesByCustomer.acme || []).length === 1) {
      assert.deepStrictEqual(seen, acmeCallCents);
    }
  });

  await t.test('every receipt trace resolves through the scoped waterfall API', async () => {
    let checked = 0;
    for (const [cust, skus] of Object.entries(totals)) {
      for (const [sku, agg] of Object.entries(skus)) {
        for (const ref of agg.lineRefs) {
          const { json } = await api(`/invoices/${ref.invoiceId}/lines/${ref.lineId}/receipts?limit=100`);
          for (const r of json.receipts) {
            const { status, json: tr } = await api(`/traces/${r.trace_id}`);
            assert.strictEqual(status, 200, `trace ${r.trace_id} resolves`);
            assert.ok(tr.spans.length >= 1, 'spans returned');
            assert.ok(tr.spans.every((s) => s.tags === undefined), 'no raw attributes leak');
            checked++;
          }
        }
      }
    }
    const expected = Object.keys(PLAN).reduce((s, c) => s + totalFor(c), 0);
    assert.strictEqual(checked, expected, `checked all ${expected} receipts`);
  });

  let sampleTrace, acmeInvoiceId, shareUrl;
  await t.test('cross-tenant isolation: tenant B sees nothing of tenant A', async () => {
    acmeInvoiceId = invoicesByCustomer.acme[0].id;
    const { json } = await api(`/invoices/${acmeInvoiceId}/lines/${totals.acme['get./api/products'].lineRefs[0].lineId}/receipts?limit=1`);
    sampleTrace = json.receipts[0].trace_id;

    const b1 = await api('/customers', { cookie: cookieB });
    assert.deepStrictEqual(b1.json.customers, [], 'tenant B discovered no customers');
    const b2 = await api(`/invoices/${acmeInvoiceId}`, { cookie: cookieB });
    assert.strictEqual(b2.status, 404, 'tenant A invoice invisible to B (404, not 403)');
    const b3 = await api(`/traces/${sampleTrace}`, { cookie: cookieB });
    assert.strictEqual(b3.status, 404, 'tenant A trace invisible to B');
    const b4 = await api('/invoices', { cookie: cookieB });
    assert.deepStrictEqual(b4.json.invoices, [], 'tenant B has no invoices');
  });

  await t.test('share token: scoped to its customer, idempotent per invoice', async () => {
    const s1 = await api(`/invoices/${acmeInvoiceId}/share`, { method: 'POST' });
    const s2 = await api(`/invoices/${acmeInvoiceId}/share`, { method: 'POST' });
    assert.strictEqual(s1.json.url, s2.json.url, 'idempotent');
    shareUrl = s1.json.url;
    const token = shareUrl.split('/').pop();

    const inv = await api(`/share/${token}`, { cookie: '' });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(inv.json.customer.external_id, 'acme');

    const okTrace = await api(`/share/${token}/traces/${sampleTrace}`, { cookie: '' });
    assert.strictEqual(okTrace.status, 200, "token reads its own customer's trace");

    // globex belongs to the same tenant, but not to this token
    const gRef = totals.globex['get./api/products'].lineRefs[0];
    const gRec = await api(`/invoices/${gRef.invoiceId}/lines/${gRef.lineId}/receipts?limit=1`);
    const globexTrace = gRec.json.receipts[0].trace_id;
    const denied = await api(`/share/${token}/traces/${globexTrace}`, { cookie: '' });
    assert.strictEqual(denied.status, 404, "another customer's trace is 404 via share token");

    const badToken = await api(`/share/shr_0000000000000000000000`, { cookie: '' });
    assert.strictEqual(badToken.status, 404);
  });

  await t.test('closed periods are immutable even as new traffic lands', async () => {
    // wait for all current invoices to close (1-min periods + 10s grace)
    const closed = await waitFor(async () => {
      const { json } = await api('/invoices');
      const open = (json.invoices || []).filter((i) => i.status === 'open');
      return { done: json.invoices.length > 0 && open.length === 0, invoices: json.invoices };
    }, { label: 'all invoices closed', timeoutMs: 180000, everyMs: 3000 });

    for (const i of closed.invoices) {
      assert.strictEqual(i.reconciliation, 'ok', `closed invoice ${i.id} reconciles ✓ complete`);
    }
    const snapshot = {};
    for (const i of closed.invoices) {
      const { json: inv } = await api(`/invoices/${i.id}`);
      snapshot[i.id] = JSON.stringify({ subtotal: inv.subtotal_cents, lines: inv.lines });
    }

    // more traffic, which lands in the new open period
    for (let i = 0; i < 4; i++) {
      await fetch(`http://localhost:${DEMO_PORT}/api/products`, { headers: { 'x-api-key': KEYS.acme } });
    }
    await sleep(12000); // several meter cycles

    for (const [id, before] of Object.entries(snapshot)) {
      const { json: inv } = await api(`/invoices/${id}`);
      assert.strictEqual(inv.status, 'closed');
      assert.strictEqual(JSON.stringify({ subtotal: inv.subtotal_cents, lines: inv.lines }), before, `closed invoice ${id} unchanged`);
    }
  });
});

test.after(async () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch {}
  }
  fs.rmSync(PRICING_PATH, { force: true });
  console.log(`e2e logs: ${LOG_DIR}`);
});
