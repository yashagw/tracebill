/* Invoice renderer, shared by the tenant view and the customer share view. */
'use strict';

function renderInvoice(container, inv, opts) {
  const { receiptsFetcher, traceFetcher, onShare } = opts;
  const callLines = inv.lines.filter((l) => l.unit === 'calls');
  const otherLines = inv.lines.filter((l) => l.unit !== 'calls');
  const lineRow = (l) => `
    <tr class="${l.unit === 'calls' ? 'clickable line-row' : ''}" data-line="${esc(l.id)}">
      <td>
        <div>${esc(l.description)}</div>
        <div class="note">${esc(l.sku.startsWith('_') ? '' : l.sku)}</div>
      </td>
      <td class="num">${fmtQty(l.quantity, l.unit)}${l.free_units_applied ? `<div class="note">− ${l.free_units_applied} free</div>` : ''}</td>
      <td class="num">${fmtUnitPrice(l.unit_price_micros, l.unit)}</td>
      <td class="num">${l.unit === 'calls' ? `${l.receipt_count.toLocaleString()} <span class="note">view ›</span>` : '<span class="note">—</span>'}</td>
      <td class="num">${fmtMoney(l.amount_cents)}</td>
    </tr>`;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="margin:0">Invoice · ${esc(inv.customer.display_name)}</h1>
      <span class="status-chip ${esc(inv.status)}">${esc(inv.status)}</span>
      ${reconBadge(inv.reconciliation)}
      <span class="spacer" style="flex:1"></span>
      ${onShare ? '<button id="share" class="ghost">Copy customer link</button>' : ''}
    </div>
    <p class="note">Billing period ${fmtPeriod(inv.period_start, inv.period_end)}
      ${inv.status === 'open' ? '· updating live as usage arrives' : '· finalized'}</p>
    <table class="tb">
      <thead><tr><th>Line item</th><th class="num">Quantity</th><th class="num">Unit price</th><th class="num">Receipts</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${callLines.map(lineRow).join('')}
        ${otherLines.map(lineRow).join('')}
        <tr><td colspan="4" class="num" style="font-weight:650">Total</td>
            <td class="num" style="font-weight:650">${fmtMoney(inv.subtotal_cents)}</td></tr>
      </tbody>
    </table>
    <p class="note" style="margin-top:10px">Every call line expands into per-request usage records —
    click a line, then click a record to see exactly where its time went.</p>
    <div id="receipts-panel"></div>`;

  if (onShare) {
    container.querySelector('#share').addEventListener('click', onShare);
  }

  for (const row of container.querySelectorAll('.line-row')) {
    row.addEventListener('click', () => openReceipts(row.dataset.line));
  }

  async function openReceipts(lineId, cursor) {
    const panel = container.querySelector('#receipts-panel');
    const line = inv.lines.find((l) => l.id === lineId);
    panel.innerHTML = `<h2>Usage records — ${esc(line ? line.description : '')}</h2><div class="empty">Loading…</div>`;
    let data;
    try {
      data = await receiptsFetcher(lineId, cursor);
    } catch {
      panel.querySelector('.empty').textContent = 'Could not load usage records.';
      return;
    }
    panel.innerHTML = `
      <h2>Usage records — ${esc(line ? line.description : '')} <span class="note">(${(line ? line.receipt_count : 0).toLocaleString()} total)</span></h2>
      <table class="tb"><thead><tr>
        <th>Time</th><th>Route</th><th class="num">Duration</th><th class="num">Status</th><th class="num">Bytes</th><th></th>
      </tr></thead><tbody>
      ${data.receipts.map((r) => `
        <tr class="clickable receipt-row" data-trace="${esc(r.trace_id)}" data-route="${esc(r.route || '')}">
          <td>${fmtTime(r.ts)}</td>
          <td>${esc(r.route || '')}</td>
          <td class="num">${r.duration_ms == null ? '—' : r.duration_ms.toFixed(1) + ' ms'}</td>
          <td class="num">${r.status_code ?? '—'}</td>
          <td class="num">${(r.bytes ?? 0).toLocaleString()}</td>
          <td class="num note">detail ›</td>
        </tr>`).join('')}
      </tbody></table>
      ${data.next_cursor ? `<div class="row-actions"><button class="ghost" id="more">Load more</button></div>` : ''}`;
    if (data.next_cursor) {
      panel.querySelector('#more').addEventListener('click', () => openReceipts(lineId, data.next_cursor));
    }
    for (const row of panel.querySelectorAll('.receipt-row')) {
      row.addEventListener('click', () =>
        openWaterfallModal(row.dataset.trace, traceFetcher, row.dataset.route));
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
