import { Controller, Post, Param, Req, HttpCode, HttpStatus, Headers } from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from './webhook.service';

interface RawBodyRequest extends Request {
  rawBody: Buffer;
}

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

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