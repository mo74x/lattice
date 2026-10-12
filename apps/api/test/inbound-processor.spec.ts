import { InboundGuard, InboundDecision } from '@lattice/sync-core/inbound-pipeline';
import { ConflictResolver } from '@lattice/sync-core/conflict-resolver';
import { CanonicalBooking } from '@lattice/canonical';

describe('Inbound Processing Logic', () => {
  describe('InboundGuard (Echo & Staleness)', () => {
    it('Layer 1: suppresses processing when origin header matches lattice', () => {
      const evaluation = InboundGuard.evaluate({
        originHeader: 'lattice',
        incomingHash: 'hash-abc',
        lastExternalHash: 'hash-xyz',
        incomingUpdatedAt: new Date('2026-10-12T10:00:00Z'),
        lastExternalUpdatedAt: new Date('2026-10-12T09:00:00Z'),
      });

      expect(evaluation.decision).toBe(InboundDecision.SUPPRESS_ECHO_ORIGIN);
    });

    it('Layer 2: suppresses processing when incoming canonical hash matches lastExternalHash', () => {
      const evaluation = InboundGuard.evaluate({
        incomingHash: 'hash-identical',
        lastExternalHash: 'hash-identical',
        incomingUpdatedAt: new Date('2026-10-12T10:00:00Z'),
        lastExternalUpdatedAt: new Date('2026-10-12T09:00:00Z'),
      });

      expect(evaluation.decision).toBe(InboundDecision.SUPPRESS_ECHO_HASH);
    });

    it('Ordering Guard: drops older/stale events arriving out of sequence', () => {
      const evaluation = InboundGuard.evaluate({
        incomingHash: 'hash-new',
        lastExternalHash: 'hash-old',
        incomingUpdatedAt: new Date('2026-10-12T08:30:00Z'), // Older event arriving late
        lastExternalUpdatedAt: new Date('2026-10-12T09:00:00Z'),
      });

      expect(evaluation.decision).toBe(InboundDecision.DISCARD_STALE);
    });

    it('passes completely fresh and novel events for execution', () => {
      const evaluation = InboundGuard.evaluate({
        incomingHash: 'hash-brand-new',
        lastExternalHash: 'hash-old',
        incomingUpdatedAt: new Date('2026-10-12T11:00:00Z'),
        lastExternalUpdatedAt: new Date('2026-10-12T09:00:00Z'),
      });

      expect(evaluation.decision).toBe(InboundDecision.PROCESS);
    });
  });

  describe('ConflictResolver (Field Authority)', () => {
    const baseCurrent: CanonicalBooking = {
      tenantId: 't-1',
      propertyId: 'p-1',
      unitId: 'u-1',
      guestName: 'Original Guest',
      guestEmail: 'original@test.com',
      checkIn: '2026-11-01',
      checkOut: '2026-11-05',
      status: 'CONFIRMED',
      totalAmount: 500,
      currency: 'USD',
    };

    it('respects field authority: internal wins for guestEmail, partner wins for status', () => {
      const incoming: CanonicalBooking = {
        ...baseCurrent,
        guestEmail: 'partner-changed@test.com',
        status: 'CANCELLED',
      };

      const result = ConflictResolver.resolve(
        baseCurrent,
        incoming,
        { guestEmail: 'internal', status: 'partner' },
        new Date('2026-10-12T10:00:00Z'),
        new Date('2026-10-12T11:00:00Z')
      );

      expect(result.mergedData.guestEmail).toBe('original@test.com'); // Kept internal
      expect(result.mergedData.status).toBe('CANCELLED');             // Partner applied
      expect(result.appliedFields).toContain('status');
      expect(result.discardedFields).toContain('guestEmail');
    });
  });
});