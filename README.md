# TraceBill

**Invoices with receipts.** Usage-based billing for API companies — powered by the
telemetry they already emit.

Competitors make you build a second "billing events" pipeline next to your
observability pipeline, and then your customers have to trust the invoice number.
The bet here: **if you're instrumented with OpenTelemetry, you already emit your
billing data.** One `init()` call and you're metering; every invoice line item
expands into per-request receipts with a trace waterfall attached.

```js
const tracebill = require('@tracebill/node');
tracebill.init({
  key: process.env.TRACEBILL_KEY,
  identify: (req) => apiKeyToCustomer(req),   // who to bill for this request
});
```

## Plan

Three processes, one repo, one SQLite file:

| Process | Port | Role |
|---|---|---|
| `gateway` | 4400 | Ingest: authenticate the tenant key, stamp the tenant into every OTLP resource, forward |
| `app` | 4500 | Portal API + static portal + billing engine loops |
| `demo` | 3002 | A real Express API integrated via the real SDK |

Billing model: fixed short UTC periods for the demo (monthly in production
framing); integer micro-dollar unit prices and integer cent totals; invoices
idempotent per (tenant, customer, period); receipts keyed on span id so
at-least-once ingest is safe to replay; closed periods immutable.

SigNoz is the internal telemetry store — the full-fidelity query layer that makes
trace-granular receipts possible. Tenants never see it.

## Setup

```bash
cp .env.example .env
npm install
```

Needs Node ≥ 22.5 for the built-in `node:sqlite`, and a local SigNoz with OTLP on
`:4318` and the query API on `:8080`.
