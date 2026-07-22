// Default SKU: "<method>.<route-pattern>", e.g. "get./api/products". With no
// route pattern from the framework, the URL path is normalized instead —
// numbers, uuids and long hex segments collapse to :id and the query is dropped.
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUM_RE = /^\d+$/;

function normalizePath(rawPath) {
  const path = String(rawPath || '/').split('?')[0].split('#')[0];
  const parts = path.split('/').map((seg) => {
    if (NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg)) return ':id';
    return seg;
  });
  let out = parts.join('/');
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function deriveSku(method, routeOrPath) {
  const m = String(method || 'get').toLowerCase();
  return `${m}.${normalizePath(routeOrPath)}`;
}

module.exports = { normalizePath, deriveSku };
