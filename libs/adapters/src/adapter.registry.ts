import { PartnerAdapter } from './types';
import { CloudbedsAdapter } from './cloudbeds.adapter';
import { GuestyAdapter } from './guesty.adapter';

export class AdapterRegistry {
  private adapters = new Map<string, PartnerAdapter>();

  constructor() {
    this.register(new CloudbedsAdapter());
    this.register(new GuestyAdapter());
  }

  register(adapter: PartnerAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: string): PartnerAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unsupported integration provider: "${provider}"`);
    return adapter;
  }
}