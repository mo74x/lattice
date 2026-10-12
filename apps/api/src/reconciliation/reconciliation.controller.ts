import { Controller, Post, Get, Param, Query, HttpCode, HttpStatus, ParseBoolPipe } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { PrismaClient } from '@prisma/client';

@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly prisma: PrismaClient
  ) {}

  @Post(':connectionId')
  @HttpCode(HttpStatus.OK)
  async trigger(
    @Param('connectionId') connectionId: string,
    @Query('dryRun', new ParseBoolPipe({ optional: true })) dryRun?: boolean,
    @Query('maxHeals') maxHeals?: string
  ) {
    return this.reconciliationService.run({
      connectionId,
      dryRun: dryRun ?? false,
      maxHealsPerRun: maxHeals ? parseInt(maxHeals, 10) : 50,
    });
  }

  @Get('drift')
  async listDriftRecords(
    @Query('connectionId') connectionId?: string,
    @Query('healed') healed?: string
  ) {
    const where: any = {};
    if (connectionId) where.connectionId = connectionId;
    if (healed === 'false') where.healedAt = null;
    if (healed === 'true') where.healedAt = { not: null };

    return this.prisma.driftRecord.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: 100,
    });
  }
}