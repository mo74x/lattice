import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DistributedLock } from '@lattice/sync-core/distributed-lock';
import { DriftClassifier, DriftKind, HealAction, ClassifiedDrift } from '@lattice/sync-core/diff-classifier';
import { CanonicalBooking, computeCanonicalHash } from '@lattice/canonical';
import Redis from 'ioredis';

export interface ReconciliationOptions {
  connectionId: string;
  dryRun?: boolean;
  maxHealsPerRun?: number; // Blast radius limit (default: 50)
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly lock: DistributedLock;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly adapterRegistry: AdapterRegistry,
    private readonly redis: Redis,
    @InjectQueue('inbound-webhooks') private readonly inboundQueue: Queue,
    @InjectQueue('outbound-sync') private readonly outboundQueue: Queue
  ) {
    this.lock = new DistributedLock(this.redis);
  }

  async run(options: ReconciliationOptions): Promise<{
    inspectedCount: number;
    driftCount: number;
    healedCount: number;
    escalatedCount: number;
  }> {
    const { connectionId, dryRun = false, maxHealsPerRun = 50 } = options;

    // 1. Distributed Leader Election: prevent dual-running reconciliation sweeps
    const lockToken = await this.lock.acquire(`reconciliation:${connectionId}`, 60000);
    if (!lockToken) {
      this.logger.warn(`Reconciliation sweep already active for connection ${connectionId}. Skipping.`);
      return { inspectedCount: 0, driftCount: 0, healedCount: 0, escalatedCount: 0 };
    }

    let inspectedCount = 0;
    let driftCount = 0;
    let healedCount = 0;
    let escalatedCount = 0;

    try {
      const connection = await this.prisma.connection.findUnique({
        where: { id: connectionId },
      });
      if (!connection || connection.status !== 'ACTIVE') {
        throw new Error(`Connection ${connectionId} is not active`);
      }

      const adapter = this.adapterRegistry.get(connection.provider);
      let cursor = connection.syncCursor;
      let hasMore = true;

      // 2. Paginate over partner's changed entities
      while (hasMore) {
        const pullResult = await adapter.listChangedSince(cursor, {});
        const externalBatch = pullResult.items;

        if (!externalBatch || externalBatch.length === 0) {
          break;
        }

        inspectedCount += externalBatch.length;

        // 3. Batch load existing mappings and canonical bookings (Eliminating N+1 queries)
        const canonicalEnvelopes = externalBatch.map((raw) => adapter.toCanonical(raw));
        const externalIds = canonicalEnvelopes.map((e) => e.externalId);

        const mappings = await this.prisma.externalRef.findMany({
          where: {
            connectionId,
            entityType: 'booking',
            externalId: { in: externalIds },
          },
        });

        const mappingMap = new Map(mappings.map((m) => [m.externalId, m]));
        const internalBookingIds = mappings.map((m) => m.entityId);

        const internalBookings = await this.prisma.booking.findMany({
          where: { id: { in: internalBookingIds } },
        });

        const internalBookingMap = new Map(internalBookings.map((b) => [b.id, b]));

        // 4. Diff and Classify
        for (const envelope of canonicalEnvelopes) {
          const mapping = mappingMap.get(envelope.externalId);
          const internalRecord = mapping ? internalBookingMap.get(mapping.entityId) : null;

          let canonicalInternal: CanonicalBooking | null = null;
          if (internalRecord) {
            canonicalInternal = {
              id: internalRecord.id,
              tenantId: internalRecord.tenantId,
              propertyId: internalRecord.propertyId,
              unitId: internalRecord.unitId,
              guestName: internalRecord.guestName,
              guestEmail: internalRecord.guestEmail,
              checkIn: internalRecord.checkIn.toISOString().split('T')[0],
              checkOut: internalRecord.checkOut.toISOString().split('T')[0],
              status: internalRecord.status as any,
              totalAmount: Number(internalRecord.totalAmount),
              currency: internalRecord.currency,
            };
          }

          const drift = DriftClassifier.evaluate({
            externalId: envelope.externalId,
            internalRecord: canonicalInternal,
            externalRecord: envelope.data,
            fieldAuthority: (connection.fieldAuthority as any) || {},
          });

          if (drift) {
            driftCount++;
            this.logger.warn(`Drift detected on ${drift.externalId}: ${drift.kind} (${drift.reason})`);

            // Persist Drift Record
            await this.prisma.driftRecord.create({
              data: {
                connectionId,
                entityType: 'booking',
                entityId: drift.internalId || 'unknown',
                kind: drift.kind as any,
                diff: drift.diff as any,
                action: dryRun ? 'NONE' : (drift.recommendedAction as any),
              },
            });

            // 5. Automated Healing with Blast Radius Limit
            if (!dryRun && healedCount < maxHealsPerRun) {
              const healed = await this.executeHeal(connection, envelope, drift);
              if (healed) healedCount++;
              else escalatedCount++;
            } else if (drift.recommendedAction === HealAction.ESCALATED) {
              escalatedCount++;
            }
          }
        }

        // 6. Advance cursor ONLY after batch completes cleanly
        if (!dryRun && pullResult.nextCursor) {
          await this.prisma.connection.update({
            where: { id: connectionId },
            data: { syncCursor: pullResult.nextCursor },
          });
          cursor = pullResult.nextCursor;
        } else {
          hasMore = false;
        }
      }
    } finally {
      await this.lock.release(`reconciliation:${connectionId}`, lockToken);
    }

    return { inspectedCount, driftCount, healedCount, escalatedCount };
  }

  /**
   * Safe Healing: Enqueue through standard pipelines so locking,
   * outbox generation, and exclusion constraints are strictly enforced.
   */
  private async executeHeal(
    connection: any,
    envelope: any,
    drift: ClassifiedDrift
  ): Promise<boolean> {
    if (drift.recommendedAction === HealAction.PULLED) {
      // Re-route dropped change through inbound pipeline
      await this.inboundQueue.add(
        'process_event',
        {
          connectionId: connection.id,
          tenantId: connection.tenantId,
          provider: connection.provider,
          externalEventId: `reconcile_${drift.externalId}_${Date.now()}`,
          eventTimestamp: envelope.externalUpdatedAt.toISOString(),
          payload: envelope.data,
        },
        { attempts: 3 }
      );
      return true;
    }

    if (drift.recommendedAction === HealAction.PUSHED && drift.internalId) {
      // Re-enqueue lost outbound push
      const internalBooking = await this.prisma.booking.findUnique({
        where: { id: drift.internalId },
      });

      if (internalBooking) {
        await this.prisma.outbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: internalBooking.id,
            connectionId: connection.id,
            operation: 'UPSERT',
            payload: internalBooking as any,
            originTag: 'reconciliation_healer',
            status: 'PENDING',
          },
        });
        return true;
      }
    }

    return false; // Escalated
  }
}