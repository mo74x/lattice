import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface DlqFilterOptions {
  type?: 'all' | 'inbound' | 'outbound';
  connectionId?: string;
  limit?: number;
  offset?: number;
}

export interface BulkReplayInboundOptions {
  connectionId?: string;
  from?: string;
  to?: string;
  onlyErrors?: boolean;
  limit?: number;
}

export interface BulkReplayOutboundOptions {
  connectionId?: string;
  limit?: number;
}

@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(
    private readonly prisma: PrismaClient,
    @InjectQueue('inbound-webhooks') private readonly inboundQueue: Queue,
    @InjectQueue('outbound-sync') private readonly outboundQueue: Queue
  ) {}

  async getDlqSummary(connectionId?: string) {
    const inboundWhere: any = {
      error: { not: null },
      NOT: { error: { startsWith: 'Skipped:' } },
    };
    const outboundWhere: any = { status: 'DEAD' };

    if (connectionId) {
      inboundWhere.connectionId = connectionId;
      outboundWhere.connectionId = connectionId;
    }

    const [inboundFailedCount, outboundDeadCount, inboundJobCounts, outboundJobCounts] =
      await Promise.all([
        this.prisma.rawEvent.count({ where: inboundWhere }),
        this.prisma.outbox.count({ where: outboundWhere }),
        this.inboundQueue.getJobCounts('failed', 'waiting', 'active'),
        this.outboundQueue.getJobCounts('failed', 'waiting', 'active'),
      ]);

    return {
      connectionId: connectionId || 'all',
      inboundFailedEvents: inboundFailedCount,
      outboundDeadItems: outboundDeadCount,
      queues: {
        inbound: inboundJobCounts,
        outbound: outboundJobCounts,
      },
    };
  }

  async getDlqItems(options: DlqFilterOptions) {
    const limit = Math.min(options.limit || 50, 100);
    const offset = options.offset || 0;
    const type = options.type || 'all';

    let inbound: any[] = [];
    let outbound: any[] = [];
    let totalInbound = 0;
    let totalOutbound = 0;

    if (type === 'all' || type === 'inbound') {
      const where: any = {
        error: { not: null },
        NOT: { error: { startsWith: 'Skipped:' } },
      };
      if (options.connectionId) where.connectionId = options.connectionId;

      [inbound, totalInbound] = await Promise.all([
        this.prisma.rawEvent.findMany({
          where,
          orderBy: { receivedAt: 'desc' },
          skip: offset,
          take: limit,
          select: {
            id: true,
            connectionId: true,
            externalEventId: true,
            signatureValid: true,
            receivedAt: true,
            processedAt: true,
            error: true,
            payload: true,
          },
        }),
        this.prisma.rawEvent.count({ where }),
      ]);
    }

    if (type === 'all' || type === 'outbound') {
      const where: any = { status: 'DEAD' };
      if (options.connectionId) where.connectionId = options.connectionId;

      [outbound, totalOutbound] = await Promise.all([
        this.prisma.outbox.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: offset,
          take: limit,
          select: {
            id: true,
            connectionId: true,
            aggregateType: true,
            aggregateId: true,
            operation: true,
            status: true,
            attempts: true,
            maxAttempts: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
            payload: true,
          },
        }),
        this.prisma.outbox.count({ where }),
      ]);
    }

    return {
      limit,
      offset,
      totals: {
        inbound: totalInbound,
        outbound: totalOutbound,
      },
      items: {
        inbound,
        outbound,
      },
    };
  }

  async replayInboundEvent(idOrExternalEventId: string) {
    const rawEvent = await this.prisma.rawEvent.findFirst({
      where: {
        OR: [{ id: idOrExternalEventId }, { externalEventId: idOrExternalEventId }],
      },
      include: { connection: true },
    });

    if (!rawEvent) {
      throw new NotFoundException(`Inbound event not found: ${idOrExternalEventId}`);
    }

    await this.prisma.rawEvent.update({
      where: { id: rawEvent.id },
      data: { error: null, processedAt: null },
    });

    const replayJobId = `${rawEvent.connectionId}:${rawEvent.externalEventId}:replay-${Date.now()}`;
    await this.inboundQueue.add(
      'process_event',
      {
        connectionId: rawEvent.connectionId,
        tenantId: rawEvent.connection.tenantId,
        provider: rawEvent.connection.provider,
        externalEventId: rawEvent.externalEventId,
        eventTimestamp: rawEvent.receivedAt.toISOString(),
        payload: rawEvent.payload,
      },
      {
        jobId: replayJobId,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );

    this.logger.log(`Replayed inbound event ${rawEvent.externalEventId} (rawEvent: ${rawEvent.id})`);

    return {
      status: 'replayed',
      id: rawEvent.id,
      externalEventId: rawEvent.externalEventId,
      connectionId: rawEvent.connectionId,
      replayJobId,
    };
  }

  async bulkReplayInbound(options: BulkReplayInboundOptions) {
    const where: any = {};
    if (options.connectionId) where.connectionId = options.connectionId;

    if (options.from || options.to) {
      where.receivedAt = {};
      if (options.from) where.receivedAt.gte = new Date(options.from);
      if (options.to) where.receivedAt.lte = new Date(options.to);
    }

    if (options.onlyErrors !== false) {
      where.error = { not: null };
      where.NOT = { error: { startsWith: 'Skipped:' } };
    }

    const limit = Math.min(options.limit || 100, 500);
    const events = await this.prisma.rawEvent.findMany({
      where,
      include: { connection: true },
      take: limit,
      orderBy: { receivedAt: 'asc' },
    });

    if (events.length === 0) {
      return { status: 'bulk_replayed', count: 0, message: 'No events matched criteria' };
    }

    for (const event of events) {
      await this.prisma.rawEvent.update({
        where: { id: event.id },
        data: { error: null, processedAt: null },
      });

      const replayJobId = `${event.connectionId}:${event.externalEventId}:bulk-${Date.now()}`;
      await this.inboundQueue.add(
        'process_event',
        {
          connectionId: event.connectionId,
          tenantId: event.connection.tenantId,
          provider: event.connection.provider,
          externalEventId: event.externalEventId,
          eventTimestamp: event.receivedAt.toISOString(),
          payload: event.payload,
        },
        {
          jobId: replayJobId,
          removeOnComplete: 1000,
          removeOnFail: 5000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }
      );
    }

    this.logger.log(`Bulk replayed ${events.length} inbound events`);
    return {
      status: 'bulk_replayed',
      count: events.length,
      replayedEventIds: events.map((e) => e.externalEventId),
    };
  }

  async replayOutboxItem(id: string) {
    const outbox = await this.prisma.outbox.findUnique({
      where: { id },
    });

    if (!outbox) {
      throw new NotFoundException(`Outbox item not found: ${id}`);
    }

    await this.prisma.outbox.update({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });

    this.logger.log(`Replayed outbox item ${id} (reset to PENDING)`);

    return {
      status: 'replayed',
      id: outbox.id,
      connectionId: outbox.connectionId,
      previousStatus: outbox.status,
    };
  }

  async bulkReplayOutbound(options: BulkReplayOutboundOptions) {
    const where: any = { status: 'DEAD' };
    if (options.connectionId) where.connectionId = options.connectionId;

    const limit = Math.min(options.limit || 100, 500);
    const deadItems = await this.prisma.outbox.findMany({
      where,
      take: limit,
      select: { id: true },
    });

    const ids = deadItems.map((d) => d.id);
    if (ids.length === 0) {
      return { status: 'bulk_replayed', count: 0, message: 'No DEAD outbox rows found' };
    }

    await this.prisma.outbox.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });

    this.logger.log(`Bulk replayed ${ids.length} dead outbox items`);
    return {
      status: 'bulk_replayed',
      count: ids.length,
      replayedOutboxIds: ids,
    };
  }
}
