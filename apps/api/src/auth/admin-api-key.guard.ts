import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const headers = request.headers || {};

    const apiKeyHeader = headers['x-admin-api-key'];
    const authHeader = headers['authorization'];

    let providedKey: string | undefined;

    if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
      providedKey = apiKeyHeader.trim();
    } else if (typeof authHeader === 'string' && authHeader.trim()) {
      const parts = authHeader.trim().split(/\s+/);
      if (
        parts.length === 2 &&
        (parts[0].toLowerCase() === 'bearer' || parts[0].toLowerCase() === 'apikey')
      ) {
        providedKey = parts[1];
      }
    }

    if (!providedKey) {
      throw new UnauthorizedException(
        'Missing admin API key (X-Admin-Api-Key or Authorization: Bearer <key> required)'
      );
    }

    const expectedKey = process.env.ADMIN_API_KEY || 'test_admin_api_key_secret_2026';

    const providedBuf = Buffer.from(providedKey);
    const expectedBuf = Buffer.from(expectedKey);

    // Constant-time comparison to prevent timing side-channel attacks
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException('Invalid admin API key');
    }

    return true;
  }
}
