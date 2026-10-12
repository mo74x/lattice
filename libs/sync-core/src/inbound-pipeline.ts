import { computeCanonicalHash } from '@lattice/canonical';

export enum InboundDecision {
  PROCESS = 'PROCESS',
  SUPPRESS_ECHO_ORIGIN = 'SUPPRESS_ECHO_ORIGIN',
  SUPPRESS_ECHO_HASH = 'SUPPRESS_ECHO_HASH',
  DISCARD_STALE = 'DISCARD_STALE',
}

export class InboundGuard {
  static evaluate(params: {
    originHeader?: string;
    incomingHash: string;
    lastExternalHash: string | null;
    incomingUpdatedAt: Date;
    lastExternalUpdatedAt: Date | null;
  }): { decision: InboundDecision; reason: string } {
    // Layer 1: Origin Header Check
    if (params.originHeader === 'lattice') {
      return {
        decision: InboundDecision.SUPPRESS_ECHO_ORIGIN,
        reason: 'X-Sync-Origin header matches lattice',
      };
    }

    // Layer 2: Deterministic Content Hash Comparison
    if (params.lastExternalHash && params.incomingHash === params.lastExternalHash) {
      return {
        decision: InboundDecision.SUPPRESS_ECHO_HASH,
        reason: `Incoming hash ${params.incomingHash} matches last stored external hash`,
      };
    }

    // Monotonic Ordering / Staleness Check
    if (
      params.lastExternalUpdatedAt &&
      params.incomingUpdatedAt.getTime() <= params.lastExternalUpdatedAt.getTime()
    ) {
      return {
        decision: InboundDecision.DISCARD_STALE,
        reason: `Event timestamp (${params.incomingUpdatedAt.toISOString()}) is older or equal to last processed (${params.lastExternalUpdatedAt.toISOString()})`,
      };
    }

    return { decision: InboundDecision.PROCESS, reason: 'Valid actionable mutation' };
  }
}