import * as crypto from 'crypto';
import { CanonicalBooking, CanonicalEnvelope, computeCanonicalHash } from '@lattice/canonical';
import { PartnerAdapter, PushContext } from './types';

export interface GuestyReservation {
  _id: string;
  listingId: string;
  unitNickname: string;
  primaryGuest: { fullName: string; email?: string };
  checkInDate: { y: number; m: number; d: number };
  checkOutDate: { y: number; m: number; d: number };
  status: 'CONFIRMED' | 'ARRIVED' | 'COMPLETED' | 'CANCELED';
  money: { fare: string; currency: string };
  updatedAt: string;
  signature?: string;
  event_id?: string;
}

export class GuestyAdapter implements PartnerAdapter<GuestyReservation> {
  readonly provider = 'guesty_mock';
  readonly capabilities = {
    supportsOriginHeader: false, // Forces content-hash echo suppression
    supportsIdempotencyKey: false,
    supportsIncrementalPull: true,
    rateLimit: { rps: 5, burst: 10 },
  };

  verifyWebhook(_headers: Record<string, string | string[] | undefined>, rawBody: Buffer, secret: string): boolean {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      const signature = parsed.signature;
      if (!signature) return false;

      // Guesty legacy: HMAC-SHA1 of stringified body with signature stripped
      const clean = { ...parsed };
      delete clean.signature;
      const expected = crypto.createHmac('sha1', secret).update(JSON.stringify(clean)).digest('hex');

      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  extractEventId(payload: any, _headers: Record<string, string | string[] | undefined>): string {
    if (!payload?.event_id) throw new Error('Guesty missing event_id in body');
    return payload.event_id;
  }

  extractTimestamp(payload: any, _headers: Record<string, string | string[] | undefined>): Date {
    return payload?.updatedAt ? new Date(payload.updatedAt) : new Date();
  }

  toCanonical(external: GuestyReservation): CanonicalEnvelope<CanonicalBooking> {
    const statusMap: Record<string, CanonicalBooking['status']> = {
      CONFIRMED: 'CONFIRMED',
      ARRIVED: 'CHECKED_IN',
      COMPLETED: 'CHECKED_OUT',
      CANCELED: 'CANCELLED',
    };

    const pad = (n: number) => n.toString().padStart(2, '0');
    const inDate = `${external.checkInDate.y}-${pad(external.checkInDate.m)}-${pad(external.checkInDate.d)}`;
    const outDate = `${external.checkOutDate.y}-${pad(external.checkOutDate.m)}-${pad(external.checkOutDate.d)}`;

    const canonical: CanonicalBooking = {
      tenantId: 'unassigned',
      propertyId: external.listingId,
      unitId: external.unitNickname,
      guestName: external.primaryGuest.fullName,
      guestEmail: external.primaryGuest.email || null,
      checkIn: inDate,
      checkOut: outDate,
      status: statusMap[external.status] || 'PENDING',
      totalAmount: parseFloat(external.money.fare),
      currency: external.money.currency.toUpperCase(),
    };

    return {
      entityType: 'booking',
      externalId: external._id,
      externalUpdatedAt: new Date(external.updatedAt),
      rawHash: computeCanonicalHash(canonical as unknown as Record<string, unknown>),
      data: canonical,
    };
  }

  fromCanonical(entity: CanonicalBooking, _ctx: PushContext): GuestyReservation {
    const revMap: Record<CanonicalBooking['status'], GuestyReservation['status']> = {
      CONFIRMED: 'CONFIRMED',
      CHECKED_IN: 'ARRIVED',
      CHECKED_OUT: 'COMPLETED',
      CANCELLED: 'CANCELED',
      PENDING: 'CONFIRMED',
    };

    const [ciY, ciM, ciD] = entity.checkIn.split('-').map(Number);
    const [coY, coM, coD] = entity.checkOut.split('-').map(Number);

    return {
      _id: entity.id || '',
      listingId: entity.propertyId,
      unitNickname: entity.unitId,
      primaryGuest: { fullName: entity.guestName, email: entity.guestEmail || undefined },
      checkInDate: { y: ciY, m: ciM, d: ciD },
      checkOutDate: { y: coY, m: coM, d: coD },
      status: revMap[entity.status],
      money: { fare: entity.totalAmount.toFixed(2), currency: entity.currency },
      updatedAt: new Date().toISOString(),
    };
  }

  async listChangedSince(
    _cursor: string | null,
    _credentials: Record<string, unknown>
  ): Promise<{ items: GuestyReservation[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }
}