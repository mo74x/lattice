import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();

// Webhook Ingestion Metrics
export const webhooksReceivedTotal = new Counter({
  name: 'lattice_webhooks_received_total',
  help: 'Total count of inbound webhooks received',
  labelNames: ['provider', 'valid'],
  registers: [register],
});

export const webhookDuplicatesTotal = new Counter({
  name: 'lattice_webhook_duplicates_total',
  help: 'Total duplicate webhooks deduplicated at gateway layer',
  labelNames: ['provider'],
  registers: [register],
});

export const webhookIngestDuration = new Histogram({
  name: 'lattice_webhook_ingest_duration_seconds',
  help: 'Latency of webhook ingestion endpoint before returning HTTP 200',
  labelNames: ['provider'],
  buckets: [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5], // Sub-20ms emphasis
  registers: [register],
});

// Sync Core & Loop Metrics
export const echoSuppressedTotal = new Counter({
  name: 'lattice_echo_suppressed_total',
  help: 'Count of echo updates suppressed',
  labelNames: ['provider', 'layer'], // layer: origin_header | content_hash
  registers: [register],
});

export const outboxPendingGauge = new Gauge({
  name: 'lattice_outbox_pending_count',
  help: 'Number of pending outbox rows waiting to be dispatched',
  registers: [register],
});

export const outboxDeadTotal = new Counter({
  name: 'lattice_outbox_dead_total',
  help: 'Number of outbox jobs moved to Dead Letter Queue (DLQ)',
  labelNames: ['provider'],
  registers: [register],
});

// Concurrency & Self-Healing Metrics
export const overlapViolationsTotal = new Counter({
  name: 'lattice_overlap_violations_total',
  help: 'Count of booking overlap violations caught by Postgres GiST constraint',
  registers: [register],
});

export const driftDetectedTotal = new Counter({
  name: 'lattice_drift_detected_total',
  help: 'Total drift instances detected during reconciliation sweeps',
  labelNames: ['provider', 'kind'],
  registers: [register],
});

export const driftHealedTotal = new Counter({
  name: 'lattice_drift_healed_total',
  help: 'Total drift instances successfully auto-healed',
  labelNames: ['provider', 'action'],
  registers: [register],
});

// Integration Health Metrics
export const integrationHealthStatus = new Gauge({
  name: 'lattice_integration_health_status',
  help: 'Current health status of integration (1=healthy, 0=unhealthy)',
  labelNames: ['provider', 'connectionId'],
  registers: [register],
});

export const integrationLastSeen = new Gauge({
  name: 'lattice_integration_last_seen_seconds',
  help: 'Unix timestamp of last successful interaction with integration',
  labelNames: ['provider', 'connectionId'],
  registers: [register],
});

export const latencyP95 = new Histogram({
  name: 'lattice_integration_latency_seconds',
  help: 'P95 latency of remote API calls (push/pull)',
  labelNames: ['provider', 'operation'], // operation: push | pull
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});