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

  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: { 'X-TraceBill-Key': key },
  });

  const attachBilling = (span, request, response) => {
    try {
      // Only inbound server requests; an IncomingMessage has .headers and .url.
      if (!request || typeof request.url !== 'string' || !request.headers) return;
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

async function shutdown() {
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

module.exports = { init, shutdown, deriveSku, normalizePath };
