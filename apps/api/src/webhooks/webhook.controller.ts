import { Controller, Post, Get, Param, Req, HttpCode, HttpStatus, Headers } from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from './webhook.service';

interface RawBodyRequest extends Request {
  rawBody: Buffer;
}

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get(':connectionId/stats')
  async getStats(@Param('connectionId') connectionId: string) {
    return this.webhookService.getConnectionStats(connectionId);
  }

  @Post(':connectionId')
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Param('connectionId') connectionId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: RawBodyRequest
  ) {
    return this.webhookService.handleIncomingWebhook(
      connectionId,
      headers,
      req.rawBody,
      req.body
    );
  }
}