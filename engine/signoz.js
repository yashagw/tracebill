/**
 * The only module that talks to the telemetry store. Every query filters on the
 * stamped tenant attribute, and no raw response reaches a tenant unscoped.
 *
 * Auth prefers SIGNOZ_PAT (sent as SIGNOZ-API-KEY). Without one it falls back to
 * a session JWT from /api/v2/sessions/email_password, refreshed every 20 minutes
 * because those expire in ~30. The credential stays in-process and is not logged.
 */
'use strict';

const cfg = require('../lib/config');

const JWT_REFRESH_MS = 20 * 60 * 1000;

class SignozClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || cfg.SIGNOZ_URL;
    this.pat = opts.pat || cfg.SIGNOZ_PAT;
    this.email = opts.email || cfg.SIGNOZ_EMAIL;
    this.password = opts.password || cfg.SIGNOZ_PASSWORD;
    this.orgId = opts.orgId || cfg.SIGNOZ_ORG_ID;
    this._jwt = null;
    this._jwtAt = 0;
  }

  async _headers(force = false) {
    if (this.pat) return { 'SIGNOZ-API-KEY': this.pat };
    if (!this._jwt || force || Date.now() - this._jwtAt > JWT_REFRESH_MS) {
      const res = await fetch(`${this.baseUrl}/api/v2/sessions/email_password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password, orgID: this.orgId }),
      });
      if (!res.ok) throw new Error(`telemetry-store auth failed: ${res.status}`);
      const body = await res.json();
      this._jwt = body.data.accessToken;
      this._jwtAt = Date.now();
    }
    return { Authorization: `Bearer ${this._jwt}` };
  }

  async _request(path, { method = 'GET', body } = {}, retried = false) {
    const headers = { 'Content-Type': 'application/json', ...(await this._headers(retried)) };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && !this.pat) return this._request(path, { method, body }, true);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`telemetry-store ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  async healthy() {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/version`);
      return res.ok;
    } catch {
      return false;
    }
  }

  _esc(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  _tenantFilter(tenantId) {
    return `tracebill.tenant_id = '${this._esc(tenantId)}'`;
  }

  async _queryRange(payload) {
    return this._request('/api/v5/query_range', { method: 'POST', body: payload });
  }

  /** Usage for one tenant+window: [{customer, sku, calls, compute_ns, egress_bytes}]. */
  async usageAggregate(tenantId, startMs, endMs) {
    const payload = {
      schemaVersion: 'v1',
      start: startMs,
      end: endMs,
      requestType: 'scalar',
      compositeQuery: {
        queries: [
          {
            type: 'builder_query',
            spec: {
              name: 'A',
              signal: 'traces',
              filter: {
                expression: `${this._tenantFilter(tenantId)} AND billing.customer_id EXISTS AND kind_string = 'Server'`,
              },
              aggregations: [
                { expression: 'count()' },
                { expression: 'sum(duration_nano)' },
                { expression: 'sum(billing.response_bytes)' },
              ],
              groupBy: [{ name: 'billing.customer_id' }, { name: 'billing.sku' }],
            },
          },
        ],
      },
    };
    const res = await this._queryRange(payload);
    const result = res?.data?.data?.results?.[0];
    if (!result || !result.data) return [];
    const cols = result.columns.map((c) => c.name);
    const idx = {
      customer: cols.indexOf('billing.customer_id'),
      sku: cols.indexOf('billing.sku'),
      calls: cols.indexOf('__result_0'),
      compute: cols.indexOf('__result_1'),
      egress: cols.indexOf('__result_2'),
    };
    return result.data
      .map((row) => ({
        customer: row[idx.customer],
        sku: row[idx.sku],
        calls: Number(row[idx.calls] || 0),
        compute_ns: Number(row[idx.compute] || 0),
        egress_bytes: Number(row[idx.egress] || 0),
      }))
      .filter((r) => r.customer && r.sku);
  }

  /**
   * Billable server spans for tenant+window, oldest first, paged. This is the
   * span-level evidence behind every receipt.
   */
  async billableSpans(tenantId, startMs, endMs, { pageSize = 1000, maxPages = 20 } = {}) {
    const out = [];
    let cursor = undefined;
    for (let page = 0; page < maxPages; page++) {
      const payload = {
        schemaVersion: 'v1',
        start: startMs,
        end: endMs,
        requestType: 'raw',
        compositeQuery: {
          queries: [
            {
              type: 'builder_query',
              spec: {
                name: 'A',
                signal: 'traces',
                filter: {
                  expression: `${this._tenantFilter(tenantId)} AND billing.customer_id EXISTS AND kind_string = 'Server'`,
                },
                selectFields: [
                  { name: 'trace_id' },
                  { name: 'span_id' },
                  { name: 'name' },
                  { name: 'duration_nano' },
                  { name: 'response_status_code' },
                  { name: 'billing.customer_id' },
                  { name: 'billing.sku' },
                  { name: 'billing.response_bytes' },
                  { name: 'http.route' },
                ],
                order: [{ key: { name: 'timestamp' }, direction: 'asc' }],
                limit: pageSize,
                ...(cursor ? { cursor } : {}),
              },
            },
          ],
        },
      };
      const res = await this._queryRange(payload);
      const result = res?.data?.data?.results?.[0];
      const rows = result?.rows || [];
      for (const r of rows) {
        const d = r.data || {};
        out.push({
          trace_id: d.trace_id,
          span_id: d.span_id,
          ts: Date.parse(d.timestamp || r.timestamp),
          customer: d['billing.customer_id'],
          sku: d['billing.sku'],
          route: d['http.route'] || d.name,
          duration_ms: Number(d.duration_nano || 0) / 1e6,
          status_code: parseInt(d.response_status_code, 10) || null,
          bytes: Number(d['billing.response_bytes'] || 0),
        });
      }
      cursor = result?.nextCursor;
      if (!cursor || rows.length < pageSize) break;
    }
    return out;
  }

  /** Refused (over-quota) spans. Shown on the live activity tape, never billed. */
  async blockedSpans(tenantId, startMs, endMs, { pageSize = 500, maxPages = 2 } = {}) {
    const out = [];
    let cursor = undefined;
    for (let page = 0; page < maxPages; page++) {
      const payload = {
        schemaVersion: 'v1',
        start: startMs,
        end: endMs,
        requestType: 'raw',
        compositeQuery: {
          queries: [
            {
              type: 'builder_query',
              spec: {
                name: 'A',
                signal: 'traces',
                filter: {
                  expression: `${this._tenantFilter(tenantId)} AND billing.blocked EXISTS AND kind_string = 'Server'`,
                },
                selectFields: [
                  { name: 'trace_id' },
                  { name: 'span_id' },
                  { name: 'name' },
                  { name: 'duration_nano' },
                  { name: 'billing.blocked_customer_id' },
                  { name: 'billing.sku' },
                  { name: 'http.route' },
                ],
                order: [{ key: { name: 'timestamp' }, direction: 'asc' }],
                limit: pageSize,
                ...(cursor ? { cursor } : {}),
              },
            },
          ],
        },
      };
      const res = await this._queryRange(payload);
      const result = res?.data?.data?.results?.[0];
      const rows = result?.rows || [];
      for (const r of rows) {
        const d = r.data || {};
        out.push({
          trace_id: d.trace_id,
          span_id: d.span_id,
          ts: Date.parse(d.timestamp || r.timestamp),
          customer: d['billing.blocked_customer_id'],
          sku: d['billing.sku'],
          route: d['http.route'] || d.name,
          duration_ms: Number(d.duration_nano || 0) / 1e6,
        });
      }
      cursor = result?.nextCursor;
      if (!cursor || rows.length < pageSize) break;
    }
    return out;
  }

  /**
   * Full span list with per-span tag maps. Callers must pass the result through
   * scopeTrace() before serving it to anyone.
   */
  async fetchTrace(traceId) {
    if (!/^[0-9a-f]{16,32}$/i.test(traceId)) return null;
    let res;
    try {
      res = await this._request(`/api/v1/traces/${traceId}`);
    } catch {
      return null;
    }
    const block = Array.isArray(res) ? res[0] : res?.[0] || res?.data?.[0];
    if (!block || !block.events || !block.columns) return null;
    const col = (n) => block.columns.indexOf(n);
    const iTime = col('__time');
    const iSpan = col('SpanId');
    const iName = col('Name');
    const iDur = col('DurationNano');
    const iKeys = col('TagsKeys');
    const iVals = col('TagsValues');
    const iRefs = col('References');
    const iErr = col('HasError');
    const iService = col('ServiceName');
    const iKind = col('SpanKind');
    const spans = block.events.map((e) => {
      const tags = {};
      const keys = e[iKeys] || [];
      const vals = e[iVals] || [];
      for (let i = 0; i < keys.length; i++) tags[keys[i]] = vals[i];
      let parent = null;
      for (const ref of e[iRefs] || []) {
        const m = /SpanId=([0-9a-f]*)/i.exec(ref);
        if (m && m[1]) parent = m[1];
      }
      return {
        span_id: e[iSpan],
        parent_id: parent,
        name: e[iName],
        service: e[iService],
        kind: e[iKind],
        start_ms: Number(e[iTime]),
        duration_ns: Number(e[iDur]),
        error: !!e[iErr],
        tags,
      };
    });
    return spans;
  }

  /**
   * Verifies every span carries the caller's tenant id, and for share tokens
   * that the trace is attributed to the expected customer. Returns spans with
   * tags stripped, or null — callers turn that into a 404.
   */
  scopeTrace(spans, tenantId, customerExternalId = null) {
    if (!spans || spans.length === 0) return null;
    for (const s of spans) {
      if (s.tags['tracebill.tenant_id'] !== tenantId) return null;
    }
    if (customerExternalId !== null) {
      const attributed = spans.some((s) => s.tags['billing.customer_id'] === customerExternalId);
      if (!attributed) return null;
    }
    return spans.map((s) => ({
      span_id: s.span_id,
      parent_id: s.parent_id,
      name: s.name,
      service: s.service,
      kind: s.kind,
      start_ms: s.start_ms,
      duration_ns: s.duration_ns,
      error: s.error,
    }));
  }

  /** Calls per SKU over a window, across all of a tenant's customers. */
  async tenantUsageTimeseries(tenantId, startMs, endMs, stepSeconds) {
    const payload = {
      schemaVersion: 'v1',
      start: startMs,
      end: endMs,
      requestType: 'time_series',
      compositeQuery: {
        queries: [
          {
            type: 'builder_query',
            spec: {
              name: 'A',
              signal: 'traces',
              stepInterval: stepSeconds,
              filter: {
                expression: `${this._tenantFilter(tenantId)} AND billing.customer_id EXISTS AND kind_string = 'Server'`,
              },
              aggregations: [{ expression: 'count()' }],
              groupBy: [{ name: 'billing.sku' }],
            },
          },
        ],
      },
    };
    const res = await this._queryRange(payload);
    const result = res?.data?.data?.results?.[0];
    const series = [];
    for (const agg of result?.aggregations || []) {
      for (const s of agg.series || []) {
        const sku = (s.labels || []).map((l) => l.value).join('/') || 'all';
        series.push({
          sku,
          points: (s.values || []).map((v) => ({ ts: v.timestamp, value: Number(v.value) })),
        });
      }
    }
    return series;
  }

  /** Calls per SKU over a window, for one customer. */
  async usageTimeseries(tenantId, customerExternalId, startMs, endMs, stepSeconds) {
    const payload = {
      schemaVersion: 'v1',
      start: startMs,
      end: endMs,
      requestType: 'time_series',
      compositeQuery: {
        queries: [
          {
            type: 'builder_query',
            spec: {
              name: 'A',
              signal: 'traces',
              stepInterval: stepSeconds,
              filter: {
                expression: `${this._tenantFilter(tenantId)} AND billing.customer_id = '${this._esc(customerExternalId)}' AND kind_string = 'Server'`,
              },
              aggregations: [{ expression: 'count()' }],
              groupBy: [{ name: 'billing.sku' }],
            },
          },
        ],
      },
    };
    const res = await this._queryRange(payload);
    const result = res?.data?.data?.results?.[0];
    const series = [];
    for (const agg of result?.aggregations || []) {
      for (const s of agg.series || []) {
        const sku = (s.labels || []).map((l) => l.value).join('/') || 'all';
        series.push({
          sku,
          points: (s.values || []).map((v) => ({ ts: v.timestamp, value: Number(v.value) })),
        });
      }
    }
    return series;
  }
}

module.exports = { SignozClient };
