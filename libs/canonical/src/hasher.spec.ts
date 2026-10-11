import { computeCanonicalHash } from './hasher';

describe('Deterministic Canonical Hasher', () => {
  it('should generate identical hashes regardless of key ordering', () => {
    const payloadA = {
      unitId: 'apt-402',
      checkIn: '2026-11-01',
      checkOut: '2026-11-15',
      totalAmount: 1450.0,
      currency: 'USD',
      status: 'CONFIRMED',
    };

    const payloadB = {
      status: 'CONFIRMED',
      currency: 'USD',
      totalAmount: 1450.0,
      checkOut: '2026-11-15',
      checkIn: '2026-11-01',
      unitId: 'apt-402',
    };

    const hashA = computeCanonicalHash(payloadA);
    const hashB = computeCanonicalHash(payloadB);

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it('should generate different hashes for different business values', () => {
    const payloadA = { unitId: 'apt-402', totalAmount: 1450.0 };
    const payloadB = { unitId: 'apt-402', totalAmount: 1450.01 };

    expect(computeCanonicalHash(payloadA)).not.toBe(computeCanonicalHash(payloadB));
  });
});