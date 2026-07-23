// Portal REST API, static portal, and the billing engine loops. All telemetry
// access goes through engine/signoz.js.
'use strict';

const path = require('path');
const express = require('express');
const cfg = require('../lib/config');
const { open } = require('../lib/db');
const { Auth } = require('./auth');
const { Engine } = require('../engine/engine');
const { SignozClient } = require('../engine/signoz');
const { RateLimiter } = require('../lib/ratelimit');
const { sha256, newIngestKey } = require('../lib/ids');
const { loadPricing, spanCostMicros } = require('../lib/pricing');

const SHARE_SECRET_FALLBACK = 'tracebill-share-secret';

function shareTokenFor(invoiceId, secret) {
  return 'shr_' + sha256(`${secret}|${invoiceId}`).slice(0, 22);
}

function createApp({ dbPath = cfg.DB_PATH, signoz, engineOpts = {} } = {}) {
  const db = open(dbPath);
  const auth = new Auth(db);
  const sz = signoz || new SignozClient();
  const shareSecret = cfg.env('SHARE_TOKEN_SECRET', SHARE_SECRET_FALLBACK);
  const engine = new Engine({
    db,
    signoz: sz,
    pricingPath: cfg.PRICING_PATH,
    periodMinutes: cfg.PERIOD_MINUTES,
    closeGraceMs: cfg.CLOSE_GRACE_MS,
    log: (m) => console.log(`[engine] ${m}`),
    ...engineOpts,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });
  const notFound = (res) => err(res, 404, 'not_found', 'not found');
  const loginLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 1000 });

  // ---------- helpers ----------

  const getCustomer = (tenantId, customerId) =>
    db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, tenantId);

  const getInvoice = (tenantId, invoiceId) =>
    db.prepare('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?').get(invoiceId, tenantId);

  function invoiceJson(invoice) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    const lines = db
      .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sku').all(invoice.id)
      .map((l) => ({
        id: l.id,
        sku: l.sku,
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit,
        unit_price_micros: Number(l.unit_price_micros),
        free_units_applied: Number(l.free_units_applied),
        amount_cents: Number(l.amount_cents),
        receipt_count: Number(
          db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE invoice_line_id = ?').get(l.id).n
        ),
      }));
    return {
      id: invoice.id,
      customer: { id: customer.id, external_id: customer.external_id, display_name: customer.display_name || customer.external_id },
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      status: invoice.status,
      subtotal_cents: Number(invoice.subtotal_cents),
      reconciliation: { status: invoice.reconciliation, note: invoice.reconciliation_note },
      updated_at: invoice.updated_at,
      lines,
    };
  }

  function receiptsPage(lineId, cursor, limit) {
    const off = Math.max(0, parseInt(cursor, 10) || 0);
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 100), 100);
    const rows = db
      .prepare('SELECT * FROM receipts WHERE invoice_line_id = ? ORDER BY ts, span_id LIMIT ? OFFSET ?')
      .all(lineId, lim + 1, off);
    const page = rows.slice(0, lim).map((r) => ({
      trace_id: r.trace_id,
      ts: Number(r.ts),
      route: r.route,
      duration_ms: r.duration_ms === null ? null : Math.round(Number(r.duration_ms) * 100) / 100,
      status_code: r.status_code === null ? null : Number(r.status_code),
      bytes: r.bytes === null ? null : Number(r.bytes),
    }));
    return { receipts: page, next_cursor: rows.length > lim ? String(off + lim) : null };
  }

  /** A line must belong to an invoice of this tenant, and this customer for shares. */
  function findLineScoped(lineId, tenantId, customerId = null) {
    const row = db
      .prepare(
        `SELECT il.id, i.tenant_id, i.customer_id FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id WHERE il.id = ?`
      )
      .get(lineId);
    if (!row || row.tenant_id !== tenantId) return null;
    if (customerId !== null && row.customer_id !== customerId) return null;
    return row;
  }

  // call/compute/egress breakdown for the billed span in a fetched trace.
  function traceCost(rawSpans, tenantId) {
    if (!rawSpans || !rawSpans.length) return null;
    const billed = rawSpans.find((s) => s.tags && s.tags['billing.sku']);
    if (!billed) return null;
    const pricing = engine.pricingFor(tenantId);
    const c = spanCostMicros(pricing, {
      sku: billed.tags['billing.sku'],
      durationNs: billed.duration_ns,
      bytes: Number(billed.tags['billing.response_bytes'] || 0),
    });
    return {
      ...c,
      sku: billed.tags['billing.sku'],
      billed_span_id: billed.span_id,
      billed_duration_ns: billed.duration_ns,
    };
  }

  function resolveShare(token) {
    if (!token || !/^shr_[0-9a-f]{22}$/.test(token)) return null;
    return db
      .prepare(
        `SELECT st.*, c.external_id AS customer_external_id, c.display_name FROM share_tokens st
         JOIN customers c ON c.id = st.customer_id WHERE st.token_hash = ?`
      )
      .get(sha256(token));
  }

  // ---------- auth & onboarding ----------

  app.post('/api/v1/auth/login', (req, res) => {
    if (!loginLimiter.allow(req.ip)) return err(res, 429, 'rate_limited', 'too many attempts, retry in a minute');
    const { email, password } = req.body || {};
    const result = auth.login(email, password);
    if (!result) return err(res, 401, 'bad_credentials', 'invalid email or password');
    auth.setCookie(res, result.token);
    const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(result.user.tenant_id);
    res.json({ tenant, user: { email: result.user.email } });
  });

  app.post('/api/v1/auth/logout', auth.middleware(), (req, res) => {
    auth.logout(req.sessionToken);
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/v1/me', auth.middleware(), (req, res) => {
    const key = db
      .prepare('SELECT prefix FROM ingest_keys WHERE tenant_id = ? AND (revoked_at IS NULL OR revoked_at > ?) ORDER BY created_at DESC')
      .get(req.tenantId, Date.now());
    const over = db
      .prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND quota_status = 'over'")
      .get(req.tenantId).n;
    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      user: req.user,
      ingest_key_prefix: key ? `${key.prefix}…` : null,
      quota_alerts: Number(over),
      period_minutes: cfg.PERIOD_MINUTES,
    });
  });

  app.post('/api/v1/ingest-keys/rotate', auth.middleware(), (req, res) => {
    const now = Date.now();
    // The old key stays valid for 60s so a redeploy can overlap.
    db.prepare('UPDATE ingest_keys SET revoked_at = ? WHERE tenant_id = ? AND (revoked_at IS NULL OR revoked_at > ?)')
      .run(now + 60000, req.tenantId, now);
    const key = newIngestKey();
    db.prepare('INSERT INTO ingest_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`ik_${sha256(key).slice(0, 12)}`, req.tenantId, sha256(key), key.slice(0, 12), now);
    res.json({ key, note: 'shown once — store it now; previous key valid for 60 more seconds' });
  });

  // Charges vs span-level receipts, for the reconciliation headline.
  app.get('/api/v1/summary', auth.middleware(), (req, res) => {
    const charges = Number(
      db.prepare(
        `SELECT COALESCE(SUM(il.quantity),0) AS n FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
         WHERE i.tenant_id = ? AND il.unit = 'calls'`
      ).get(req.tenantId).n
    );
    const receipts = Number(
      db.prepare(
        `SELECT COUNT(*) AS n FROM receipts r
         JOIN invoice_lines il ON il.id = r.invoice_line_id
         JOIN invoices i ON i.id = il.invoice_id
         WHERE i.tenant_id = ?`
      ).get(req.tenantId).n
    );
    const recon = { ok: 0, warn: 0, pending: 0 };
    for (const r of db.prepare('SELECT reconciliation, COUNT(*) AS n FROM invoices WHERE tenant_id = ? GROUP BY reconciliation').all(req.tenantId)) {
      recon[r.reconciliation] = Number(r.n);
    }
    const revenue = Number(
      db.prepare('SELECT COALESCE(SUM(subtotal_cents),0) AS c FROM invoices WHERE tenant_id = ?').get(req.tenantId).c
    );
    res.json({
      charges,
      receipts,
      verified_pct: charges ? Math.min(100, (receipts / charges) * 100) : null,
      invoices: recon,
      total_revenue_cents: revenue,
    });
  });

  // Revenue per billing period.
  app.get('/api/v1/revenue/periods', auth.middleware(), (req, res) => {
    const rows = db
      .prepare(
        `SELECT period_start, period_end, SUM(subtotal_cents) AS cents, COUNT(*) AS invoices
         FROM invoices WHERE tenant_id = ?
         GROUP BY period_start, period_end ORDER BY period_start DESC LIMIT 24`
      )
      .all(req.tenantId);
    res.json({
      periods: rows.reverse().map((r) => ({
        period_start: r.period_start,
        period_end: r.period_end,
        cents: Number(r.cents),
        invoices: Number(r.invoices),
      })),
    });
  });

  // ---------- usage & customers ----------

  app.get('/api/v1/customers', auth.middleware(), (req, res) => {
    const period = engine.periodFor(Date.now());
    const tenantPricing = loadPricing(cfg.PRICING_PATH)[req.tenantId];
    const quotaCfg = (tenantPricing && tenantPricing.quota) || {};
    const quotaFor = (ext) => (quotaCfg.per_customer && quotaCfg.per_customer[ext]) ?? quotaCfg.calls_per_period ?? null;
    const customers = db
      .prepare('SELECT * FROM customers WHERE tenant_id = ? ORDER BY external_id')
      .all(req.tenantId)
      .map((c) => {
        const inv = db
          .prepare('SELECT * FROM invoices WHERE tenant_id = ? AND customer_id = ? AND period_start = ?')
          .get(req.tenantId, c.id, period.start);
        let calls = 0;
        if (inv) {
          calls = Number(
            db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM invoice_lines WHERE invoice_id = ? AND unit = 'calls'").get(inv.id).n
          );
        }
        // Flag a running total at 2x or more of this customer's closed-period average.
        const hist = db
          .prepare("SELECT AVG(subtotal_cents) AS a, COUNT(*) AS n FROM invoices WHERE customer_id = ? AND status = 'closed'")
          .get(c.id);
        const avg = Number(hist.n) > 0 ? Number(hist.a) : null;
        const cur = inv ? Number(inv.subtotal_cents) : 0;
        const anomaly = avg && avg > 0 && cur >= avg * 2 && cur >= 20
          ? { avg_cents: Math.round(avg), factor: Math.round((cur / avg) * 10) / 10 }
          : null;
        return {
          id: c.id,
          external_id: c.external_id,
          display_name: c.display_name || c.external_id,
          quota_status: c.quota_status,
          quota: quotaFor(c.external_id),
          enforced: c.quota_status === 'over',
          anomaly,
          current_period: {
            calls,
            subtotal_cents: cur,
            invoice_id: inv ? inv.id : null,
          },
        };
      });
    res.json({ customers, period, quota: quotaCfg.calls_per_period ?? null });
  });

  app.get('/api/v1/usage/timeseries', auth.middleware(), async (req, res) => {
    const windowMs = Math.min(parseDuration(req.query.window, 60 * 60 * 1000), 24 * 3600 * 1000);
    const stepS = Math.max(Math.floor(parseDuration(req.query.step, 5 * 60 * 1000) / 1000), 15);
    const end = Date.now();
    try {
      const series = await sz.tenantUsageTimeseries(req.tenantId, end - windowMs, end, stepS);
      res.json({ series, window: { start: end - windowMs, end } });
    } catch (e) {
      err(res, 502, 'usage_unavailable', 'usage backend temporarily unavailable');
    }
  });

  app.get('/api/v1/customers/:id/usage', auth.middleware(), async (req, res) => {
    const c = getCustomer(req.tenantId, req.params.id);
    if (!c) return notFound(res);
    const windowMs = Math.min(parseDuration(req.query.window, 60 * 60 * 1000), 24 * 3600 * 1000);
    const stepS = Math.max(Math.floor(parseDuration(req.query.step, 60 * 1000) / 1000), 15);
    const end = Date.now();
    try {
      const series = await sz.usageTimeseries(req.tenantId, c.external_id, end - windowMs, end, stepS);
      res.json({ customer_id: c.id, series });
    } catch (e) {
      err(res, 502, 'usage_unavailable', 'usage backend temporarily unavailable');
    }
  });

  // Billable requests newer than `since` (ms), newest first, with per-request cost.
  app.get('/api/v1/activity', auth.middleware(), async (req, res) => {
    const now = Date.now();
    const period = engine.periodFor(now);
    const since = Math.max(parseInt(req.query.since, 10) || now - 60 * 1000, now - 15 * 60 * 1000);
    // Overlap slightly before `since` to absorb ingest lag, then filter by ts.
    const queryStart = Math.max(period.start, since - 10 * 1000);
    try {
      const [spans, blocked] = await Promise.all([
        sz.billableSpans(req.tenantId, queryStart, now, { pageSize: 1000, maxPages: 3 }),
        sz.blockedSpans(req.tenantId, queryStart, now),
      ]);
      const pricing = engine.pricingFor(req.tenantId);
      const names = new Map(
        db.prepare('SELECT external_id, display_name FROM customers WHERE tenant_id = ?')
          .all(req.tenantId)
          .map((c) => [c.external_id, c.display_name || c.external_id])
      );
      const billed = spans.filter((s) => s.ts > since && s.span_id).map((s) => {
        const cost = spanCostMicros(pricing, { sku: s.sku, durationNs: (s.duration_ms || 0) * 1e6, bytes: s.bytes || 0 });
        return {
          span_id: s.span_id, trace_id: s.trace_id, ts: s.ts,
          customer: s.customer, customer_name: names.get(s.customer) || s.customer,
          sku: s.sku, route: s.route, status_code: s.status_code,
          duration_ms: s.duration_ms == null ? null : Math.round(s.duration_ms * 100) / 100,
          amount_micros: cost.total, blocked: false,
        };
      });
      const refused = blocked.filter((s) => s.ts > since && s.span_id).map((s) => ({
        span_id: s.span_id, trace_id: s.trace_id, ts: s.ts,
        customer: s.customer, customer_name: names.get(s.customer) || s.customer,
        sku: s.sku, route: s.route, status_code: 429,
        duration_ms: s.duration_ms == null ? null : Math.round(s.duration_ms * 100) / 100,
        amount_micros: 0, blocked: true,
      }));
      const events = [...billed, ...refused].sort((a, b) => b.ts - a.ts).slice(0, 60);
      res.json({ events, cursor: now });
    } catch (e) {
      err(res, 502, 'activity_unavailable', 'activity backend temporarily unavailable');
    }
  });

  // ---------- invoices & receipts ----------

  app.get('/api/v1/invoices', auth.middleware(), (req, res) => {
    let sql = 'SELECT * FROM invoices WHERE tenant_id = ?';
    const args = [req.tenantId];
    if (req.query.customer_id) {
      sql += ' AND customer_id = ?';
      args.push(req.query.customer_id);
    }
    if (req.query.status === 'open' || req.query.status === 'closed') {
      sql += ' AND status = ?';
      args.push(req.query.status);
    }
    sql += ' ORDER BY period_start DESC, customer_id LIMIT 200';
    const invoices = db.prepare(sql).all(...args).map((i) => {
      const c = db.prepare('SELECT external_id, display_name FROM customers WHERE id = ?').get(i.customer_id);
      return {
        id: i.id,
        customer_id: i.customer_id,
        customer_name: (c && (c.display_name || c.external_id)) || 'unknown',
        period_start: i.period_start,
        period_end: i.period_end,
        status: i.status,
        subtotal_cents: Number(i.subtotal_cents),
        reconciliation: i.reconciliation,
      };
    });
    res.json({ invoices });
  });

  app.get('/api/v1/invoices/:id', auth.middleware(), (req, res) => {
    const invoice = getInvoice(req.tenantId, req.params.id);
    if (!invoice) return notFound(res);
    res.json(invoiceJson(invoice));
  });

  app.get('/api/v1/invoices/:id/lines/:lineId/receipts', auth.middleware(), (req, res) => {
    const invoice = getInvoice(req.tenantId, req.params.id);
    if (!invoice) return notFound(res);
    const line = findLineScoped(req.params.lineId, req.tenantId);
    if (!line) return notFound(res);
    res.json(receiptsPage(req.params.lineId, req.query.cursor, req.query.limit));
  });

  app.get('/api/v1/traces/:traceId', auth.middleware(), async (req, res) => {
    // Fetch, then re-verify every span carries this tenant's id.
    const spans = await sz.fetchTrace(req.params.traceId);
    const scoped = sz.scopeTrace(spans, req.tenantId);
    if (!scoped) return notFound(res);
    res.json({ trace_id: req.params.traceId, spans: scoped, cost: traceCost(spans, req.tenantId) });
  });

  app.post('/api/v1/invoices/:id/share', auth.middleware(), (req, res) => {
    const invoice = getInvoice(req.tenantId, req.params.id);
    if (!invoice) return notFound(res);
    const token = shareTokenFor(invoice.id, shareSecret); // deterministic, so re-sharing returns the same link
    db.prepare(
      'INSERT OR IGNORE INTO share_tokens (token_hash, tenant_id, customer_id, invoice_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(sha256(token), invoice.tenant_id, invoice.customer_id, invoice.id, Date.now());
    res.json({ url: `/share/${token}` });
  });

  // ---------- public share surface (no session) ----------

  app.get('/api/v1/share/:token', (req, res) => {
    const share = resolveShare(req.params.token);
    if (!share) return notFound(res);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(share.invoice_id);
    if (!invoice || invoice.tenant_id !== share.tenant_id || invoice.customer_id !== share.customer_id) return notFound(res);
    res.json(invoiceJson(invoice));
  });

  app.get('/api/v1/share/:token/lines/:lineId/receipts', (req, res) => {
    const share = resolveShare(req.params.token);
    if (!share) return notFound(res);
    const line = findLineScoped(req.params.lineId, share.tenant_id, share.customer_id);
    if (!line) return notFound(res);
    res.json(receiptsPage(req.params.lineId, req.query.cursor, req.query.limit));
  });

  app.get('/api/v1/share/:token/traces/:traceId', async (req, res) => {
    const share = resolveShare(req.params.token);
    if (!share) return notFound(res);
    // Scoped to the token's tenant and customer, both checked against span attributes.
    const spans = await sz.fetchTrace(req.params.traceId);
    const scoped = sz.scopeTrace(spans, share.tenant_id, share.customer_external_id);
    if (!scoped) return notFound(res);
    res.json({ trace_id: req.params.traceId, spans: scoped, cost: traceCost(spans, share.tenant_id) });
  });

  // ---------- machine ----------

  // Alertmanager-shaped payload: flags a customer over quota so the SDK 429s it.
  app.post('/api/v1/webhooks/quota-alert', (req, res) => {
    if (req.get('X-TraceBill-Webhook-Secret') !== cfg.WEBHOOK_SECRET) return err(res, 401, 'unauthorized', 'bad webhook secret');
    const labels = (req.body && (req.body.labels || (req.body.alerts && req.body.alerts[0] && req.body.alerts[0].labels))) || {};
    const tenantId = labels['tracebill.tenant_id'] || labels.tenant_id;
    const customerExt = labels['billing.customer_id'] || labels.customer_id;
    if (tenantId && customerExt) {
      db.prepare("UPDATE customers SET quota_status = 'over' WHERE tenant_id = ? AND external_id = ?").run(tenantId, customerExt);
    }
    res.json({ ok: true });
  });

  app.get('/api/v1/pricing', auth.middleware(), (req, res) => {
    const all = loadPricing(cfg.PRICING_PATH);
    res.json({ pricing: all[req.tenantId] || null });
  });

  app.get('/healthz', async (req, res) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {}
    const szOk = await sz.healthy();
    res.status(dbOk && szOk ? 200 : 503).json({ ok: dbOk && szOk, db: dbOk, usage_backend: szOk });
  });

  // ---------- portal static pages ----------

  const portalDir = path.join(__dirname, '..', 'portal');
  // Revalidate portal assets so edits show up on a normal refresh.
  const noStore = { setHeaders: (res) => res.set('Cache-Control', 'no-cache, must-revalidate') };
  const sendPage = (res, file) => { res.set('Cache-Control', 'no-cache, must-revalidate'); res.sendFile(path.join(portalDir, file)); };
  app.use('/assets', express.static(path.join(portalDir, 'assets'), noStore));
  app.get('/login', (req, res) => sendPage(res, 'login.html'));
  app.get('/', (req, res) => sendPage(res, 'index.html'));
  app.get('/onboarding', (req, res) => sendPage(res, 'onboarding.html'));
  app.get('/invoices/:id', (req, res) => sendPage(res, 'invoice.html'));
  app.get('/share/:token', (req, res) => sendPage(res, 'share.html'));

  app.use('/api', (req, res) => notFound(res));

  return { app, db, engine, auth };
}

function parseDuration(s, dflt) {
  if (!s) return dflt;
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(s));
  if (!m) return dflt;
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]];
  return parseInt(m[1], 10) * mult;
}

if (require.main === module) {
  const { app, engine } = createApp();
  engine.start(cfg.METER_INTERVAL_MS);
  app.listen(cfg.APP_PORT, () => {
    console.log(`[tracebill-app] portal + API on http://localhost:${cfg.APP_PORT}`);
  });
}

module.exports = { createApp, shareTokenFor };
