import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { DlqService } from './dlq.service';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard';

@Controller('admin/dlq')
@UseGuards(AdminApiKeyGuard)
export class DlqController {
  constructor(private readonly dlqService: DlqService) {}

  @Get()
  async getDlqItems(
    @Query('type') type?: 'all' | 'inbound' | 'outbound',
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.dlqService.getDlqItems({
      type: type || 'all',
      connectionId,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('summary')
  async getDlqSummary(@Query('connectionId') connectionId?: string) {
    return this.dlqService.getDlqSummary(connectionId);
  }

  // Replay single inbound raw event
  @Post('inbound/:id/replay')
  @HttpCode(HttpStatus.OK)
  async replayInbound(@Param('id') id: string) {
    return this.dlqService.replayInboundEvent(id);
  }

  // Alias: POST /admin/events/:id/replay or /admin/dlq/events/:id/replay
  @Post('events/:id/replay')
  @HttpCode(HttpStatus.OK)
  async replayEvent(@Param('id') id: string) {
    return this.dlqService.replayInboundEvent(id);
  }

  // Bulk replay inbound events (useful after partner downtime or patch deploy)
  @Post('inbound/bulk-replay')
  @HttpCode(HttpStatus.OK)
  async bulkReplayInbound(
    @Body()
    dto: {
      connectionId?: string;
      from?: string;
      to?: string;
      onlyErrors?: boolean;
      limit?: number;
    }
  ) {
    return this.dlqService.bulkReplayInbound(dto);
  }

  // Alias: POST /admin/dlq/events/bulk-replay
  @Post('events/bulk-replay')
  @HttpCode(HttpStatus.OK)
  async bulkReplayEvents(
    @Body()
    dto: {
      connectionId?: string;
      from?: string;
      to?: string;
      onlyErrors?: boolean;
      limit?: number;
    }
  ) {
    return this.dlqService.bulkReplayInbound(dto);
  }

  // Replay single dead outbox row
  @Post('outbound/:id/replay')
  @HttpCode(HttpStatus.OK)
  async replayOutbound(@Param('id') id: string) {
    return this.dlqService.replayOutboxItem(id);
  }

  // Bulk replay dead outbox rows
  @Post('outbound/bulk-replay')
  @HttpCode(HttpStatus.OK)
  async bulkReplayOutbound(
    @Body()
    dto: {
      connectionId?: string;
      limit?: number;
    }
  ) {
    return this.dlqService.bulkReplayOutbound(dto);
  }
}
