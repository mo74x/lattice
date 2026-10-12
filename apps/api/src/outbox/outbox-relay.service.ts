import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private isRunning = false;
  private pollInterval?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    @InjectQueue('outbound-sync') private readonly outboundQueue: Queue
  ) {}

  onModuleInit() {
    this.isRunning = true;
    this.pollInterval = setInterval(() => this.pollAndDispatch(), 500);
  }

  onModuleDestroy() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  async pollAndDispatch(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.prisma.$transaction(async (tx) => {
        // High-performance concurrency query:
        // SKIP LOCKED ensures competing worker pods never block each other or fetch duplicate rows.
        const pendingRows = await tx.$queryRaw<any[]>`
          SELECT * FROM "Outbox"
          WHERE "status" = 'PENDING'
            AND "nextAttemptAt" <= NOW()
          ORDER BY "createdAt" ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        `;

        if (pendingRows.length === 0) return;

        for (const row of pendingRows) {
          // 1. Mark as PROCESSING in DB to prevent re-fetch
          await tx.outbox.update({
            where: { id: row.id },
            data: { status: 'PROCESSING' },
          });

          // 2. Enqueue into BullMQ with deterministic jobId = outbox.id
          await this.outboundQueue.add(
            'push_to_partner',
            {
              outboxId: row.id,
              connectionId: row.connectionId,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              operation: row.operation,
              payload: row.payload,
              originTag: row.originTag,
              attempts: row.attempts,
            },
            {
              jobId: `outbox:${row.id}`,
              removeOnComplete: 1000,
              removeOnFail: 5000,
            }
          );
        }

        this.logger.debug(`Relayed ${pendingRows.length} outbox items to outbound queue`);
      });
    } catch (err) {
      this.logger.error('Error during outbox relay sweep', err);
    }
  }
}