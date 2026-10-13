import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { CanonicalBooking, computeCanonicalHash } from '@lattice/canonical';
import { ConflictResolver } from '@lattice/sync-core/conflict-resolver';
import { InboundGuard, InboundDecision } from '@lattice/sync-core/inbound-pipeline';
import { echoSuppressedTotal, overlapViolationsTotal } from '@lattice/sync-core/metrics';

export interface InboundJobPayload {
  connectionId: string;
  tenantId: string;
  provider: string;
  externalEventId: string;
  eventTimestamp: string;
  payload: any;
}

@Processor('inbound-webhooks', { concurrency: 10 })
export class InboundProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundProcessor.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly adapterRegistry: AdapterRegistry
  ) {
    super();
  }

  async process(job: Job<InboundJobPayload>): Promise<void> {
    const { connectionId, tenantId, provider, externalEventId, payload } = job.data;
    const eventTime = new Date(job.data.eventTimestamp);

    this.logger.debug(`Processing event ${externalEventId} for connection ${connectionId}`);

    // 1. Resolve Adapter and Connection Config
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!connection) throw new Error(`Connection ${connectionId} not found`);

    const adapter = this.adapterRegistry.get(provider);
    const envelope = adapter.toCanonical(payload);
    envelope.data.tenantId = tenantId;

    const incomingHash = envelope.rawHash;
    const originHeader = payload?.headers?.['x-sync-origin'] || payload?.origin;

    // 2. Fetch or prepare ExternalRef
    const existingRef = await this.prisma.externalRef.findUnique({
      where: {
        connectionId_entityType_externalId: {
          connectionId,
          entityType: 'booking',
          externalId: envelope.externalId,
        },
      },
    });

    // 3. Evaluate Guard Rules (Echo & Staleness)
    const guard = InboundGuard.evaluate({
      originHeader,
      incomingHash,
      lastExternalHash: existingRef?.lastExternalHash || null,
      incomingUpdatedAt: envelope.externalUpdatedAt || eventTime,
      lastExternalUpdatedAt: existingRef?.lastExternalUpdatedAt || null,
    });

    if (guard.decision !== InboundDecision.PROCESS) {
      if (
        guard.decision === InboundDecision.SUPPRESS_ECHO_ORIGIN ||
        guard.decision === InboundDecision.SUPPRESS_ECHO_HASH
      ) {
        echoSuppressedTotal.inc({
          provider,
          layer:
            guard.decision === InboundDecision.SUPPRESS_ECHO_ORIGIN
              ? 'origin_header'
              : 'content_hash',
        });
      }

      this.logger.log(`Skipping event ${externalEventId}: ${guard.reason}`);
      await this.prisma.rawEvent.update({
        where: { connectionId_externalEventId: { connectionId, externalEventId } },
        data: { processedAt: new Date(), error: `Skipped: ${guard.decision}` },
      });
      return;
    }

    // 4. Execute atomic database transaction
    try {
      await this.prisma.$transaction(
        async (tx) => {
          let bookingId = existingRef?.entityId;
          let finalBookingData: CanonicalBooking = envelope.data;

          if (bookingId) {
            // Pessimistic Lock on target aggregate
            const [lockedBooking] = await tx.$queryRaw<any[]>`
              SELECT * FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
            `;

            if (!lockedBooking) {
              throw new Error(`Integrity error: Referenced booking ${bookingId} missing`);
            }

            const currentCanonical: CanonicalBooking = {
              id: lockedBooking.id,
              tenantId: lockedBooking.tenantId,
              propertyId: lockedBooking.propertyId,
              unitId: lockedBooking.unitId,
              guestName: lockedBooking.guestName,
              guestEmail: lockedBooking.guestEmail,
              checkIn: lockedBooking.checkIn.toISOString().split('T')[0],
              checkOut: lockedBooking.checkOut.toISOString().split('T')[0],
              status: lockedBooking.status,
              totalAmount: Number(lockedBooking.totalAmount),
              currency: lockedBooking.currency,
            };

            // Apply Field-Level Authority Conflict Policy
            const resolution = ConflictResolver.resolve(
              currentCanonical,
              envelope.data,
              (connection.fieldAuthority as any) || {},
              lockedBooking.updatedAt,
              envelope.externalUpdatedAt
            );

            finalBookingData = resolution.mergedData;

            // Record resolution history for debugging and audits
            if (resolution.appliedFields.length > 0 || resolution.discardedFields.length > 0) {
              await tx.auditLog.create({
                data: {
                  tenantId,
                  entityType: 'booking',
                  entityId: bookingId,
                  origin: connectionId,
                  action: 'MERGE',
                  diff: {
                    applied: resolution.appliedFields,
                    discarded: resolution.discardedFields,
                    reasons: resolution.reasons,
                  },
                  reason: 'Field authority conflict resolution applied',
                },
              });
            }

            // Update Canonical Booking
            await tx.booking.update({
              where: { id: bookingId },
              data: {
                guestName: finalBookingData.guestName,
                guestEmail: finalBookingData.guestEmail,
                checkIn: new Date(finalBookingData.checkIn),
                checkOut: new Date(finalBookingData.checkOut),
                status: finalBookingData.status,
                totalAmount: new Prisma.Decimal(finalBookingData.totalAmount),
                currency: finalBookingData.currency,
                version: { increment: 1 },
                lastWriteOrigin: connectionId,
                contentHash: computeCanonicalHash(finalBookingData as any),
              },
            });
          } else {
            // Brand new booking creation path
            const created = await tx.booking.create({
              data: {
                tenantId,
                propertyId: envelope.data.propertyId,
                unitId: envelope.data.unitId,
                guestName: envelope.data.guestName,
                guestEmail: envelope.data.guestEmail,
                checkIn: new Date(envelope.data.checkIn),
                checkOut: new Date(envelope.data.checkOut),
                status: envelope.data.status,
                totalAmount: new Prisma.Decimal(envelope.data.totalAmount),
                currency: envelope.data.currency,
                lastWriteOrigin: connectionId,
                contentHash: incomingHash,
              },
            });
            bookingId = created.id;
          }

          // 5. Upsert ExternalRef mapping
          await tx.externalRef.upsert({
            where: {
              connectionId_entityType_externalId: {
                connectionId,
                entityType: 'booking',
                externalId: envelope.externalId,
              },
            },
            update: {
              lastExternalHash: incomingHash,
              lastExternalUpdatedAt: envelope.externalUpdatedAt,
            },
            create: {
              connectionId,
              entityType: 'booking',
              entityId: bookingId,
              externalId: envelope.externalId,
              lastExternalHash: incomingHash,
              lastExternalUpdatedAt: envelope.externalUpdatedAt,
            },
          });

          // 6. Layer 3: Fan-Out to Other Active Connections (Outbox Pattern)
          const siblingConnections = await tx.connection.findMany({
            where: {
              tenantId,
              id: { not: connectionId }, // CRITICAL to exclude origin connection
              status: 'ACTIVE',
            },
          });

          for (const sibling of siblingConnections) {
            await tx.outbox.create({
              data: {
                aggregateType: 'booking',
                aggregateId: bookingId,
                connectionId: sibling.id,
                operation: 'UPSERT',
                payload: finalBookingData as any,
                originTag: connectionId,
                status: 'PENDING',
                nextAttemptAt: new Date(),
              },
            });
          }

          // 7. Mark raw event as successfully processed
          await tx.rawEvent.update({
            where: { connectionId_externalEventId: { connectionId, externalEventId } },
            data: { processedAt: new Date(), error: null },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      );
    } catch (err: any) {
      if (
        err?.message?.includes('overlap') ||
        err?.message?.includes('exclusion') ||
        err?.code === '23P01'
      ) {
        overlapViolationsTotal.inc();
      }

      this.logger.error(`Error processing event ${externalEventId}: ${err.message}`, err.stack);

      // Persist failure reason to RawEvent for visibility in DLQ
      await this.prisma.rawEvent
        .update({
          where: { connectionId_externalEventId: { connectionId, externalEventId } },
          data: { error: err.message || 'Processing failed' },
        })
        .catch(() => {});

      throw err;
    }

  }
}