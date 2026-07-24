/* API client, formatters, charts and the trace waterfall renderer. */
'use strict';

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401 && !path.startsWith('/share/')) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body.error && body.error.message) || `HTTP ${res.status}`), { status: res.status });
  return body;
}

const fmtMoney = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

// 2000 -> "$0.002"
const fmtMicros = (micros) => {
  const d = (Number(micros) || 0) / 1e6;
  const dec = d >= 1 ? 2 : d >= 0.01 ? 3 : 4;
  return `$${d.toFixed(dec)}`;
};

function animateValue(el, to, fmt, ms = 700) {
  if (!el) return;
  const from = Number(el.dataset.val || 0);
  el.dataset.val = String(to);
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min((t - t0) / ms, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const fmtUnitPrice = (micros, unit) => {
  const dollars = micros / 1e6;
  const per = unit === 'ns' ? 'sec' : unit === 'bytes' ? 'MB' : 'call';
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : dollars < 1 ? 3 : 2)} / ${per}`;
};

const fmtQty = (qty, unit) => {
  if (unit === 'ns') return `${(qty / 1e9).toFixed(2)} s`;
  if (unit === 'bytes') return qty >= 1e6 ? `${(qty / 1e6).toFixed(2)} MB` : `${(qty / 1e3).toFixed(1)} KB`;
  return `${qty.toLocaleString()}`;
};

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtPeriod = (s, e) =>
  `${new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtTime(s)} – ${fmtTime(e)}`;
const fmtDur = (ns) => {
  const ms = ns / 1e6;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${(ns / 1e3).toFixed(0)} µs`;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function reconBadge(r) {
  if (!r || r.status === 'pending') return `<span class="badge pending"><span class="dot"></span>pending</span>`;
  if (r.status === 'ok') return `<span class="badge ok"><span class="dot"></span>✓ complete</span>`;
  return `<span class="badge warn"><span class="dot"></span>⚠ ${esc(r.note || 'records unverifiable')}</span>`;
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---- trace waterfall ---- */
function renderWaterfall(container, spans, cost) {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const children = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parent_id && byId.has(s.parent_id)) {
      if (!children.has(s.parent_id)) children.set(s.parent_id, []);
      children.get(s.parent_id).push(s);
    } else {
      roots.push(s);
    }
  }
  const sortByStart = (a, b) => a.start_ms - b.start_ms || b.duration_ns - a.duration_ns;
  roots.sort(sortByStart);
  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const t1 = Math.max(...spans.map((s) => s.start_ms + s.duration_ns / 1e6));
  const total = Math.max(t1 - t0, 1);
  const rows = [];
  const walk = (span, depth) => {
    rows.push({ span, depth });
    (children.get(span.span_id) || []).sort(sortByStart).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));

  // Split the compute charge by self-time — a span's own time minus its
  // children's — so the shares sum to the total and point at the real driver
  // rather than at every ancestor above it.
  const selfNs = (span) => {
    const kids = children.get(span.span_id) || [];
    return Math.max(0, span.duration_ns - kids.reduce((a, c) => a + c.duration_ns, 0));
  };
  const hasCost = cost && cost.compute > 0 && cost.billed_duration_ns > 0;
  let topId = null;
  if (hasCost) {
    let max = -1;
    for (const { span } of rows) {
      const self = selfNs(span);
      if (self > max) { max = self; topId = span.span_id; }
    }
  }

  const banner = cost
    ? `<div class="wf-cost">
        <div class="wf-cost-total">+${fmtMicros(cost.total)}<span>this request</span></div>
        <div class="wf-cost-parts">
          <span>call<b>${fmtMicros(cost.call)}</b></span>
          <span>compute<b>${fmtMicros(cost.compute)}</b></span>
          <span>egress<b>${fmtMicros(cost.egress)}</b></span>
        </div>
        <div class="wf-cost-sku">${esc(cost.sku || '')}</div>
      </div>`
    : '';

  const attrNote = hasCost
    ? `<div class="wf-attr-note">The ≈ column splits the <b>compute</b> charge (${fmtMicros(cost.compute)}) by each span’s own time. Call & egress are per-request.</div>`
    : '';
  container.innerHTML = banner + attrNote + rows
    .map(({ span, depth }) => {
      const left = ((span.start_ms - t0) / total) * 100;
      const width = Math.max((span.duration_ns / 1e6 / total) * 100, 0.4);
      const cls = span.error ? 'error' : span.kind === 'Server' || span.kind === 'Client' ? '' : 'internal';
      let costCell = '';
      if (hasCost) {
        const share = cost.compute * (selfNs(span) / cost.billed_duration_ns);
        const hot = span.span_id === topId ? ' hot' : '';
        costCell = `<div class="wf-cost-cell${hot}" title="≈ share of compute charge by this span's own time">≈${fmtMicros(share)}</div>`;
      } else {
        costCell = '<div class="wf-cost-cell"></div>';
      }
      return `<div class="wf-row">
        <div class="wf-name" style="padding-left:${depth * 14}px" title="${esc(span.name)}">${esc(span.name)} <span class="svc">· ${esc(span.service || '')}</span></div>
        <div class="wf-track"><div class="wf-bar ${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div></div>
        <div class="wf-dur">${fmtDur(span.duration_ns)}</div>
        ${costCell}
      </div>`;
    })
    .join('');
}

function openWaterfallModal(traceId, fetcher, meta = '') {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">
    <h3>Request detail</h3>
    <div class="sub">${esc(meta)} · record ${esc(traceId.slice(0, 12))}…</div>
    <div class="wf">Loading…</div>
  </div>`;
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  const wf = back.querySelector('.wf');
  fetcher(traceId)
    .then((d) => renderWaterfall(wf, d.spans, d.cost))
    .catch(() => { wf.innerHTML = '<div class="note">Detail unavailable for this record.</div>'; });
}

/* ---- stacked-area chart: calls by SKU over time ---- */
const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];

function stackedAreaChart(container, series, opts = {}) {
  const W = Math.max(opts.width || container.clientWidth || 760, 320);
  const H = opts.height || 230;
  const pad = { l: 46, r: 14, t: 12, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  let s = (series || []).filter((x) => x.points && x.points.some((p) => p.value > 0))
    .sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const truncated = Math.max(0, s.length - SERIES_VARS.length);
  s = s.slice(0, SERIES_VARS.length);
  if (!s.length) {
    container.innerHTML = '<div class="note" style="padding:28px 8px">No usage in this window yet — run <span class="kbd">npm run traffic</span>.</div>';
    return;
  }
  const ts = [...new Set(s.flatMap((x) => x.points.map((p) => p.ts)))].sort((a, b) => a - b);
  const cols = s.map((x) => { const m = new Map(x.points.map((p) => [p.ts, p.value])); return ts.map((t) => m.get(t) || 0); });
  const stack = ts.map((_, i) => { let c = 0; return cols.map((col) => { const lo = c; c += col[i]; return [lo, c]; }); });
  const maxY = Math.max(1, ...ts.map((_, i) => cols.reduce((a, col) => a + col[i], 0)));
  const X = (i) => pad.l + (ts.length <= 1 ? iw / 2 : (i / (ts.length - 1)) * iw);
  const Y = (v) => pad.t + ih - (v / maxY) * ih;

  const gridVals = [0, maxY / 2, maxY];
  const grid = gridVals.map((v) => `<line class="ax-grid" x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${W - pad.r}" y2="${Y(v).toFixed(1)}"></line>
    <text class="ax-lbl" x="${pad.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v).toLocaleString()}</text>`).join('');

  const areas = s.map((ser, j) => {
    const top = ts.map((_, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(stack[i][j][1]).toFixed(1)}`).join(' ');
    const bot = ts.map((_, i) => `L${X(ts.length - 1 - i).toFixed(1)},${Y(stack[ts.length - 1 - i][j][0]).toFixed(1)}`).join(' ');
    const topLine = ts.map((_, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(stack[i][j][1]).toFixed(1)}`).join(' ');
    return `<path class="area-fill" d="${top} ${bot} Z" fill="var(${SERIES_VARS[j]})"></path>
      <path class="area-top" d="${topLine}" stroke="var(${SERIES_VARS[j]})"></path>`;
  }).join('');

  // Label each series at its last point, so identity does not depend on color.
  const labels = s.map((ser, j) => {
    const mid = Y((stack[ts.length - 1][j][0] + stack[ts.length - 1][j][1]) / 2);
    const total = cols[j].reduce((a, b) => a + b, 0);
    if (stack[ts.length - 1][j][1] - stack[ts.length - 1][j][0] < maxY * 0.06) return '';
    return `<text class="area-dlabel" x="${W - pad.r - 4}" y="${(mid + 3).toFixed(1)}" text-anchor="end" fill="var(${SERIES_VARS[j]})">${esc(ser.sku)} · ${total.toLocaleString()}</text>`;
  }).join('');

  const xlabels = ts.length > 1
    ? `<text class="ax-lbl" x="${pad.l}" y="${H - 8}" text-anchor="start">${fmtTime(ts[0])}</text>
       <text class="ax-lbl" x="${W - pad.r}" y="${H - 8}" text-anchor="end">${fmtTime(ts[ts.length - 1])}</text>`
    : '';

  const legend = `<div class="chart-legend">${s.map((ser, j) =>
    `<span class="lg-item"><span class="lg-sw" style="background:var(${SERIES_VARS[j]})"></span>${esc(ser.sku)}</span>`).join('')}${truncated ? `<span class="lg-item note">+${truncated} more SKU${truncated > 1 ? 's' : ''} not shown</span>` : ''}</div>`;

  container.innerHTML = `${legend}
    <div class="chart-plot" style="position:relative">
      <svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="calls by SKU over time" style="display:block">
        ${grid}${areas}${labels}${xlabels}
        <line class="crosshair" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" style="opacity:0"></line>
        <rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"></rect>
      </svg>
      <div class="chart-tip" style="opacity:0"></div>
    </div>`;

  // Crosshair and tooltip snap to the nearest timestamp.
  const svg = container.querySelector('svg');
  const cross = container.querySelector('.crosshair');
  const tip = container.querySelector('.chart-tip');
  const hit = container.querySelector('.hit');
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = 0, best = Infinity;
    ts.forEach((_, k) => { const d = Math.abs(X(k) - px); if (d < best) { best = d; i = k; } });
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.style.opacity = 1;
    const rows = s.map((ser, j) => `<div class="tip-row"><span class="lg-sw" style="background:var(${SERIES_VARS[j]})"></span>${esc(ser.sku)}<b>${cols[j][i].toLocaleString()}</b></div>`).join('');
    const total = cols.reduce((a, col) => a + col[i], 0);
    tip.innerHTML = `<div class="tip-time">${fmtTime(ts[i])}</div>${rows}<div class="tip-row tip-total">total<b>${total.toLocaleString()}</b></div>`;
    tip.style.opacity = 1;
    const leftPct = (X(i) / W) * 100;
    tip.style.left = `${leftPct > 60 ? X(i) / W * r.width - tip.offsetWidth - 10 : X(i) / W * r.width + 12}px`;
    tip.style.top = `${pad.t}px`;
  });
  hit.addEventListener('mouseleave', () => { cross.style.opacity = 0; tip.style.opacity = 0; });
}

/* ---- revenue by period ---- */
function barChart(container, bars, opts = {}) {
  const W = Math.max(opts.width || container.clientWidth || 760, 320);
  const H = opts.height || 180;
  const pad = { l: 46, r: 14, t: 14, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const data = (bars || []).filter((b) => b);
  if (!data.length) { container.innerHTML = '<div class="note" style="padding:24px 8px">No closed periods yet.</div>'; return; }
  const maxV = Math.max(1, ...data.map((b) => b.cents));
  const n = data.length;
  const gap = 6;
  const bw = Math.max(4, (iw - gap * (n - 1)) / n);
  const Y = (v) => pad.t + ih - (v / maxV) * ih;
  const gridVals = [0, maxV / 2, maxV];
  const grid = gridVals.map((v) => `<line class="ax-grid" x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${W - pad.r}" y2="${Y(v).toFixed(1)}"></line>
    <text class="ax-lbl" x="${pad.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fmtMoney(Math.round(v))}</text>`).join('');
  const rects = data.map((b, i) => {
    const x = pad.l + i * (bw + gap);
    const h = Math.max(1, (b.cents / maxV) * ih);
    const y = pad.t + ih - h;
    const last = i === n - 1;
    return `<rect class="bar${last ? ' bar-latest' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" data-i="${i}"></rect>`;
  }).join('');
  container.innerHTML = `<div class="chart-plot" style="position:relative">
    <svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="revenue by period" style="display:block">
      ${grid}${rects}
      <text class="ax-lbl" x="${pad.l}" y="${H - 7}" text-anchor="start">${fmtTime(data[0].period_start)}</text>
      <text class="ax-lbl" x="${W - pad.r}" y="${H - 7}" text-anchor="end">latest</text>
    </svg>
    <div class="chart-tip" style="opacity:0"></div></div>`;
  const tip = container.querySelector('.chart-tip');
  const svg = container.querySelector('svg');
  container.querySelectorAll('.bar').forEach((rect) => {
    rect.addEventListener('mouseenter', () => {
      const b = data[+rect.dataset.i];
      tip.innerHTML = `<div class="tip-time">${fmtPeriod(b.period_start, b.period_end)}</div>
        <div class="tip-row">revenue<b>${fmtMoney(b.cents)}</b></div>
        <div class="tip-row">invoices<b>${b.invoices}</b></div>`;
      tip.style.opacity = 1;
      const r = svg.getBoundingClientRect();
      const cx = (parseFloat(rect.getAttribute('x')) + parseFloat(rect.getAttribute('width')) / 2) / W * r.width;
      tip.style.left = `${Math.min(Math.max(cx - 70, 0), r.width - 150)}px`;
      tip.style.top = '6px';
    });
    rect.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}

/* ---- sparkline ---- */
function sparkline(points, w = 260, h = 40) {
  if (!points || points.length === 0) return `<svg width="${w}" height="${h}"></svg>`;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = w / Math.max(points.length - 1, 1);
  const xy = points.map((p, i) => [i * step, h - 3 - (p.value / max) * (h - 8)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${(points.length - 1) * step},${h} L0,${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="requests over time">
    <path class="spark-fill" d="${area}"></path>
    <path class="spark-line" d="${line}"></path>
  </svg>`;
}

function topbar(active, me) {
  return `<div class="topbar">
    <span class="logo"><span class="tb-mark">◆</span> TraceBill</span>
    <span class="tenant">${me ? esc(me.tenant.name) : ''}</span>
    <span class="spacer"></span>
    <nav>
      <a href="/" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
      <a href="/onboarding" class="${active === 'onboard' ? 'active' : ''}">Setup</a>
      <a href="#" id="logout">Sign out</a>
    </nav>
  </div>`;
}

function wireLogout() {
  const el = document.getElementById('logout');
  if (el) el.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  });
}
