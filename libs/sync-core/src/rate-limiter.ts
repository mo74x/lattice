import Redis from 'ioredis';

export class DistributedTokenBucket {
  constructor(private readonly redis: Redis) {}
  
  private static readonly LUA_SCRIPT = `
    local key = KEYS[1]
    local max_capacity = tonumber(ARGV[1])
    local refill_rate_per_sec = tonumber(ARGV[2])
    local now_ms = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    local data = redis.call('HMGET', key, 'tokens', 'last_updated_ms')
    local tokens = tonumber(data[1])
    local last_updated_ms = tonumber(data[2])

    if tokens == nil then
      tokens = max_capacity
      last_updated_ms = now_ms
    else
      local delta_sec = math.max(0, (now_ms - last_updated_ms) / 1000)
      tokens = math.min(max_capacity, tokens + (delta_sec * refill_rate_per_sec))
      last_updated_ms = now_ms
    end

    if tokens >= requested then
      tokens = tokens - requested
      redis.call('HMSET', key, 'tokens', tokens, 'last_updated_ms', last_updated_ms)
      redis.call('PEXPIRE', key, math.ceil((max_capacity / refill_rate_per_sec) * 1000 * 2))
      return { 1, tokens, 0 }
    else
      local needed = requested - tokens
      local retry_after_ms = math.ceil((needed / refill_rate_per_sec) * 1000)
      return { 0, tokens, retry_after_ms }
    end
  `;

  async consume(key: string, capacity: number, rps: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const res = (await this.redis.eval(
      DistributedTokenBucket.LUA_SCRIPT,
      1,
      `ratelimit:${key}`,
      capacity,
      rps,
      Date.now(),
      1
    )) as [number, number, number];

    return {
      allowed: res[0] === 1,
      retryAfterMs: res[2],
    };
  }
}