import { DlqService } from '../src/dlq/dlq.service';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';

describe('Dead-Letter Queue (DLQ) & Replay Engine', () => {
  let dlqService: DlqService;
  let mockPrisma: any;
  let mockInboundQueue: any;
  let mockOutboundQueue: any;

  beforeEach(() => {
    mockPrisma = {
      rawEvent: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      outbox: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    mockInboundQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ failed: 2, waiting: 0, active: 1 }),
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    mockOutboundQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ failed: 1, waiting: 0, active: 0 }),
      add: jest.fn().mockResolvedValue({ id: 'job-2' }),
    };

    dlqService = new DlqService(
      mockPrisma as unknown as PrismaClient,
      mockInboundQueue as unknown as Queue,
      mockOutboundQueue as unknown as Queue
    );
  });

  describe('getDlqSummary', () => {
    it('aggregates inbound failed events and outbound dead rows', async () => {
      mockPrisma.rawEvent.count.mockResolvedValue(5);
      mockPrisma.outbox.count.mockResolvedValue(3);

      const summary = await dlqService.getDlqSummary('conn-1');

      expect(summary.inboundFailedEvents).toBe(5);
      expect(summary.outboundDeadItems).toBe(3);
      expect(summary.queues.inbound.failed).toBe(2);
      expect(summary.queues.outbound.failed).toBe(1);
    });
  });

  describe('replayInboundEvent', () => {
    it('resets raw event error status and re-enqueues job into inbound BullMQ queue', async () => {
      const mockEvent = {
        id: 'raw-123',
        connectionId: 'conn-1',
        externalEventId: 'evt-456',
        payload: { reservation_id: 'res_1' },
        receivedAt: new Date('2026-10-13T10:00:00Z'),
        connection: {
          tenantId: 'tenant-1',
          provider: 'cloudbeds_mock',
        },
      };

      mockPrisma.rawEvent.findFirst.mockResolvedValue(mockEvent);
      mockPrisma.rawEvent.update.mockResolvedValue({ ...mockEvent, error: null, processedAt: null });

      const result = await dlqService.replayInboundEvent('evt-456');

      expect(result.status).toBe('replayed');
      expect(mockPrisma.rawEvent.update).toHaveBeenCalledWith({
        where: { id: 'raw-123' },
        data: { error: null, processedAt: null },
      });
      expect(mockInboundQueue.add).toHaveBeenCalledWith(
        'process_event',
        expect.objectContaining({
          connectionId: 'conn-1',
          tenantId: 'tenant-1',
          provider: 'cloudbeds_mock',
          externalEventId: 'evt-456',
        }),
        expect.objectContaining({
          attempts: 3,
        })
      );
    });
  });

  describe('replayOutboxItem', () => {
    it('resets dead outbox row to PENDING with 0 attempts for immediate retry', async () => {
      const mockOutbox = {
        id: 'outbox-789',
        connectionId: 'conn-1',
        status: 'DEAD',
        attempts: 5,
        lastError: 'HTTP_500: Server error',
      };

      mockPrisma.outbox.findUnique.mockResolvedValue(mockOutbox);
      mockPrisma.outbox.update.mockResolvedValue({
        ...mockOutbox,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
      });

      const result = await dlqService.replayOutboxItem('outbox-789');

      expect(result.status).toBe('replayed');
      expect(mockPrisma.outbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-789' },
        data: expect.objectContaining({
          status: 'PENDING',
          attempts: 0,
          lastError: null,
        }),
      });
    });
  });

  describe('bulkReplayInbound', () => {
    it('resets and re-enqueues all matching failed events', async () => {
      const mockEvents = [
        {
          id: 'raw-1',
          connectionId: 'conn-1',
          externalEventId: 'evt-1',
          payload: {},
          receivedAt: new Date(),
          connection: { tenantId: 't-1', provider: 'cloudbeds_mock' },
        },
        {
          id: 'raw-2',
          connectionId: 'conn-1',
          externalEventId: 'evt-2',
          payload: {},
          receivedAt: new Date(),
          connection: { tenantId: 't-1', provider: 'cloudbeds_mock' },
        },
      ];

      mockPrisma.rawEvent.findMany.mockResolvedValue(mockEvents);
      mockPrisma.rawEvent.update.mockResolvedValue({});

      const result = await dlqService.bulkReplayInbound({ connectionId: 'conn-1' });

      expect(result.status).toBe('bulk_replayed');
      expect(result.count).toBe(2);
      expect(mockInboundQueue.add).toHaveBeenCalledTimes(2);
    });
  });
});
