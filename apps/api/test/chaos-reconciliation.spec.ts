import { Test } from '@nestjs/testing';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service';
import { PrismaClient } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

describe('Chaos & Self-Healing Convergence Test', () => {
  let reconciliationService: ReconciliationService;
  let prisma: PrismaClient;

  const mockAdapter = {
    provider: 'cloudbeds_mock',
    listChangedSince: jest.fn(),
    toCanonical: jest.fn(),
  };

  const mockInboundQueue = { add: jest.fn() };
  const mockOutboundQueue = { add: jest.fn() };

  beforeAll(async () => {
    prisma = new PrismaClient();
    const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', lazyConnect: true });

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(mockAdapter as any);

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: PrismaClient, useValue: prisma },
        { provide: AdapterRegistry, useValue: adapterRegistry },
        { provide: Redis, useValue: redis },
        { provide: 'BullQueue_inbound-webhooks', useValue: mockInboundQueue },
        { provide: 'BullQueue_outbound-sync', useValue: mockOutboundQueue },
      ],
    }).compile();

    reconciliationService = module.get<ReconciliationService>(ReconciliationService);
  });

  it('detects dropped webhooks (MISSING_INTERNAL) and heals through inbound queue', async () => {
    const connectionId = `conn-chaos-${Date.now()}`;
    const externalId = `ext-res-dropped-99`;

    // Seed connection with partner authority
    await prisma.connection.create({
      data: {
        id: connectionId,
        tenantId: 'tenant-chaos',
        provider: 'cloudbeds_mock',
        status: 'ACTIVE',
        credentialsEnc: 'mock_enc',
        webhookSecret: 'mock_sec',
        fieldAuthority: { status: 'partner' },
      },
    });

    // Partner returns a reservation that NEVER arrived via webhook (dropped)
    mockAdapter.listChangedSince.mockResolvedValueOnce({
      items: [{ reservation_id: externalId }],
      nextCursor: 'cursor_page_2',
    });

    mockAdapter.toCanonical.mockReturnValueOnce({
      entityType: 'booking',
      externalId,
      externalUpdatedAt: new Date('2026-10-12T12:00:00Z'),
      rawHash: 'hash_canonical_99',
      data: {
        tenantId: 'tenant-chaos',
        propertyId: 'prop-1',
        unitId: 'apt-501',
        guestName: 'Dropped Guest',
        checkIn: '2026-11-20',
        checkOut: '2026-11-25',
        status: 'CONFIRMED',
        totalAmount: 1800,
        currency: 'USD',
      },
    });

    // Trigger reconciliation sweep
    const result = await reconciliationService.run({ connectionId, dryRun: false });

    // Assertions: Drift detected, classified as MISSING_INTERNAL, and enqueued
    expect(result.inspectedCount).toBe(1);
    expect(result.driftCount).toBe(1);
    expect(result.healedCount).toBe(1);

    // Verify DB drift record exists
    const driftLog = await prisma.driftRecord.findFirst({
      where: { connectionId },
    });
    expect(driftLog).toBeDefined();
    expect(driftLog?.kind).toBe('MISSING_INTERNAL');
    expect(driftLog?.action).toBe('PULLED');

    // Verify self-healer routed through inbound queue
    expect(mockInboundQueue.add).toHaveBeenCalledTimes(1);
    expect(mockInboundQueue.add).toHaveBeenCalledWith(
      'process_event',
      expect.objectContaining({
        connectionId,
        externalEventId: expect.stringContaining(`reconcile_${externalId}`),
      }),
      expect.any(Object)
    );
  });
});