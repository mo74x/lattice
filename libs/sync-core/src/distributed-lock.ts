import Redis from 'ioredis';
import * as crypto from 'crypto';

export class DistributedLock {
  constructor(private readonly redis: Redis) {}

  // Acquires an atomic distributed lock using SET key value NX PX.

  async acquire(resource: string, ttlMs = 5000): Promise<string | null> {
    const token = crypto.randomUUID();
    const res = await this.redis.set(`lock:${resource}`, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  // Releases lock safely using Lua script to verify token ownership.

  async release(resource: string, token: string): Promise<boolean> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const res = await this.redis.eval(luaScript, 1, `lock:${resource}`, token);
    return res === 1;
  }
}