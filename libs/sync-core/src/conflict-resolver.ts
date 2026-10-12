import { CanonicalBooking, FieldAuthorityConfig } from '@lattice/canonical';

export interface ConflictResolutionResult {
  mergedData: CanonicalBooking;
  appliedFields: string[];
  discardedFields: string[];
  reasons: Record<string, string>;
}

export class ConflictResolver {
  /**
   * Resolves differences between internal source-of-truth and incoming partner data
   * based on per-field authority:
   * - "partner": partner payload wins
   * - "internal": internal DB record wins (partner update ignored)
   * - "latest": timestamp comparison (fallback)
   */
  static resolve(
    current: CanonicalBooking,
    incoming: CanonicalBooking,
    authorityConfig: FieldAuthorityConfig,
    currentUpdatedAt: Date,
    incomingUpdatedAt: Date
  ): ConflictResolutionResult {
    const merged: CanonicalBooking = { ...current };
    const appliedFields: string[] = [];
    const discardedFields: string[] = [];
    const reasons: Record<string, string> = {};

    const fieldsToInspect: (keyof CanonicalBooking)[] = [
      'guestName',
      'guestEmail',
      'checkIn',
      'checkOut',
      'status',
      'totalAmount',
      'currency',
    ];

    for (const field of fieldsToInspect) {
      const internalVal = current[field];
      const incomingVal = incoming[field];

      if (internalVal === incomingVal) continue;

      const rule = authorityConfig[field] || 'latest';

      if (rule === 'partner') {
        (merged as any)[field] = incomingVal;
        appliedFields.push(field);
        reasons[field] = 'Partner owns field by policy';
      } else if (rule === 'internal') {
        discardedFields.push(field);
        reasons[field] = 'Internal DB owns field by policy';
      } else {
        // Fallback: 'latest'
        if (incomingUpdatedAt.getTime() > currentUpdatedAt.getTime()) {
          (merged as any)[field] = incomingVal;
          appliedFields.push(field);
          reasons[field] = `Incoming is newer (${incomingUpdatedAt.toISOString()} > ${currentUpdatedAt.toISOString()})`;
        } else {
          discardedFields.push(field);
          reasons[field] = `Internal is newer or equal (${currentUpdatedAt.toISOString()} >= ${incomingUpdatedAt.toISOString()})`;
        }
      }
    }

    return { mergedData: merged, appliedFields, discardedFields, reasons };
  }
}