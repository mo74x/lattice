import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminApiKeyGuard } from '../src/auth/admin-api-key.guard';

describe('AdminApiKeyGuard', () => {
  let guard: AdminApiKeyGuard;
  const originalKey = process.env.ADMIN_API_KEY;
  const testKey = 'test_secret_admin_key_32_bytes_long';

  beforeEach(() => {
    process.env.ADMIN_API_KEY = testKey;
    guard = new AdminApiKeyGuard();
  });

  afterAll(() => {
    process.env.ADMIN_API_KEY = originalKey;
  });

  function createMockContext(headers: Record<string, string>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    } as unknown as ExecutionContext;
  }

  it('rejects requests with missing admin API key headers', () => {
    const ctx = createMockContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow(/Missing admin API key/);
  });

  it('rejects requests with invalid X-Admin-Api-Key', () => {
    const ctx = createMockContext({ 'x-admin-api-key': 'wrong_invalid_key' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow(/Invalid admin API key/);
  });

  it('rejects requests with invalid Authorization: Bearer token', () => {
    const ctx = createMockContext({ authorization: 'Bearer wrong_token' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('allows requests with valid X-Admin-Api-Key', () => {
    const ctx = createMockContext({ 'x-admin-api-key': testKey });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows requests with valid Authorization: Bearer <key>', () => {
    const ctx = createMockContext({ authorization: `Bearer ${testKey}` });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows requests with valid Authorization: ApiKey <key>', () => {
    const ctx = createMockContext({ authorization: `ApiKey ${testKey}` });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
