/**
 * Meter loop + close loop, run in-process by the app.
 *
 * Four properties the rest of the system relies on:
 *   - invoices are idempotent per (tenant, customer, period_start);
 *   - line ids are derived from (invoice, sku), so receipts survive a recompute;
 *   - receipts dedupe on (invoice_line_id, span_id), which together with
 *     metering server spans only makes at-least-once ingest safe to replay;
 *   - closed invoices never change — every write goes through assertInvoiceOpen().
 */
'use strict';

const { sha256, newId } = require('../lib/ids');
const { computeLines, subtotalCents, totalCalls, loadPricing } = require('../lib/pricing');

class ClosedInvoiceError extends Error {
  constructor(invoiceId) {
    super(`invoice ${invoiceId} is closed and immutable`);
    this.code = 'closed_invoice';
  }
}

class Engine {
  constructor({ db, signoz, pricingPath, periodMinutes = 5, closeGraceMs = 20000, log = () => {} }) {
    this.db = db;
    this.signoz = signoz;
    this.pricingPath = pricingPath;
    this.periodMs = periodMinutes * 60 * 1000;
    this.closeGraceMs = closeGraceMs;
    this.log = log;
    this._timer = null;
  }

  pricingFor(tenantId) {
    // Reloaded every cycle so edits to pricing.yaml take effect without a restart.
    const all = loadPricing(this.pricingPath);
    return all[tenantId] || all.default || { skus: { default: { unit_price_micros: 0, free_units: 0 } } };
  }

  periodFor(ts) {
    const start = Math.floor(ts / this.periodMs) * this.periodMs;
    return { start, end: start + this.periodMs };
  }

  start(intervalMs) {
    const tick = () => this.runOnce().catch((e) => this.log(`engine tick failed: ${e.message}`));
    this._timer = setInterval(tick, intervalMs);
    tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async runOnce(now = Date.now()) {
    const tenants = this.db.prepare('SELECT id FROM tenants').all();
    for (const t of tenants) {
      try {
        await this.meterTenantPeriod(t.id, this.periodFor(now));
      } catch (e) {
        this.log(`meter(${t.id}) failed: ${e.message}`);
      }
    }
    await this.closeDuePeriods(now);
  }

  // ---------- invoice store ----------

  assertInvoiceOpen(invoiceId) {
    const row = this.db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceId);
    if (!row) throw new Error(`invoice ${invoiceId} not found`);
    if (row.status !== 'open') throw new ClosedInvoiceError(invoiceId);
  }

  upsertCustomer(tenantId, externalId) {
    this.db
      .prepare('INSERT OR IGNORE INTO customers (id, tenant_id, external_id) VALUES (?, ?, ?)')
      .run(newId('cus'), tenantId, externalId);
    return this.db
      .prepare('SELECT * FROM customers WHERE tenant_id = ? AND external_id = ?')
      .get(tenantId, externalId);
  }

  /** Anchored on UNIQUE(tenant, customer, period_start). */
  getOrCreateInvoice(tenantId, customerId, period) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO invoices (id, tenant_id, customer_id, period_start, period_end, status, subtotal_cents, reconciliation, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', 0, 'pending', ?)`
      )
      .run(newId('inv'), tenantId, customerId, period.start, period.end, Date.now());
    return this.db
      .prepare('SELECT * FROM invoices WHERE tenant_id = ? AND customer_id = ? AND period_start = ?')
      .get(tenantId, customerId, period.start);
  }

  lineId(invoiceId, sku) {
    return 'il_' + sha256(`${invoiceId}|${sku}`).slice(0, 20);
  }

  writeLines(invoice, lines) {
    this.assertInvoiceOpen(invoice.id);
    const seen = [];
    for (const l of lines) {
      const id = this.lineId(invoice.id, l.sku);
      seen.push(id);
      this.db
        .prepare(
          `INSERT INTO invoice_lines (id, invoice_id, sku, description, quantity, unit, unit_price_micros, free_units_applied, amount_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(invoice_id, sku) DO UPDATE SET
             quantity = excluded.quantity, description = excluded.description,
             unit = excluded.unit, unit_price_micros = excluded.unit_price_micros,
             free_units_applied = excluded.free_units_applied, amount_cents = excluded.amount_cents`
        )
        .run(id, invoice.id, l.sku, l.description, l.quantity, l.unit, l.unit_price_micros, l.free_units_applied, l.amount_cents);
    }
    // Drop lines that no longer appear in the aggregate. Defensive — a SKU
    // shouldn't disappear mid-period.
    const existing = this.db.prepare('SELECT id FROM invoice_lines WHERE invoice_id = ?').all(invoice.id);
    for (const row of existing) {
      if (!seen.includes(row.id)) {
        this.db.prepare('DELETE FROM receipts WHERE invoice_line_id = ?').run(row.id);
        this.db.prepare('DELETE FROM invoice_lines WHERE id = ?').run(row.id);
      }
    }
    this.db
      .prepare('UPDATE invoices SET subtotal_cents = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(subtotalCents(lines), Date.now(), invoice.id, 'open');
  }

  // ---------- meter ----------

  /**
   * One pass for one tenant and period: aggregate usage, upsert customers,
   * invoices and lines, refresh quota flags, then pull receipts.
   */
  async meterTenantPeriod(tenantId, period) {
    const usage = await this.signoz.usageAggregate(tenantId, period.start, period.end);
    const pricing = this.pricingFor(tenantId);
    const linesByCustomer = computeLines(pricing, usage);
    const invoiceByCustomerExt = {};

    const overIds = [];
    for (const [customerExt, lines] of Object.entries(linesByCustomer)) {
      const customer = this.upsertCustomer(tenantId, customerExt);
      const invoice = this.getOrCreateInvoice(tenantId, customer.id, period);
      if (invoice.status === 'closed') continue; // late spans never mutate a closed invoice
      this.writeLines(invoice, lines);
      invoiceByCustomerExt[customerExt] = invoice;

      // Quota for this period only; a per-customer override beats the default.
      const q = pricing.quota || {};
      const quota = (q.per_customer && q.per_customer[customerExt]) ?? q.calls_per_period;
      if (quota && totalCalls(lines) > quota) overIds.push(customer.id);
    }

    // Reset everyone to 'ok' first, then re-flag. Without the reset a blocked
    // customer stops generating usage and could never be un-flagged.
    if (overIds.length) {
      const ph = overIds.map(() => '?').join(',');
      this.db.prepare(`UPDATE customers SET quota_status = 'ok' WHERE tenant_id = ? AND id NOT IN (${ph})`).run(tenantId, ...overIds);
      this.db.prepare(`UPDATE customers SET quota_status = 'over' WHERE id IN (${ph})`).run(...overIds);
    } else {
      this.db.prepare("UPDATE customers SET quota_status = 'ok' WHERE tenant_id = ?").run(tenantId);
    }

    // A full-period pull plus INSERT OR IGNORE is both exact and replay-safe.
    const spans = await this.signoz.billableSpans(tenantId, period.start, period.end);
    for (const s of spans) {
      const invoice = invoiceByCustomerExt[s.customer];
      if (!invoice || !s.span_id || !s.sku) continue;
      const lineId = this.lineId(invoice.id, s.sku);
      const line = this.db.prepare('SELECT id FROM invoice_lines WHERE id = ?').get(lineId);
      if (!line) continue; // aggregation hasn't seen this SKU yet; next cycle will
      this.db
        .prepare(
          `INSERT OR IGNORE INTO receipts (invoice_line_id, trace_id, span_id, ts, route, duration_ms, status_code, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(lineId, s.trace_id, s.span_id, s.ts, s.route, s.duration_ms, s.status_code, s.bytes);
    }
  }

  // ---------- close ----------

  async closeDuePeriods(now = Date.now()) {
    const due = this.db
      .prepare('SELECT * FROM invoices WHERE status = ? AND period_end + ? < ?')
      .all('open', this.closeGraceMs, now);
    for (const invoice of due) {
      try {
        await this.closeInvoice(invoice);
      } catch (e) {
        this.log(`close(${invoice.id}) failed: ${e.message}`);
      }
    }
  }

  async closeInvoice(invoice) {
    // Final pass for the whole tenant+period, not just this invoice's customer.
    await this.meterTenantPeriod(invoice.tenant_id, {
      start: invoice.period_start,
      end: invoice.period_end,
    });
    // Reconcile the metered aggregate against span-level receipts, per call line.
    const lines = this.db
      .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? AND unit = ?')
      .all(invoice.id, 'calls');
    let delta = 0;
    for (const line of lines) {
      const { n } = this.db
        .prepare('SELECT COUNT(*) AS n FROM receipts WHERE invoice_line_id = ?')
        .get(line.id);
      delta += Math.abs(Number(line.quantity) - Number(n));
    }
    const reconciliation = delta === 0 ? 'ok' : 'warn';
    const note = delta === 0 ? 'every metered call has a matching usage record' : `${delta} records unverifiable`;
    this.db
      .prepare(
        `UPDATE invoices SET status = 'closed', reconciliation = ?, reconciliation_note = ?, updated_at = ? WHERE id = ? AND status = 'open'`
      )
      .run(reconciliation, note, Date.now(), invoice.id);
  }
}

module.exports = { Engine, ClosedInvoiceError };
