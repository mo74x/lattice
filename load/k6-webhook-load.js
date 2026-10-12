import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';

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
  },
};

const CONNECTION_ID = 'test-conn-cloudbeds-1';
const SECRET = 'test_webhook_secret_key_123';
const URL = `http://localhost:3000/webhooks/${CONNECTION_ID}`;

export default function () {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const eventId = `evt_k6_${__VU}_${__ITER}_${Date.now()}`;

  const payload = JSON.stringify({
    reservation_id: `res_k6_${Math.floor(Math.random() * 10000)}`,
    property_id: 'prop_k6_1',
    room_identifier: `unit_${Math.floor(Math.random() * 50)}`, // Creates realistic concurrency contention across 50 units
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

  const res = http.post(URL, payload, { headers });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'ingest duration < 20ms': (r) => r.timings.duration < 20,
  });
}