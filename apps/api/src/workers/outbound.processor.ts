import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { DistributedTokenBucket } from '@lattice/sync-core/rate-limiter';
import { DistributedCircuitBreaker, CircuitState } from '@lattice/sync-core/circuit-breaker';
import { computeCanonicalHash } from '@lattice/canonical';
import Redis from 'ioredis';

export interface OutboundJobPayload {
  outboxId: string;
  connectionId: string;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  payload: any;
  originTag: string;
  attempts: number;
}

@Processor('outbound-sync', { concurrency: 5 })
export class OutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundProcessor.name);
  private readonly rateLimiter: DistributedTokenBucket;
  private readonly circuitBreaker: DistributedCircuitBreaker;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly adapterRegistry: AdapterRegistry,
    private readonly redisClient: Redis
  ) {
    super();
    this.rateLimiter = new DistributedTokenBucket(this.redisClient);
    this.circuitBreaker = new DistributedCircuitBreaker(this.redisClient);
  }

  async process(job: Job<OutboundJobPayload>): Promise<void> {
    const { outboxId, connectionId, payload, attempts } = job.data;

    // 1. Fetch connection configuration
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!connection || connection.status !== 'ACTIVE') {
      await this.prisma.outbox.update({
        where: { id: outboxId },
        data: { status: 'DEAD', lastError: 'Connection inactive or missing' },
      });
      return;
    }

    // 2. Check Circuit Breaker
    const circuit = await this.circuitBreaker.getState(connectionId);
    if (circuit === CircuitState.OPEN) {
      this.logger.warn(`Circuit OPEN for connection ${connectionId}. Rescheduling outbox ${outboxId}`);
      await this.reschedule(outboxId, attempts, 30000, 'Circuit breaker OPEN');
      return;
    }

    // 3. Token Bucket Rate Limiter
    const limitCheck = await this.rateLimiter.consume(
      connectionId,
      connection.rateLimitRps * 2, // burst capacity
      connection.rateLimitRps
    );

    if (!limitCheck.allowed) {
      this.logger.debug(`Rate limited for connection ${connectionId}. Backing off for ${limitCheck.retryAfterMs}ms`);
      await this.reschedule(outboxId, attempts, limitCheck.retryAfterMs, 'Rate limit throttled');
      return;
    }

    // 4. Transform Canonical Payload -> Partner Specific Payload
    const adapter = this.adapterRegistry.get(connection.provider);
    const partnerPayload = adapter.fromCanonical(payload, {
      connectionId,
      tenantId: connection.tenantId,
      idempotencyKey: outboxId,
      supportsOriginHeader: adapter.capabilities.supportsOriginHeader,
    });

    // 5. Dispatch HTTP Call to Partner
    try {
      const response = await this.dispatchToPartner(connection, adapter, partnerPayload, outboxId);

      // Record Circuit Breaker success
      await this.circuitBreaker.recordSuccess(connectionId);

      // 6. Save payload hash in ExternalRef for Layer 2 Echo Suppression
      const canonicalHash = computeCanonicalHash(payload);
      await this.prisma.$transaction([
        this.prisma.externalRef.upsert({
          where: {
            connectionId_entityType_externalId: {
              connectionId,
              entityType: 'booking',
              externalId: response.externalId,
            },
          },
          update: {
            lastExternalHash: canonicalHash,
            lastExternalUpdatedAt: new Date(response.modified_at || Date.now()),
          },
          create: {
            connectionId,
            entityType: 'booking',
            entityId: payload.id,
            externalId: response.externalId,
            lastExternalHash: canonicalHash,
            lastExternalUpdatedAt: new Date(response.modified_at || Date.now()),
          },
        }),
        this.prisma.outbox.update({
          where: { id: outboxId },
          data: { status: 'SENT', lastError: null },
        }),
      ]);

      this.logger.log(`Successfully synced outbox ${outboxId} to partner ${connection.provider}`);
    } catch (err: any) {
      await this.handleOutboundFailure(outboxId, connectionId, attempts, err);
    }
  }

  private async dispatchToPartner(connection: any, adapter: any, payload: any, outboxId: string): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': outboxId,
    };

    // Layer 1 Echo Prevention: Inject header if supported by partner
    if (adapter.capabilities.supportsOriginHeader) {
      headers['X-Sync-Origin'] = 'lattice';
    }

    // Pointing to Chaos Mock Partner container
    const url = `http://localhost:4001/${connection.provider.split('_')[0]}/reservations`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      throw new Error(`HTTP_429:${retryAfter * 1000}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP_${res.status}: Partner rejected request`);
    }

    return res.json();
  }

  private async handleOutboundFailure(
    outboxId: string,
    connectionId: string,
    attempts: number,
    err: any
  ): Promise<void> {
    const currentAttempt = attempts + 1;
    await this.circuitBreaker.recordFailure(connectionId);

    // Terminal failure threshold (5 attempts -> DEAD / DLQ)
    if (currentAttempt >= 5) {
      this.logger.error(`Outbox row ${outboxId} exceeded max attempts. Moving to DEAD (DLQ).`);
      await this.prisma.outbox.update({
        where: { id: outboxId },
        data: {
          status: 'DEAD',
          attempts: currentAttempt,
          lastError: err.message,
        },
      });
      return;
    }

    // Exponential Backoff with Random Full Jitter:
    // sleep = rand(0, min(max_backoff, base * 2 ^ attempt))
    let backoffMs: number;
    if (err.message.startsWith('HTTP_429:')) {
      backoffMs = parseInt(err.message.split(':')[1], 10);
    } else {
      const base = 1000;
      const exponential = Math.min(60000, base * Math.pow(2, currentAttempt));
      backoffMs = Math.floor(Math.random() * exponential);
    }

    await this.reschedule(outboxId, currentAttempt, backoffMs, err.message);
  }

  private async reschedule(outboxId: string, attempts: number, delayMs: number, errorMsg: string): Promise<void> {
    await this.prisma.outbox.update({
      where: { id: outboxId },
      data: {
        status: 'PENDING',
        attempts,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: errorMsg,
      },
    });
  }
}