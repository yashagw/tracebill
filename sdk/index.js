/**
 * @tracebill/node — usage metering in one init() call.
 *
 *   tracebill.init({
 *     key: 'tb_live_...',
 *     identify: (req) => apiKeyToCustomer(req),
 *   });
 *
 * init() boots an OpenTelemetry NodeSDK with http and express
 * auto-instrumentation, exporting OTLP/HTTP to TraceBill's ingest. Billing
 * attributes ride along on the request spans the app already produces.
 *
 * If identify() returns nothing the request is still recorded, just not billed —
 * it shows up as unattributed rather than being dropped.
 */
'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { deriveSku, normalizePath } = require('./sku');

let _sdk = null;

// Enforcement state, populated by init() and read by guard().
let _key = null;
let _identify = null;
let _enforceBase = null;
let _blocked = new Set();
let _enforceTimer = null;

function safeCall(fn, req) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(req);
  } catch {
    return undefined; // a broken callback must not break the caller's app
  }
}

function init(opts = {}) {
  if (_sdk) return _sdk;
  const {
    key,
    endpoint = process.env.TRACEBILL_ENDPOINT || 'http://localhost:4400/v1/traces',
    identify,
    sku,
    serviceName = process.env.TRACEBILL_SERVICE_NAME || 'app',
    flushIntervalMs = 1000,
  } = opts;
  if (!key) throw new Error('tracebill.init: `key` is required (find it in your TraceBill dashboard)');
  if (typeof identify !== 'function') {
    throw new Error('tracebill.init: `identify` is required — a function (req) => customerId');
  }

  _key = key;
  _identify = identify;
  _enforceBase = endpoint.replace(/\/v1\/traces\/?$/, '');

  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: { 'X-TraceBill-Key': key },
  });

  const attachBilling = (span, request, response) => {
    try {
      // Only inbound server requests; an IncomingMessage has .headers and .url.
      if (!request || typeof request.url !== 'string' || !request.headers) return;
      // Refused requests carry a separate blocked-customer attribute rather than
      // billing.customer_id, so metering skips them but the dashboard can show them.
      if (request._tbBlocked) {
        span.setAttribute('billing.blocked', true);
        const blockedCustomer = safeCall(identify, request);
        if (blockedCustomer !== null && blockedCustomer !== undefined && blockedCustomer !== '') {
          span.setAttribute('billing.blocked_customer_id', String(blockedCustomer));
        }
        const route =
          (span.attributes && (span.attributes['http.route'] || span.attributes['http.target'])) || request.url;
        span.setAttribute('billing.sku', String(safeCall(sku, request) || deriveSku(request.method, route)));
        return;
      }
      const customer = safeCall(identify, request);
      if (customer !== null && customer !== undefined && customer !== '') {
        span.setAttribute('billing.customer_id', String(customer));
      }
      // The express instrumentation has set http.route by response-finish time
      // when the route matched; otherwise fall back to the raw URL.
      const route =
        (span.attributes && (span.attributes['http.route'] || span.attributes['http.target'])) ||
        request.url;
      const skuVal = safeCall(sku, request) || deriveSku(request.method, route);
      span.setAttribute('billing.sku', String(skuVal));
      let bytes = 0;
      if (response && typeof response.getHeader === 'function') {
        bytes = parseInt(response.getHeader('content-length'), 10) || 0;
      }
      span.setAttribute('billing.response_bytes', bytes);
    } catch {
      /* never break the request path */
    }
  };

  _sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: flushIntervalMs,
        maxExportBatchSize: 512,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          applyCustomAttributesOnSpan: attachBilling,
        },
      }),
    ],
  });
  _sdk.start();

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return _sdk;
}

// Optional middleware that 429s customers TraceBill has flagged over quota.
// Add with app.use(tracebill.guard()).
function guard({ pollMs = 5000, status = 429, message = 'Usage quota exceeded for this billing period.' } = {}) {
  startEnforcePolling(pollMs);
  return (req, res, next) => {
    try {
      const customer = safeCall(_identify, req);
      if (customer !== null && customer !== undefined && customer !== '' && _blocked.has(String(customer))) {
        req._tbBlocked = true; // attachBilling reads this and skips billing the call
        res.status(status).set('Retry-After', '60').json({
          error: { code: 'quota_exceeded', message },
        });
        return;
      }
    } catch {
      /* never break the request path */
    }
    next();
  };
}

function startEnforcePolling(pollMs) {
  if (_enforceTimer || !_enforceBase || !_key) return;
  const poll = async () => {
    try {
      const r = await fetch(`${_enforceBase}/enforce`, { headers: { 'X-TraceBill-Key': _key } });
      if (r.ok) {
        const d = await r.json();
        _blocked = new Set((d.blocked || []).map(String));
      }
    } catch {
      /* keep last-known verdict on transient errors */
    }
  };
  poll();
  _enforceTimer = setInterval(poll, pollMs);
  if (_enforceTimer.unref) _enforceTimer.unref();
}

async function shutdown() {
  if (_enforceTimer) {
    clearInterval(_enforceTimer);
    _enforceTimer = null;
  }
  if (_sdk) {
    const s = _sdk;
    _sdk = null;
    try {
      await s.shutdown();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { init, guard, shutdown, deriveSku, normalizePath };
