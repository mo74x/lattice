import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaClient } from '@prisma/client';
import { AdapterRegistry } from '@lattice/adapters';
import { WebhookController } from './webhooks/webhook.controller';
import { WebhookService } from './webhooks/webhook.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullModule.registerQueue({
      name: 'inbound-webhooks',
    }),
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    {
      provide: AdapterRegistry,
      useClass: AdapterRegistry,
    },
    {
      provide: PrismaClient,
      useFactory: () => new PrismaClient(),
    },
  ],
})
export class AppModule {}
