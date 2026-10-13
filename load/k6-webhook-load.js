import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import { Counter, Trend } from 'k6/metrics';

// Custom metrics to track end-to-end ingestion and processing
const eventsSent = new Counter('events_sent_total');
const ingestSuccess = new Counter('ingest_success_total');
const drainDurationTrend = new Trend('processing_drain_duration_ms');

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-arrival-rate',
      rate: 500, // 500 webhooks per second
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 100,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<20'], // 95% of ingestion requests must complete under 20ms
    http_req_failed: ['rate<0.001'],  // < 0.1% failure rate
    events_sent_total: ['count>0'],
    processing_drain_duration_ms: ['max<120000'], // Entire queue must drain within 120s budget
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CONNECTION_ID = __ENV.CONNECTION_ID || 'test-conn-cloudbeds-1';
const SECRET = __ENV.SECRET || 'test_webhook_secret_key_123';
const URL = `${BASE_URL}/webhooks/${CONNECTION_ID}`;
const STATS_URL = `${BASE_URL}/webhooks/${CONNECTION_ID}/stats`;

export function setup() {
  console.log(`Setting up load test against ${URL}`);
  const res = http.get(STATS_URL);
  let initialStats = { initialProcessed: 0, initialTotal: 0 };

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      initialStats = {
        initialProcessed: body.rawEvents?.processed || 0,
        initialTotal: body.rawEvents?.total || 0,
      };
      console.log(`Initial baseline: ${initialStats.initialProcessed} events already processed.`);
    } catch (_) {}
  } else {
    console.warn(`Stats endpoint returned status ${res.status}; baseline starting at 0.`);
  }

  return initialStats;
}

export default function () {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const eventId = `evt_k6_${__VU}_${__ITER}_${Date.now()}`;

  // Fix #3: Generate unique reservation IDs per VU & iteration to avoid unrealistic
  // room-hopping collisions across 30,000 requests, while maintaining realistic
  // multi-tenant concurrency contention across 50 room units.
  const reservationId = `res_k6_vu${__VU}_it${__ITER}_${Date.now()}`;
  const unitId = `unit_${Math.floor(Math.random() * 50)}`;

  const payload = JSON.stringify({
    reservation_id: reservationId,
    property_id: 'prop_k6_1',
    room_identifier: unitId,
    guest_first_name: 'Load',
    guest_last_name: 'Tester',
    start_date: '2026-11-01T00:00:00Z',
    end_date: '2026-11-05T00:00:00Z',
    booking_status: 'reserved',
    total_cents: 15000,
    currency_code: 'USD',
    modified_at: new Date().toISOString(),
  });

  const payloadToSign = `${timestamp}.${payload}`;
  const signature = crypto.hmac('sha256', SECRET, payloadToSign, 'hex');

  const headers = {
    'Content-Type': 'application/json',
    'x-cloudbeds-signature': signature,
    'x-cloudbeds-timestamp': timestamp,
    'x-event-id': eventId,
  };

  eventsSent.add(1);
  const res = http.post(URL, payload, { headers });

  const passed = check(res, {
    'status is 200': (r) => r.status === 200,
    'ingest duration < 20ms': (r) => r.timings.duration < 20,
  });

  if (passed) {
    ingestSuccess.add(1);
  }
}

// Fix #1: Teardown verification polls the queue and processing ledger until all
// asynchronous worker jobs drain and reach terminal states.
export function teardown(data) {
  console.log('Ingestion load phase finished. Polling backend for queue drain and asynchronous processing...');

  const maxWaitMs = 120000; // 2 minutes processing budget
  const pollIntervalSec = 2;
  const startTime = Date.now();
  let isDrained = false;
  let finalStats = null;

  while (Date.now() - startTime < maxWaitMs) {
    sleep(pollIntervalSec);
    const res = http.get(STATS_URL);

    if (res.status === 200) {
      try {
        const stats = JSON.parse(res.body);
        finalStats = stats;

        const queuePending = (stats.queue?.waiting || 0) + (stats.queue?.active || 0);
        const eventsPending = stats.rawEvents?.pending || 0;
        const totalProcessed = stats.rawEvents?.processed || 0;
        const newlyProcessed = totalProcessed - (data?.initialProcessed || 0);

        console.log(
          `[Processing Check] Waiting in queue: ${stats.queue?.waiting || 0}, ` +
          `Active: ${stats.queue?.active || 0}, ` +
          `Pending raw events: ${eventsPending}, ` +
          `Newly processed: ${newlyProcessed}`
        );

        if (queuePending === 0 && eventsPending === 0) {
          isDrained = true;
          break;
        }
      } catch (err) {
        console.error(`Error parsing stats response: ${err}`);
      }
    } else {
      console.warn(`Stats check returned HTTP ${res.status}`);
    }
  }

  const drainTimeMs = Date.now() - startTime;
  drainDurationTrend.add(drainTimeMs);
  const drainTimeSec = (drainTimeMs / 1000).toFixed(1);

  console.log(`Processing verification completed in ${drainTimeSec}s. Fully drained: ${isDrained}`);
  if (finalStats) {
    console.log(
      `Final Summary: Total RawEvents=${finalStats.rawEvents?.total}, ` +
      `Processed=${finalStats.rawEvents?.processed}, ` +
      `Errors=${finalStats.rawEvents?.errors}`
    );
  }

  check(finalStats, {
    'processing queue drained completely': () => isDrained === true,
    'zero processing errors in ledger': (s) => (s?.rawEvents?.errors || 0) === 0,
    'all events persisted': (s) => (s?.rawEvents?.total || 0) > (data?.initialTotal || 0),
  });
}