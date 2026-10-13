import { Test } from '@nestjs/testing';
import { WebhookService } from './webhook.service';
import { PrismaClient } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { Queue } from 'bullmq';
import { UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import * as crypto from 'crypto';

describe('Webhook Ingestion Engine', () => {
  let service: WebhookService;
  let prisma: PrismaClient;

  const mockPrisma = {
    connection: { findUnique: jest.fn() },
    rawEvent: { create: jest.fn() },
  };

  const mockQueue = { add: jest.fn() };
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);

    const module = await Test.createTestingModule({
      providers: [
        WebhookService,
        AdapterRegistry,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: 'BullQueue_inbound-webhooks', useValue: mockQueue },
        { provide: Redis, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
    prisma = module.get<PrismaClient>(PrismaClient);
  });

  it('rejects tampered webhook payloads with UnauthorizedException', async () => {
    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'conn-123',
      provider: 'cloudbeds_mock',
      webhookSecret: 'secret_key',
      status: 'ACTIVE',
    });

    const body = Buffer.from(JSON.stringify({ test: 'tampered' }));
    const headers = {
      'x-cloudbeds-signature': 'invalid_signature_hash',
      'x-cloudbeds-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-event-id': 'evt_1',
    };

    await expect(
      service.handleIncomingWebhook('conn-123', headers, body, { test: 'tampered' })
    ).rejects.toThrow(UnauthorizedException);
  });

  it('safely drops duplicate external events via DB unique constraint', async () => {
    const secret = 'secret_key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawPayload = JSON.stringify({ reservation_id: 'res_1' });
    const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawPayload}`).digest('hex');

    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'conn-123',
      provider: 'cloudbeds_mock',
      webhookSecret: secret,
      status: 'ACTIVE',
    });

    // Simulate unique constraint collision (P2002)
    mockPrisma.rawEvent.create.mockRejectedValue({ code: 'P2002' });

    const result = await service.handleIncomingWebhook(
      'conn-123',
      {
        'x-cloudbeds-signature': sig,
        'x-cloudbeds-timestamp': timestamp,
        'x-event-id': 'evt_duplicate',
      },
      Buffer.from(rawPayload),
      { reservation_id: 'res_1' }
    );

    expect(result.status).toBe('deduplicated');
    expect(mockQueue.add).not.toHaveBeenCalled(); // Ensures worker is not spammed
  });

  it('accepts webhooks signed with previous secret during active grace period', async () => {
    const previousSecret = 'old_secret_in_grace_period';
    const activeSecret = 'new_rotated_secret_primary';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawPayload = JSON.stringify({ reservation_id: 'res_grace' });
    const sigWithPrevious = crypto
      .createHmac('sha256', previousSecret)
      .update(`${timestamp}.${rawPayload}`)
      .digest('hex');

    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'conn-123',
      provider: 'cloudbeds_mock',
      webhookSecret: activeSecret,
      status: 'ACTIVE',
      tenantId: 'tenant-1',
    });
    mockPrisma.rawEvent.create.mockResolvedValue({});

    // Redis has the previous secret active in grace period
    mockRedis.get.mockResolvedValue(previousSecret);

    const result = await service.handleIncomingWebhook(
      'conn-123',
      {
        'x-cloudbeds-signature': sigWithPrevious,
        'x-cloudbeds-timestamp': timestamp,
        'x-event-id': 'evt_grace_1',
      },
      Buffer.from(rawPayload),
      { reservation_id: 'res_grace' }
    );

    expect(result.status).toBe('enqueued');
    expect(mockRedis.get).toHaveBeenCalledWith('lattice:connection:conn-123:prev_secret');
    expect(mockQueue.add).toHaveBeenCalled();
  });

  it('rejects webhooks signed with previous secret once grace period has expired', async () => {
    const previousSecret = 'expired_old_secret';
    const activeSecret = 'new_rotated_secret_primary';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawPayload = JSON.stringify({ reservation_id: 'res_expired' });
    const sigWithPrevious = crypto
      .createHmac('sha256', previousSecret)
      .update(`${timestamp}.${rawPayload}`)
      .digest('hex');

    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'conn-123',
      provider: 'cloudbeds_mock',
      webhookSecret: activeSecret,
      status: 'ACTIVE',
      tenantId: 'tenant-1',
    });

    // Redis key expired (returns null)
    mockRedis.get.mockResolvedValue(null);

    await expect(
      service.handleIncomingWebhook(
        'conn-123',
        {
          'x-cloudbeds-signature': sigWithPrevious,
          'x-cloudbeds-timestamp': timestamp,
          'x-event-id': 'evt_expired_1',
        },
        Buffer.from(rawPayload),
        { reservation_id: 'res_expired' }
      )
    ).rejects.toThrow(UnauthorizedException);
  });
});