import { CanonicalBooking, FieldAuthorityConfig } from '@lattice/canonical';

export enum DriftKind {
  MISSING_INTERNAL = 'MISSING_INTERNAL',
  MISSING_EXTERNAL = 'MISSING_EXTERNAL',
  FIELD_MISMATCH = 'FIELD_MISMATCH',
  STALE = 'STALE',
}

export enum HealAction {
  PUSHED = 'PUSHED',
  PULLED = 'PULLED',
  ESCALATED = 'ESCALATED',
  NONE = 'NONE',
}

export interface ClassifiedDrift {
  kind: DriftKind;
  entityType: 'booking';
  externalId: string;
  internalId?: string;
  diff: Record<string, { internal: unknown; external: unknown }>;
  recommendedAction: HealAction;
  reason: string;
}

export class DriftClassifier {
  private static readonly COMPARISON_FIELDS: (keyof CanonicalBooking)[] = [
    'guestName',
    'guestEmail',
    'checkIn',
    'checkOut',
    'status',
    'totalAmount',
    'currency',
  ];

  static evaluate(params: {
    externalId: string;
    internalRecord: CanonicalBooking | null;
    externalRecord: CanonicalBooking | null;
    fieldAuthority: FieldAuthorityConfig;
  }): ClassifiedDrift | null {
    const { externalId, internalRecord, externalRecord, fieldAuthority } = params;

    // Case 1: Exists on external partner, missing in Lattice DB (Dropped webhook)
    if (!internalRecord && externalRecord) {
      return {
        kind: DriftKind.MISSING_INTERNAL,
        entityType: 'booking',
        externalId,
        diff: { aggregate: { internal: null, external: externalRecord } },
        recommendedAction: HealAction.PULLED,
        reason: 'Record exists on partner but missing internally; webhook dropped',
      };
    }

    // Case 2: Exists internally, missing in partner system (Failed push/outbox dropped)
    if (internalRecord && !externalRecord) {
      return {
        kind: DriftKind.MISSING_EXTERNAL,
        entityType: 'booking',
        externalId,
        internalId: internalRecord.id,
        diff: { aggregate: { internal: internalRecord, external: null } },
        recommendedAction: HealAction.PUSHED,
        reason: 'Record exists internally but partner has no record',
      };
    }

    if (!internalRecord || !externalRecord) return null;

    // Case 3: Both exist — compare canonical fields
    const diff: Record<string, { internal: unknown; external: unknown }> = {};
    let partnerDominanceCount = 0;
    let internalDominanceCount = 0;

    for (const field of this.COMPARISON_FIELDS) {
      const intVal = internalRecord[field];
      const extVal = externalRecord[field];

      if (intVal !== extVal) {
        diff[field] = { internal: intVal, external: extVal };
        const authority = fieldAuthority[field] || 'latest';

        if (authority === 'partner') partnerDominanceCount++;
        else if (authority === 'internal') internalDominanceCount++;
      }
    }

    if (Object.keys(diff).length === 0) {
      return null; // Identical: no drift detected
    }

    // Determine heal action based on field authority configuration
    let recommendedAction = HealAction.ESCALATED;
    let reason = 'Complex multi-field mismatch; review needed';

    if (partnerDominanceCount > 0 && internalDominanceCount === 0) {
      recommendedAction = HealAction.PULLED;
      reason = 'All mismatched fields are partner-authoritative; pull changes';
    } else if (internalDominanceCount > 0 && partnerDominanceCount === 0) {
      recommendedAction = HealAction.PUSHED;
      reason = 'All mismatched fields are internal-authoritative; push changes';
    }

    return {
      kind: DriftKind.FIELD_MISMATCH,
      entityType: 'booking',
      externalId,
      internalId: internalRecord.id,
      diff,
      recommendedAction,
      reason,
    };
  }
}