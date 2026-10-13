import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as crypto from 'crypto';

export interface RotateSecretDto {
  newSecret?: string;
  gracePeriodSeconds?: number;
}

export interface SecretRotationResult {
  status: 'rotated';
  connectionId: string;
  provider: string;
  newSecret: string;
  gracePeriodSeconds: number;
  previousSecretExpiresAt: string;
}

export interface SecretStatusResult {
  connectionId: string;
  provider: string;
  hasActiveGracePeriod: boolean;
  remainingGraceSeconds: number;
  previousSecretExpiresAt: string | null;
}

@Injectable()
export class SecretRotationService {
  private readonly logger = new Logger(SecretRotationService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redisClient: Redis
  ) {}

  private getPrevSecretKey(connectionId: string): string {
    return `lattice:connection:${connectionId}:prev_secret`;
  }

  private getRotationInfoKey(connectionId: string): string {
    return `lattice:connection:${connectionId}:rotation_info`;
  }

  async rotateWebhookSecret(
    connectionId: string,
    dto?: RotateSecretDto
  ): Promise<SecretRotationResult> {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }

    if (connection.status === 'REVOKED') {
      throw new BadRequestException(`Cannot rotate secret for revoked connection ${connectionId}`);
    }

    const previousSecret = connection.webhookSecret;
    const newSecret =
      dto?.newSecret?.trim() || crypto.randomBytes(32).toString('hex');
    const gracePeriodSeconds = dto?.gracePeriodSeconds ?? 86400; // Default 24 hours
    const expiresAt = new Date(Date.now() + gracePeriodSeconds * 1000).toISOString();

    const rotationInfo = {
      rotatedAt: new Date().toISOString(),
      expiresAt,
      gracePeriodSeconds,
      provider: connection.provider,
    };

    // 1. Store previous secret in Redis with exact TTL grace window
    await this.redisClient.set(
      this.getPrevSecretKey(connectionId),
      previousSecret,
      'EX',
      gracePeriodSeconds
    );

    await this.redisClient.set(
      this.getRotationInfoKey(connectionId),
      JSON.stringify(rotationInfo),
      'EX',
      gracePeriodSeconds
    );

    // 2. Persist new primary secret in PostgreSQL
    await this.prisma.connection.update({
      where: { id: connectionId },
      data: { webhookSecret: newSecret },
    });

    // 3. Record audit trail
    await this.prisma.auditLog.create({
      data: {
        tenantId: connection.tenantId,
        entityType: 'connection',
        entityId: connectionId,
        origin: 'admin_api',
        action: 'ROTATE_WEBHOOK_SECRET',
        diff: {
          gracePeriodSeconds,
          expiresAt,
        },
        reason: 'Zero-downtime webhook secret rotation executed',
      },
    });

    this.logger.log(
      `Rotated webhook secret for connection ${connectionId} (${connection.provider}). Grace period: ${gracePeriodSeconds}s`
    );

    return {
      status: 'rotated',
      connectionId,
      provider: connection.provider,
      newSecret,
      gracePeriodSeconds,
      previousSecretExpiresAt: expiresAt,
    };
  }

  async getSecretStatus(connectionId: string): Promise<SecretStatusResult> {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, provider: true },
    });

    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }

    const ttl = await this.redisClient.ttl(this.getPrevSecretKey(connectionId));
    const rawInfo = await this.redisClient.get(this.getRotationInfoKey(connectionId));

    const hasActiveGracePeriod = ttl > 0;
    let previousSecretExpiresAt: string | null = null;

    if (rawInfo) {
      try {
        const parsed = JSON.parse(rawInfo);
        previousSecretExpiresAt = parsed.expiresAt || null;
      } catch {
        previousSecretExpiresAt = null;
      }
    }

    return {
      connectionId,
      provider: connection.provider,
      hasActiveGracePeriod,
      remainingGraceSeconds: hasActiveGracePeriod ? ttl : 0,
      previousSecretExpiresAt,
    };
  }

  async revokePreviousSecret(connectionId: string): Promise<{ status: string; connectionId: string }> {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }

    await this.redisClient.del(
      this.getPrevSecretKey(connectionId),
      this.getRotationInfoKey(connectionId)
    );

    await this.prisma.auditLog.create({
      data: {
        tenantId: connection.tenantId,
        entityType: 'connection',
        entityId: connectionId,
        origin: 'admin_api',
        action: 'REVOKE_PREVIOUS_WEBHOOK_SECRET',
        diff: { revokedAt: new Date().toISOString() },
        reason: 'Immediate revocation of grace-period webhook secret',
      },
    });

    this.logger.warn(`Immediately revoked previous webhook secret for connection ${connectionId}`);

    return {
      status: 'revoked',
      connectionId,
    };
  }
}
