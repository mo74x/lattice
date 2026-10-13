import { SecretRotationService } from '../src/auth/secret-rotation.service';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('SecretRotationService', () => {
  let service: SecretRotationService;
  let mockPrisma: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPrisma = {
      connection: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    mockRedis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(86400),
    };

    service = new SecretRotationService(
      mockPrisma as unknown as PrismaClient,
      mockRedis as unknown as Redis
    );
  });

  describe('rotateWebhookSecret', () => {
    it('rotates secret, updates database, caches previous secret in Redis with grace TTL, and creates audit log', async () => {
      const mockConn = {
        id: 'conn-1',
        provider: 'cloudbeds_mock',
        status: 'ACTIVE',
        webhookSecret: 'old_secret_123',
        tenantId: 'tenant-1',
      };
      mockPrisma.connection.findUnique.mockResolvedValue(mockConn);
      mockPrisma.connection.update.mockResolvedValue({
        ...mockConn,
        webhookSecret: 'custom_new_secret',
      });

      const result = await service.rotateWebhookSecret('conn-1', {
        newSecret: 'custom_new_secret',
        gracePeriodSeconds: 3600,
      });

      expect(result.status).toBe('rotated');
      expect(result.connectionId).toBe('conn-1');
      expect(result.newSecret).toBe('custom_new_secret');
      expect(result.gracePeriodSeconds).toBe(3600);

      // Verify Redis cached the old secret with 3600s TTL
      expect(mockRedis.set).toHaveBeenCalledWith(
        'lattice:connection:conn-1:prev_secret',
        'old_secret_123',
        'EX',
        3600
      );

      // Verify Prisma updated the connection with new secret
      expect(mockPrisma.connection.update).toHaveBeenCalledWith({
        where: { id: 'conn-1' },
        data: { webhookSecret: 'custom_new_secret' },
      });

      // Verify AuditLog was recorded
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          entityType: 'connection',
          entityId: 'conn-1',
          action: 'ROTATE_WEBHOOK_SECRET',
        }),
      });
    });

    it('generates a secure 64-char hex secret when newSecret is omitted', async () => {
      const mockConn = {
        id: 'conn-1',
        provider: 'guesty_mock',
        status: 'ACTIVE',
        webhookSecret: 'initial_secret',
        tenantId: 'tenant-1',
      };
      mockPrisma.connection.findUnique.mockResolvedValue(mockConn);
      mockPrisma.connection.update.mockResolvedValue(mockConn);

      const result = await service.rotateWebhookSecret('conn-1');

      expect(result.newSecret).toBeDefined();
      expect(result.newSecret.length).toBe(64); // 32 bytes hex
      expect(result.gracePeriodSeconds).toBe(86400); // Default 24h
    });

    it('throws NotFoundException for missing connection', async () => {
      mockPrisma.connection.findUnique.mockResolvedValue(null);

      await expect(service.rotateWebhookSecret('conn-missing')).rejects.toThrow(
        NotFoundException
      );
    });

    it('throws BadRequestException for revoked connection', async () => {
      mockPrisma.connection.findUnique.mockResolvedValue({
        id: 'conn-revoked',
        status: 'REVOKED',
      });

      await expect(service.rotateWebhookSecret('conn-revoked')).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe('getSecretStatus', () => {
    it('returns active grace period details when Redis key is alive', async () => {
      mockPrisma.connection.findUnique.mockResolvedValue({
        id: 'conn-1',
        provider: 'cloudbeds_mock',
      });
      mockRedis.ttl.mockResolvedValue(43200);
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ expiresAt: '2026-10-14T12:00:00.000Z' })
      );

      const status = await service.getSecretStatus('conn-1');

      expect(status.hasActiveGracePeriod).toBe(true);
      expect(status.remainingGraceSeconds).toBe(43200);
      expect(status.previousSecretExpiresAt).toBe('2026-10-14T12:00:00.000Z');
    });

    it('returns hasActiveGracePeriod: false when TTL <= 0', async () => {
      mockPrisma.connection.findUnique.mockResolvedValue({
        id: 'conn-1',
        provider: 'cloudbeds_mock',
      });
      mockRedis.ttl.mockResolvedValue(-2);
      mockRedis.get.mockResolvedValue(null);

      const status = await service.getSecretStatus('conn-1');

      expect(status.hasActiveGracePeriod).toBe(false);
      expect(status.remainingGraceSeconds).toBe(0);
      expect(status.previousSecretExpiresAt).toBeNull();
    });
  });

  describe('revokePreviousSecret', () => {
    it('deletes Redis keys and logs revocation in AuditLog', async () => {
      mockPrisma.connection.findUnique.mockResolvedValue({
        id: 'conn-1',
        tenantId: 'tenant-1',
      });

      const result = await service.revokePreviousSecret('conn-1');

      expect(result.status).toBe('revoked');
      expect(mockRedis.del).toHaveBeenCalledWith(
        'lattice:connection:conn-1:prev_secret',
        'lattice:connection:conn-1:rotation_info'
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'REVOKE_PREVIOUS_WEBHOOK_SECRET',
        }),
      });
    });
  });
});
