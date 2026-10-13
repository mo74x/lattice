import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import {
  SecretRotationService,
  RotateSecretDto,
} from './secret-rotation.service';

@Controller('admin/connections')
@UseGuards(AdminApiKeyGuard)
export class SecretRotationController {
  constructor(private readonly rotationService: SecretRotationService) {}

  @Post(':connectionId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(
    @Param('connectionId') connectionId: string,
    @Body() dto: RotateSecretDto
  ) {
    return this.rotationService.rotateWebhookSecret(connectionId, dto);
  }

  @Get(':connectionId/secret-status')
  async getSecretStatus(@Param('connectionId') connectionId: string) {
    return this.rotationService.getSecretStatus(connectionId);
  }

  @Post(':connectionId/revoke-previous-secret')
  @HttpCode(HttpStatus.OK)
  async revokePreviousSecret(@Param('connectionId') connectionId: string) {
    return this.rotationService.revokePreviousSecret(connectionId);
  }
}
