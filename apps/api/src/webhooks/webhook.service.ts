import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AdapterRegistry } from '@lattice/adapters';
import {
  webhooksReceivedTotal,
  webhookDuplicatesTotal,
  webhookIngestDuration,
} from '@lattice/sync-core/metrics';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly adapterRegistry: AdapterRegistry,
    @InjectQueue('inbound-webhooks') private readonly inboundQueue: Queue
  ) {}

  async handleIncomingWebhook(
    connectionId: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    parsedPayload: unknown
  ): Promise<{ status: string; eventId: string }> {
    const startTime = process.hrtime();

    // Fetch connection and adapter
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, provider: true, webhookSecret: true, status: true, tenantId: true },
    });

    if (!connection || connection.status !== 'ACTIVE') {
      webhooksReceivedTotal.inc({ provider: connection?.provider || 'unknown', valid: 'false' });
      throw new BadRequestException('Connection invalid or inactive');
    }

    const adapter = this.adapterRegistry.get(connection.provider);

    // Constant-time cryptographic verification
    const isValid = adapter.verifyWebhook(headers, rawBody, connection.webhookSecret);
    if (!isValid) {
      webhooksReceivedTotal.inc({ provider: connection.provider, valid: 'false' });
      this.logger.warn(`Rejected invalid webhook signature on connection ${connectionId}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    webhooksReceivedTotal.inc({ provider: connection.provider, valid: 'true' });

    const externalEventId = adapter.extractEventId(parsedPayload, headers);
    const eventTimestamp = adapter.extractTimestamp(parsedPayload, headers);

    // Store raw event (idempotency key at ingestion layer)
    try {
      await this.prisma.rawEvent.create({
        data: {
          connectionId,
          externalEventId,
          payload: parsedPayload as any,
          headers: headers as any,
          signatureValid: true,
          receivedAt: new Date(),
        },
      });
    } catch (error: any) {
      // Prisma error P2002: Unique constraint violation on (connectionId, externalEventId)
      if (error.code === 'P2002') {
        webhookDuplicatesTotal.inc({ provider: connection.provider });
        this.logger.log(`Deduplicated event ${externalEventId} on connection ${connectionId}`);
        return { status: 'deduplicated', eventId: externalEventId };
      }
      throw error;
    }

    // Enqueue into BullMQ with deterministic jobId to prevent queue duplicate storms
    await this.inboundQueue.add(
      'process_event',
      {
        connectionId,
        tenantId: connection.tenantId,
        provider: connection.provider,
        externalEventId,
        eventTimestamp,
        payload: parsedPayload,
      },
      {
        jobId: `${connectionId}:${externalEventId}`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );

    const [seconds, nanoseconds] = process.hrtime(startTime);
    const durationSeconds = seconds + nanoseconds / 1e9;
    webhookIngestDuration.observe({ provider: connection.provider }, durationSeconds);

    return { status: 'enqueued', eventId: externalEventId };
  }

  async getConnectionStats(connectionId: string) {
    const [counts, totalEvents, processedEvents, errorEvents, skippedEvents, pendingEvents] =
      await Promise.all([
        this.inboundQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
        this.prisma.rawEvent.count({ where: { connectionId } }),
        this.prisma.rawEvent.count({ where: { connectionId, processedAt: { not: null } } }),
        this.prisma.rawEvent.count({
          where: {
            connectionId,
            error: { not: null },
            NOT: { error: { startsWith: 'Skipped:' } },
          },
        }),
        this.prisma.rawEvent.count({
          where: {
            connectionId,
            error: { startsWith: 'Skipped:' },
          },
        }),
        this.prisma.rawEvent.count({ where: { connectionId, processedAt: null } }),
      ]);

    return {
      connectionId,
      rawEvents: {
        total: totalEvents,
        processed: processedEvents,
        pending: pendingEvents,
        errors: errorEvents,
        skipped: skippedEvents,
      },
      queue: counts,
    };
  }
}