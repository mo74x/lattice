import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaClient } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import Redis from 'ioredis';

import { WebhookController } from './webhooks/webhook.controller';
import { WebhookService } from './webhooks/webhook.service';
import { MetricsController } from './metrics/metrics.controller';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { DlqController } from './dlq/dlq.controller';
import { DlqService } from './dlq/dlq.service';

import { InboundProcessor } from './workers/inbound.processor';
import { OutboundProcessor } from './workers/outbound.processor';
import { OutboxRelayService } from './outbox/outbox-relay.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullModule.registerQueue(
      {
        name: 'inbound-webhooks',
      },
      {
        name: 'outbound-sync',
      }
    ),
  ],
  controllers: [
    WebhookController,
    MetricsController,
    ReconciliationController,
    DlqController,
  ],
  providers: [
    WebhookService,
    DlqService,
    ReconciliationService,
    InboundProcessor,
    OutboundProcessor,
    OutboxRelayService,
    {
      provide: AdapterRegistry,
      useClass: AdapterRegistry,
    },
    {
      provide: PrismaClient,
      useFactory: () => new PrismaClient(),
    },
    {
      provide: Redis,
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
        }),
    },
  ],
})
export class AppModule {}
