import express, { Request, Response } from 'express';
import * as crypto from 'crypto';

const app = express();
app.use(express.json());

interface ChaosConfig {
  dropRate: number;      // 0.0 - 1.0 (Drop requests to simulate loss)
  duplicateRate: number; // 0.0 - 1.0 (Send duplicate payloads)
  latencyMs: number;     // Injected artificial delay
  rateLimit429Rate: number;
}

const chaos: ChaosConfig = {
  dropRate: 0,
  duplicateRate: 0,
  latencyMs: 0,
  rateLimit429Rate: 0,
};

// Admin route to toggle chaos scenarios on the fly during integration tests
app.post('/chaos/configure', (req: Request, res: Response) => {
  Object.assign(chaos, req.body);
  res.json({ message: 'Chaos configuration updated', activeConfig: chaos });
});

// Partner A Mock Inbound Endpoint (Pushing from Lattice -> Partner A)
app.post('/cloudbeds/reservations', async (req: Request, res: Response) => {
  if (Math.random() < chaos.dropRate) {
    return res.status(504).json({ error: 'Gateway Timeout (Chaos Injected)' });
  }
  if (Math.random() < chaos.rateLimit429Rate) {
    res.setHeader('Retry-After', '2');
    return res.status(429).json({ error: 'Too Many Requests' });
  }
  if (chaos.latencyMs > 0) {
    await new Promise((r) => setTimeout(r, chaos.latencyMs));
  }

  const originHeader = req.headers['x-sync-origin'];
  res.status(200).json({
    externalId: req.body.reservation_id || `cb_${Date.now()}`,
    echoDetected: originHeader === 'lattice',
    status: 'persisted',
    modified_at: new Date().toISOString(),
  });
});

// Outbound Webhook Emitter: Simulates Partner firing a webhook into Lattice
app.post('/simulate/webhook', async (req: Request, res: Response) => {
  const { targetUrl, provider, secret, payload, eventId } = req.body;
  const rawPayload = JSON.stringify(payload);

  if (provider === 'cloudbeds_mock') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawPayload}`).digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'x-cloudbeds-signature': sig,
      'x-cloudbeds-timestamp': timestamp,
      'x-event-id': eventId || `evt_${crypto.randomUUID()}`,
    };

    const emit = () => fetch(targetUrl, { method: 'POST', headers, body: rawPayload });
    await emit();

    // Chaos duplication check
    if (Math.random() < chaos.duplicateRate) {
      setTimeout(emit, 50); // Duplicate fired 50ms later
    }
  }

  res.json({ success: true, simulatedProvider: provider });
});

const PORT = process.env.MOCK_PORT || 4001;
app.listen(PORT, () => console.log(`⚡ Mock Partners running on port ${PORT}`));