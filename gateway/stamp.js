// Injects tracebill.tenant_id into every resource of an OTLP trace export
// (JSON or protobuf). Any client-supplied value is overwritten, so a tenant
// cannot bill or read as another tenant by spoofing the attribute.
'use strict';

const path = require('path');
const protobuf = require('protobufjs');

const TENANT_KEY = 'tracebill.tenant_id';

let _root = null;
function proto() {
  if (!_root) {
    _root = protobuf.loadSync(path.join(__dirname, 'otlp_trace.proto'));
  }
  return {
    Req: _root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'),
  };
}

/** Mutates and returns a parsed JSON payload. */
function stampJson(payload, tenantId) {
  const rss = payload.resourceSpans || payload.resource_spans || [];
  for (const rs of rss) {
    if (!rs.resource) rs.resource = { attributes: [] };
    if (!Array.isArray(rs.resource.attributes)) rs.resource.attributes = [];
    rs.resource.attributes = rs.resource.attributes.filter((kv) => kv && kv.key !== TENANT_KEY);
    rs.resource.attributes.push({ key: TENANT_KEY, value: { stringValue: tenantId } });
  }
  return payload;
}

/** Decode -> stamp -> re-encode a protobuf payload. */
function stampProtobuf(buf, tenantId) {
  const { Req } = proto();
  const msg = Req.decode(buf);
  for (const rs of msg.resourceSpans) {
    if (!rs.resource) rs.resource = {};
    if (!Array.isArray(rs.resource.attributes)) rs.resource.attributes = [];
    rs.resource.attributes = rs.resource.attributes.filter((kv) => kv.key !== TENANT_KEY);
    rs.resource.attributes.push({ key: TENANT_KEY, value: { stringValue: tenantId } });
  }
  return Buffer.from(Req.encode(msg).finish());
}

/** For tests: decode a protobuf export request to a plain object. */
function decodeProtobuf(buf) {
  const { Req } = proto();
  return Req.toObject(Req.decode(buf), { defaults: false });
}

/** For tests: encode a plain object into a protobuf export request. */
function encodeProtobuf(obj) {
  const { Req } = proto();
  const err = Req.verify(obj);
  if (err) throw new Error(err);
  return Buffer.from(Req.encode(Req.fromObject(obj)).finish());
}

module.exports = { stampJson, stampProtobuf, decodeProtobuf, encodeProtobuf, TENANT_KEY };
