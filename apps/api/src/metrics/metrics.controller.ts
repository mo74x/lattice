import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { register } from '@lattice/sync-core/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  async getMetrics(@Res() res: Response) {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  }
}