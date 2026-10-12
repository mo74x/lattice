import { PrismaClient } from '@prisma/client';

describe('Concurrency & GiST Exclusion Constraint Verification', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('guarantees zero double-bookings when 200 concurrent requests compete for the same unit', async () => {
    const tenantId = `tenant-${Date.now()}`;
    const unitId = `penthouse-${Date.now()}`;

    // Seed a property
    const property = await prisma.property.create({
      data: {
        tenantId,
        name: 'Grand Horizon',
        currency: 'USD',
      },
    });

    const TOTAL_CONCURRENT_REQUESTS = 200;
    const checkIn = new Date('2026-11-10');
    const checkOut = new Date('2026-11-20');

    let successfulCommits = 0;
    let caughtExclusionViolations = 0;
    let otherErrors = 0;

    // Fire 200 concurrent booking attempts targeting the exact same unit and dates
    const operations = Array.from({ length: TOTAL_CONCURRENT_REQUESTS }).map(async (_, idx) => {
      try {
        await prisma.booking.create({
          data: {
            tenantId,
            propertyId: property.id,
            unitId,
            guestName: `Guest Concurrent #${idx}`,
            checkIn,
            checkOut,
            status: 'CONFIRMED',
            totalAmount: 1200.0,
            currency: 'USD',
            lastWriteOrigin: 'concurrency_test',
            contentHash: `hash_${idx}`,
          },
        });
        successfulCommits++;
      } catch (err: any) {
        // Postgres SQLSTATE 23P01: exclusion_violation
        if (
          err.code === 'P2010' &&
          err.meta?.message?.includes('conflicting key value violates exclusion constraint "booking_no_overlap"')
        ) {
          caughtExclusionViolations++;
        } else if (err.message?.includes('booking_no_overlap') || err.message?.includes('exclusion constraint')) {
          caughtExclusionViolations++;
        } else {
          otherErrors++;
        }
      }
    });

    await Promise.all(operations);

    // Verification
    expect(successfulCommits).toBe(1);
    expect(caughtExclusionViolations).toBe(TOTAL_CONCURRENT_REQUESTS - 1);
    expect(otherErrors).toBe(0);

    // Verify DB state directly: exactly 1 booking exists for this unit
    const bookingsInDb = await prisma.booking.findMany({
      where: { unitId },
    });
    expect(bookingsInDb).toHaveLength(1);
  });

  it('allows legal back-to-back reservations using [) half-open intervals', async () => {
    const tenantId = `tenant-${Date.now()}`;
    const unitId = `studio-${Date.now()}`;

    const property = await prisma.property.create({
      data: { tenantId, name: 'Ocean Palms', currency: 'USD' },
    });

    // Guest A: Nov 1 to Nov 5 (Check-out on Nov 5)
    const bookingA = await prisma.booking.create({
      data: {
        tenantId,
        propertyId: property.id,
        unitId,
        guestName: 'Guest A',
        checkIn: new Date('2026-11-01'),
        checkOut: new Date('2026-11-05'),
        status: 'CONFIRMED',
        totalAmount: 400.0,
        currency: 'USD',
        lastWriteOrigin: 'test',
        contentHash: 'hash_a',
      },
    });

    // Guest B: Nov 5 to Nov 10 (Check-in on Nov 5)
    // Thanks to [) half-open interval, this MUST succeed without conflict
    const bookingB = await prisma.booking.create({
      data: {
        tenantId,
        propertyId: property.id,
        unitId,
        guestName: 'Guest B',
        checkIn: new Date('2026-11-05'),
        checkOut: new Date('2026-11-10'),
        status: 'CONFIRMED',
        totalAmount: 500.0,
        currency: 'USD',
        lastWriteOrigin: 'test',
        contentHash: 'hash_b',
      },
    });

    expect(bookingA.id).toBeDefined();
    expect(bookingB.id).toBeDefined();
  });
});