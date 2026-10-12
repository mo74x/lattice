import Redis from 'ioredis';

export enum CircuitState {
  CLOSED = 'CLOSED',       
  OPEN = 'OPEN',           
  HALF_OPEN = 'HALF_OPEN', 
}

export class DistributedCircuitBreaker {
  private readonly failureThreshold = 5; 
  private readonly cooldownMs = 30000;    

  constructor(private readonly redis: Redis) {}

  private key(connectionId: string) {
    return `circuit:${connectionId}`;
  }

  async getState(connectionId: string): Promise<CircuitState> {
    const data = await this.redis.hgetall(this.key(connectionId));
    if (!data || !data.state) return CircuitState.CLOSED;

    const state = data.state as CircuitState;
    if (state === CircuitState.OPEN) {
      const openedAt = parseInt(data.openedAt || '0', 10);
      if (Date.now() - openedAt > this.cooldownMs) {
        return CircuitState.HALF_OPEN;
      }
    }
    return state;
  }

  async recordSuccess(connectionId: string): Promise<void> {
    await this.redis.del(this.key(connectionId));
  }

  async recordFailure(connectionId: string): Promise<CircuitState> {
    const key = this.key(connectionId);
    const failures = await this.redis.hincrby(key, 'failures', 1);

    if (failures >= this.failureThreshold) {
      await this.redis.hmset(key, {
        state: CircuitState.OPEN,
        openedAt: Date.now().toString(),
      });
      await this.redis.pexpire(key, this.cooldownMs * 2);
      return CircuitState.OPEN;
    }
    return CircuitState.CLOSED;
  }
}