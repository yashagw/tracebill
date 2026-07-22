/**
 * Ingest gateway. POST /v1/traces takes an OTLP/HTTP export (JSON or protobuf)
 * with an X-TraceBill-Key header, resolves the key to a tenant, stamps that
 * tenant into every resource, and forwards upstream, mirroring its status.
 */
'use strict';

const express = require('express');
const cfg = require('../lib/config');
const { open } = require('../lib/db');
const { KeyAuth } = require('./keys');
const { RateLimiter } = require('../lib/ratelimit');
const { stampJson, stampProtobuf } = require('./stamp');

const BODY_LIMIT = 5 * 1024 * 1024;
const UPSTREAM = `${cfg.SIGNOZ_OTLP}/v1/traces`;

function createServer({ dbPath = cfg.DB_PATH, upstream = UPSTREAM } = {}) {
  const db = open(dbPath);
  const keys = new KeyAuth(db);
  const ingestLimiter = new RateLimiter({ limit: 100, windowMs: 1000 });
  const app = express();
  app.disable('x-powered-by');

  app.use('/v1/traces', express.raw({ type: () => true, limit: BODY_LIMIT }));

  app.post('/v1/traces', async (req, res) => {
    const key = req.get('X-TraceBill-Key');
    const tenantId = keys.resolveTenant(key);
    if (!tenantId) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'unknown or revoked ingest key' } });
    }
    if (!ingestLimiter.allow(tenantId)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'ingest rate limit exceeded' } });
    }
    const ctype = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    let outBody;
    let outType;
    try {
      if (ctype === 'application/json') {
        const payload = JSON.parse(req.body.toString('utf8'));
        outBody = JSON.stringify(stampJson(payload, tenantId));
        outType = 'application/json';
      } else if (ctype === 'application/x-protobuf') {
        outBody = stampProtobuf(req.body, tenantId);
        outType = 'application/x-protobuf';
      } else {
        return res.status(415).json({ error: { code: 'unsupported_media_type', message: `unsupported content-type: ${ctype}` } });
      }
    } catch (e) {
      return res.status(400).json({ error: { code: 'bad_payload', message: `could not parse OTLP payload: ${e.message}` } });
    }
    try {
      const up = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': outType },
        body: outBody,
      });
      const upBody = Buffer.from(await up.arrayBuffer());
      res.status(up.status);
      const upType = up.headers.get('content-type');
      if (upType) res.set('Content-Type', upType);
      return res.send(upBody);
    } catch (e) {
      return res.status(502).json({ error: { code: 'upstream_unavailable', message: 'ingest temporarily unavailable' } });
    }
  });

  app.get('/healthz', async (req, res) => {
    let upstreamOk = false;
    try {
      const r = await fetch(upstream, { method: 'OPTIONS' });
      upstreamOk = r.status < 500 || r.status === 405;
    } catch {
      upstreamOk = false;
    }
    res.status(upstreamOk ? 200 : 503).json({ ok: upstreamOk, upstream: upstreamOk ? 'reachable' : 'unreachable' });
  });

  return app;
}

if (require.main === module) {
  const app = createServer();
  app.listen(cfg.GATEWAY_PORT, () => {
    console.log(`[tracebill-gateway] listening on http://localhost:${cfg.GATEWAY_PORT}`);
  });
}

module.exports = { createServer };
