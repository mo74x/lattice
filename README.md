# Lattice — Two-Way Property Management Sync Engine

**Lattice** is a backend synchronization engine that keeps booking data consistent across multiple Property Management Systems (PMS) in real-time. It solves the critical infrastructure challenge that every hospitality platform eventually faces: when a host lists the same property on Cloudbeds *and* Guesty, how do you guarantee that a booking change on one partner is reflected everywhere else — without infinite loops, data loss, or double bookings?

This is not a CRUD app. Lattice is a **distributed systems project** that tackles echo suppression, field-level conflict resolution, transactional outbox delivery, self-healing reconciliation, and concurrent overlap prevention — all under a strict p95 < 20ms ingestion SLA.

---

## The Problem

Vacation rental and hotel operators list their properties on multiple booking channels simultaneously. When a reservation is created, modified, or cancelled on one platform, every connected platform must be updated immediately. This creates several hard distributed systems problems:

### 1. The Infinite Echo Loop
When Lattice pushes a booking update to Cloudbeds, Cloudbeds fires a webhook back to Lattice with the same data. Without suppression, this triggers another push, creating an infinite update storm between systems. Lattice implements **three-layer echo suppression** to break this cycle.

### 2. Conflict Resolution Without Data Loss
Two PMS platforms can modify different fields of the same booking simultaneously. A partner might update the guest email while the internal system updates the check-in date. Naively accepting the "last write" loses one of the changes. Lattice uses **per-field authority policies** (`partner` | `internal` | `latest`) to merge changes at the field level, with full audit trails.

### 3. Webhook Reliability at Scale
Partner webhooks are unreliable. They arrive out of order, duplicated, or not at all. Lattice must ingest 500+ webhooks/sec with sub-20ms latency, deduplicate them, verify cryptographic signatures in constant time, and guarantee exactly-once processing.

### 4. Double Bookings (Concurrent Overlaps)
If two webhooks arrive simultaneously booking the same room for overlapping dates, standard application-level checks can race. Lattice enforces overlap prevention at the database level using PostgreSQL exclusion constraints, making double bookings structurally impossible.

### 5. Eventual Consistency Drift
Even with perfect webhook processing, drift accumulates: dropped webhooks, failed outbound pushes, partial failures. Lattice runs **reconciliation sweeps** that pull partner state, diff it against internal truth, classify the drift, and auto-heal it — with blast radius limits to prevent runaway corrections.

---

## Architecture

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                        Lattice API                          │
                    │                      (NestJS · :3000)                       │
                    ├─────────────────────────────────────────────────────────────┤
                    │                                                             │
  Cloudbeds ──webhook──▶ WebhookController ──▶ WebhookService                    │
  Guesty   ──webhook──▶      POST /webhooks/:connectionId                        │
                    │          │                                                  │
                    │          ├── 1. HMAC-SHA256 Signature Verification          │
                    │          ├── 2. RawEvent Ledger (Idempotent Insert)         │
                    │          └── 3. Enqueue → BullMQ "inbound-webhooks"         │
                    │                              │                              │
                    │                    ┌─────────▼──────────┐                   │
                    │                    │  InboundProcessor   │                   │
                    │                    │  (BullMQ Worker)    │                   │
                    │                    │  concurrency: 10    │                   │
                    │                    └─────────┬──────────┘                   │
                    │                              │                              │
                    │          ┌────────────────────┼────────────────────┐         │
                    │          │                    │                    │         │
                    │   InboundGuard         ConflictResolver     OutboxWriter    │
                    │   (Echo + Stale)     (Field Authority)    (Fan-Out)         │
                    │          │                    │                    │         │
                    │          ▼                    ▼                    ▼         │
                    │   ┌──────────┐        ┌──────────┐        ┌──────────┐      │
                    │   │ Suppress │        │  Merge   │        │  Outbox  │      │
                    │   │ or Pass  │        │ Booking  │        │  Table   │      │
                    │   └──────────┘        └──────────┘        └────┬─────┘      │
                    │                                                │            │
                    │                                     OutboxRelayService      │
                    │                                     (Poll 500ms · SKIP      │
                    │                                      LOCKED)               │
                    │                                                │            │
                    │                                     ┌──────────▼─────┐      │
                    │                                     │ OutboundQueue  │      │
                    │                                     │ "outbound-sync"│      │
                    │                                     └──────────┬─────┘      │
                    │                                                │            │
                    │                                          Push to Partner    │
                    │                                          (w/ X-Sync-Origin │
                    │                                           echo header)     │
                    └─────────────────────────────────────────────────────────────┘
                                          │                │
                              ┌───────────▼──┐    ┌───────▼────────┐
                              │  PostgreSQL  │    │     Redis      │
                              │  (Prisma)    │    │  (BullMQ,      │
                              │              │    │   Locks,       │
                              │  Bookings    │    │   Circuit      │
                              │  ExternalRef │    │   Breaker,     │
                              │  Outbox      │    │   Rate Limiter)│
                              │  DriftRecord │    │                │
                              │  AuditLog    │    │                │
                              │  RawEvent    │    │                │
                              └──────────────┘    └────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js ≥ 20, TypeScript 5.5 | Type-safe backend |
| **Framework** | NestJS 10 | DI, lifecycle hooks, decorators |
| **Database** | PostgreSQL 16 | Source of truth, exclusion constraints |
| **ORM** | Prisma 7 | Migrations, type-safe queries, `$queryRaw` for `SKIP LOCKED` |
| **Queue** | BullMQ + Redis 7 | Async job processing, retry with exponential backoff |
| **Cache / Coordination** | Redis (ioredis) | Distributed locks, circuit breaker state, rate limiter (Lua) |
| **Observability** | prom-client → Prometheus → Grafana | Counters, histograms, gauges exposed on `/metrics` |
| **Validation** | Zod | Runtime schema validation for canonical models |
| **Crypto** | Node.js `crypto` | AES-256-GCM credential encryption, HMAC-SHA256 webhook verification |
| **Build** | Turborepo + pnpm workspaces | Monorepo orchestration |
| **CI** | GitHub Actions | Automated build, test, and concurrency overlap verification |
| **Load Testing** | k6 | 500 req/sec sustained webhook ingestion benchmarks |

---

## Monorepo Structure

```
lattice/
├── apps/
│   ├── api/                        # NestJS application
│   │   ├── src/
│   │   │   ├── webhooks/           # Ingestion controller + service
│   │   │   ├── workers/            # BullMQ inbound processor
│   │   │   ├── outbox/             # Transactional outbox relay
│   │   │   ├── reconciliation/     # Self-healing sweep service + admin API
│   │   │   ├── metrics/            # Prometheus /metrics endpoint
│   │   │   ├── app.module.ts       # Root DI module
│   │   │   └── main.ts             # Bootstrap with raw body parsing
│   │   └── test/
│   │       ├── inbound-processor.spec.ts
│   │       ├── chaos-reconciliation.spec.ts
│   │       └── concurrency-overlap.spec.ts
│   └── mock-partners/              # Chaos-injectable partner simulator
│       └── src/index.ts            # Configurable drop/duplicate/latency/429 rates
│
├── libs/
│   ├── canonical/                  # Shared domain models
│   │   └── src/
│   │       ├── models.ts           # Zod schemas (CanonicalBooking, FieldAuthorityConfig)
│   │       ├── hasher.ts           # Deterministic JSON canonicalization + SHA-256
│   │       └── crypto.ts           # AES-256-GCM encrypt/decrypt for partner credentials
│   │
│   ├── adapters/                   # Partner integration adapters
│   │   └── src/
│   │       ├── types.ts            # PartnerAdapter interface (verify, toCanonical, fromCanonical, pull)
│   │       ├── cloudbeds.adapter.ts
│   │       ├── guesty.adapter.ts
│   │       └── adapter.registry.ts # Provider → Adapter lookup
│   │
│   └── sync-core/                  # Sync engine primitives
│       └── src/
│           ├── inbound-pipeline.ts # Three-layer echo suppression guard
│           ├── conflict-resolver.ts# Per-field authority merge engine
│           ├── diff-classifier.ts  # Reconciliation drift classifier
│           ├── circuit-breaker.ts  # Redis-backed circuit breaker (CLOSED/OPEN/HALF_OPEN)
│           ├── rate-limiter.ts     # Distributed token bucket (Lua script)
│           ├── distributed-lock.ts # SET NX PX + Lua release (leader election)
│           └── metrics.ts          # Prometheus counters, histograms, gauges
│
├── prisma/
│   └── schema.prisma               # 8 models, optimistic locking, GiST-ready indexes
├── load/
│   └── k6-webhook-load.js          # 500 req/sec sustained load test
├── docker-compose.yml               # Postgres, Redis, Prometheus, Grafana
├── prometheus.yml                    # Scrape config targeting /metrics
└── .github/workflows/ci.yml         # Full CI: build → test → concurrency verification
```

---

## Core Subsystems

### 1. Webhook Ingestion Pipeline

**Goal:** Accept partner webhooks at 500+/sec, return HTTP 200 in < 20ms, guarantee no data loss.

**Flow:**
1. `WebhookController` receives `POST /webhooks/:connectionId`
2. Raw body is preserved for constant-time HMAC-SHA256 verification (timing-safe comparison)
3. `WebhookService` looks up the `Connection` record, resolves the correct `PartnerAdapter`, and verifies the signature
4. The raw event is inserted into the `RawEvent` ledger with a unique constraint on `(connectionId, externalEventId)` — duplicates are caught at the DB level and return `{ status: "deduplicated" }`
5. Valid events are enqueued into BullMQ with a deterministic `jobId` (`connectionId:eventId`) to prevent queue-level duplicate storms
6. HTTP 200 is returned immediately — all heavy processing happens asynchronously

### 2. Three-Layer Echo Suppression

When Lattice pushes an update to a partner, the partner fires it back as a webhook. Without suppression, this creates an infinite loop. The `InboundGuard` evaluates three layers in order:

| Layer | Mechanism | How It Works |
|---|---|---|
| **1. Origin Header** | `X-Sync-Origin: lattice` | If the outbound push included this header and the partner echoes it back, suppress immediately |
| **2. Content Hash** | SHA-256 of canonicalized JSON | Compare incoming canonical hash against `ExternalRef.lastExternalHash`. If identical, the data hasn't meaningfully changed |
| **3. Monotonic Ordering** | Timestamp comparison | If `incomingUpdatedAt ≤ lastExternalUpdatedAt`, discard as stale (out-of-order delivery) |

Only events that pass all three layers proceed to the `InboundProcessor`.

### 3. Field-Level Conflict Resolution

When two systems modify the same booking simultaneously, Lattice doesn't blindly accept either version. The `ConflictResolver` inspects each canonical field individually:

```typescript
// Example field authority config stored per Connection:
{
  "status":      "partner",   // Partner always wins on booking status
  "guestEmail":  "internal",  // Internal DB owns guest contact info
  "totalAmount": "latest",    // Most recent timestamp wins
  "checkIn":     "partner",
  "checkOut":    "partner"
}
```

For each field where `internal ≠ incoming`:
- **`partner`** → Accept the incoming value
- **`internal`** → Keep the DB value, discard incoming
- **`latest`** → Compare `incomingUpdatedAt` vs `currentUpdatedAt`, newer wins

Every field-level decision is recorded in the `AuditLog` table with the exact reason, enabling full traceability.

### 4. Transactional Outbox

After processing an inbound event, Lattice must fan out the change to *all other* connected partners for the same tenant (excluding the origin partner to prevent echo). This uses the **Transactional Outbox pattern**:

1. Inside the same database transaction that updates the `Booking`, outbox rows are created for each sibling `Connection`
2. The `OutboxRelayService` polls every 500ms using `SELECT ... FOR UPDATE SKIP LOCKED` — this ensures competing worker pods never block each other or process the same row twice
3. Rows are marked `PROCESSING` and enqueued into BullMQ's `outbound-sync` queue
4. Dead letters (after 5 failed attempts) are moved to `DEAD` status and tracked via `lattice_outbox_dead_total` metric

### 5. Resilience Primitives

| Primitive | Implementation | Purpose |
|---|---|---|
| **Circuit Breaker** | Redis hash with `state`, `failures`, `openedAt` | Stops outbound calls to a failing partner after 5 consecutive failures. Auto-transitions to HALF_OPEN after 30s cooldown |
| **Rate Limiter** | Distributed token bucket via Redis Lua script | Enforces per-partner API rate limits (e.g., Cloudbeds: 10 rps, burst 20). Atomic refill + consume in a single Lua eval |
| **Distributed Lock** | `SET key token NX PX ttl` + Lua release | Leader election for reconciliation sweeps. Prevents dual-running sweeps on the same connection |

### 6. Self-Healing Reconciliation

Even with reliable webhooks, drift accumulates over time. The `ReconciliationService` catches and fixes it:

1. **Leader Election** — Acquires a distributed lock to prevent parallel sweeps on the same connection
2. **Incremental Pull** — Paginates through the partner's API using cursor-based iteration
3. **Batch Loading** — Fetches all `ExternalRef` mappings and internal `Booking` records in bulk (eliminates N+1 queries)
4. **Drift Classification** — The `DriftClassifier` categorizes each discrepancy:

| Drift Kind | Meaning | Auto-Heal Action |
|---|---|---|
| `MISSING_INTERNAL` | Partner has it, Lattice doesn't (dropped webhook) | Pull via inbound pipeline |
| `MISSING_EXTERNAL` | Lattice has it, partner doesn't (failed outbound push) | Push via outbox |
| `FIELD_MISMATCH` | Both exist but fields differ | Pull, push, or escalate based on field authority |
| `STALE` | Timestamp indicates outdated data | No action |

5. **Blast Radius Limit** — Auto-healing is capped at `maxHealsPerRun` (default: 50) to prevent a misconfigured sweep from mass-mutating production data
6. **Audit Trail** — Every drift detection and heal action is persisted in the `DriftRecord` table

**Admin API:**
- `POST /admin/reconciliation/:connectionId?dryRun=true` — Preview drift without healing
- `POST /admin/reconciliation/:connectionId` — Execute healing sweep
- `GET /admin/reconciliation/drift?connectionId=...&healed=false` — Query unresolved drift records

### 7. Partner Adapters

Each partner integration implements the `PartnerAdapter` interface:

```typescript
interface PartnerAdapter<TExternal> {
  provider: string;
  capabilities: AdapterCapabilities;

  verifyWebhook(headers, rawBody, secret): boolean;
  extractEventId(payload, headers): string;
  extractTimestamp(payload, headers): Date;
  toCanonical(external: TExternal): CanonicalEnvelope<CanonicalBooking>;
  fromCanonical(entity: CanonicalBooking, ctx: PushContext): TExternal;
  listChangedSince(cursor, credentials): Promise<{ items; nextCursor }>;
}
```

Currently implemented: **Cloudbeds** and **Guesty** (mock variants). Adding a new PMS partner requires implementing this interface and registering it in the `AdapterRegistry`.

### 8. Mock Partner Harness

The `@lattice/mock-partners` app simulates partner APIs with **configurable chaos injection**:

```bash
# Dynamically configure failure modes during integration tests:
curl -X POST http://localhost:4001/chaos/configure \
  -H "Content-Type: application/json" \
  -d '{"dropRate": 0.1, "duplicateRate": 0.05, "latencyMs": 200, "rateLimit429Rate": 0.02}'
```

- **Drop Rate** — Simulates gateway timeouts (504)
- **Duplicate Rate** — Fires the same webhook twice (50ms apart)
- **Latency** — Artificial delay on responses
- **Rate Limit 429** — Returns `429 Too Many Requests` with `Retry-After` header

### 9. Observability

Lattice exposes a dedicated Prometheus metrics endpoint at `GET /metrics`:

| Metric | Type | What It Measures |
|---|---|---|
| `lattice_webhooks_received_total` | Counter | Inbound webhook volume by provider |
| `lattice_webhook_duplicates_total` | Counter | Deduplicated webhooks at ingestion |
| `lattice_webhook_ingest_duration_seconds` | Histogram | Ingestion latency (buckets emphasize sub-20ms) |
| `lattice_echo_suppressed_total` | Counter | Echo updates suppressed by layer |
| `lattice_outbox_pending_count` | Gauge | Pending outbox rows awaiting dispatch |
| `lattice_outbox_dead_total` | Counter | Jobs moved to DLQ |
| `lattice_overlap_violations_total` | Counter | Booking overlaps caught by DB constraint |
| `lattice_drift_detected_total` | Counter | Drift instances found during reconciliation |
| `lattice_drift_healed_total` | Counter | Successfully auto-healed drift |
| `lattice_integration_health_status` | Gauge | Per-connection health (1=healthy, 0=unhealthy) |
| `lattice_integration_latency_seconds` | Histogram | P95 latency of remote API calls |

Docker Compose includes pre-configured **Prometheus** (scraping every 5s) and **Grafana** (accessible at `localhost:3001`).

---

## Database Schema

8 models designed for high-throughput concurrent access:

| Model | Purpose |
|---|---|
| `Connection` | Tenant ↔ partner link with encrypted credentials, field authority config, webhook secret |
| `Property` | Multi-tenant property record |
| `Booking` | Canonical booking with optimistic concurrency lock (`version`), content hash, and `lastWriteOrigin` |
| `Transaction` | Financial records (charges, refunds, payouts) |
| `ExternalRef` | Bidirectional mapping between internal entity IDs and partner-specific external IDs. Stores `lastExternalHash` for echo suppression |
| `RawEvent` | Immutable ingestion ledger — every webhook received is logged for replay and debugging |
| `Outbox` | Transactional outbox with `PENDING → PROCESSING → SENT/DEAD` lifecycle and exponential retry |
| `DriftRecord` | Audit trail of every drift detection and healing action |
| `AuditLog` | Field-level decision log for conflict resolution |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Docker & Docker Compose

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/mo74x/lattice.git
cd lattice

# 2. Start infrastructure
docker compose up -d

# 3. Install dependencies
pnpm install

# 4. Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, REDIS_HOST, REDIS_PASSWORD, ENCRYPTION_KEY

# 5. Run database migrations
pnpm run db:migrate

# 6. Generate Prisma client
pnpm run db:generate

# 7. Start the API
pnpm run dev
```

The API will be available at `http://localhost:3000`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres@localhost:5432/lattice_db` |
| `REDIS_HOST` | Redis hostname | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password | *(empty)* |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM credential encryption | *(required)* |
| `PORT` | API listen port | `3000` |

---

## Testing

### Unit & Integration Tests

```bash
# Run all tests
pnpm run test

# Run specific test suites
npx jest apps/api/test/inbound-processor.spec.ts
npx jest apps/api/test/chaos-reconciliation.spec.ts
npx jest apps/api/test/concurrency-overlap.spec.ts
```

**Test suites include:**
- **Inbound Processor** — Echo suppression across all three layers, staleness rejection, valid mutation passthrough
- **Chaos Reconciliation** — Drift classification, dry-run vs. active healing, blast radius enforcement
- **Concurrency Overlap** — 200-way parallel booking insertion verifying exclusion constraint enforcement

### Load Testing

```bash
# Requires k6 installed (https://k6.io)
k6 run load/k6-webhook-load.js
```

**Configuration:**
- **Rate:** 500 webhooks/sec (constant arrival rate)
- **Duration:** 1 minute
- **VUs:** up to 200
- **Thresholds:**
  - `http_req_duration p(95) < 20ms`
  - `http_req_failed rate < 0.1%`

---

## CI Pipeline

GitHub Actions runs on every push and PR to `main`:

1. **Infrastructure** — Spins up PostgreSQL 16 and Redis 7 as service containers
2. **Install** — `pnpm install --frozen-lockfile`
3. **Migrate** — `prisma migrate dev`
4. **Type Check** — `pnpm run build` (TypeScript compilation across all workspace packages)
5. **Unit Tests** — `pnpm run test`
6. **Concurrency Test** — Dedicated 200-way parallel overlap verification

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/:connectionId` | Inbound webhook ingestion (partner → Lattice) |
| `GET` | `/metrics` | Prometheus metrics scrape endpoint |
| `POST` | `/admin/reconciliation/:connectionId` | Trigger reconciliation sweep |
| `GET` | `/admin/reconciliation/drift` | Query drift records |

---

## License

This project is unlicensed and intended as a portfolio demonstration of distributed systems engineering.
