import * as crypto from 'crypto';
import {
  CanonicalBooking,
  CanonicalEnvelope,
  computeCanonicalHash,
} from '@lattice/canonical';
import { PartnerAdapter, PushContext } from './types';

export interface CloudbedsReservation {
  reservation_id: string;
  property_id: string;
  room_identifier: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_email?: string;
  start_date: string; // "2026-11-01T00:00:00Z"
  end_date: string;   // "2026-11-15T00:00:00Z"
  booking_status: 'reserved' | 'in_house' | 'departed' | 'void';
  total_cents: number;
  currency_code: string;
  modified_at: string;
}

export class CloudbedsAdapter implements PartnerAdapter<CloudbedsReservation> {
  readonly provider = 'cloudbeds_mock';
  readonly capabilities = {
    supportsOriginHeader: true,
    supportsIdempotencyKey: true,
    supportsIncrementalPull: true,
    rateLimit: { rps: 10, burst: 20 },
  };

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, secret: string): boolean {
    const signature = headers['x-cloudbeds-signature'] as string;
    const timestamp = headers['x-cloudbeds-timestamp'] as string;
    if (!signature || !timestamp) return false;

    // Tolerance window: ±5 minutes
    const reqTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - reqTime) > 300) return false;

    const payloadToSign = `${timestamp}.${rawBody.toString('utf8')}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex');

    if (signature.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  }

  extractEventId(_payload: unknown, headers: Record<string, string | string[] | undefined>): string {
    const eventId = headers['x-event-id'] as string;
    if (!eventId) throw new Error('Cloudbeds missing X-Event-Id header');
    return eventId;
  }

  extractTimestamp(_payload: unknown, headers: Record<string, string | string[] | undefined>): Date {
    const timestamp = headers['x-cloudbeds-timestamp'] as string;
    return timestamp ? new Date(parseInt(timestamp, 10) * 1000) : new Date();
  }

  toCanonical(external: CloudbedsReservation): CanonicalEnvelope<CanonicalBooking> {
    const statusMap: Record<string, CanonicalBooking['status']> = {
      reserved: 'CONFIRMED',
      in_house: 'CHECKED_IN',
      departed: 'CHECKED_OUT',
      void: 'CANCELLED',
    };

    const canonical: CanonicalBooking = {
      tenantId: 'unassigned', // Resolved by Connection context
      propertyId: external.property_id,
      unitId: external.room_identifier,
      guestName: `${external.guest_first_name} ${external.guest_last_name}`.trim(),
      guestEmail: external.guest_email || null,
      checkIn: external.start_date.split('T')[0],
      checkOut: external.end_date.split('T')[0],
      status: statusMap[external.booking_status] || 'PENDING',
      totalAmount: external.total_cents / 100,
      currency: external.currency_code.toUpperCase(),
    };

    return {
      entityType: 'booking',
      externalId: external.reservation_id,
      externalUpdatedAt: new Date(external.modified_at),
      rawHash: computeCanonicalHash(canonical as unknown as Record<string, unknown>),
      data: canonical,
    };
  }

  fromCanonical(entity: CanonicalBooking, _ctx: PushContext): CloudbedsReservation {
    const revStatusMap: Record<CanonicalBooking['status'], CloudbedsReservation['booking_status']> = {
      CONFIRMED: 'reserved',
      CHECKED_IN: 'in_house',
      CHECKED_OUT: 'departed',
      CANCELLED: 'void',
      PENDING: 'reserved',
    };

    const [first, ...rest] = entity.guestName.split(' ');

    return {
      reservation_id: entity.id || '',
      property_id: entity.propertyId,
      room_identifier: entity.unitId,
      guest_first_name: first || 'Unknown',
      guest_last_name: rest.join(' ') || 'Guest',
      guest_email: entity.guestEmail || undefined,
      start_date: `${entity.checkIn}T00:00:00Z`,
      end_date: `${entity.checkOut}T00:00:00Z`,
      booking_status: revStatusMap[entity.status],
      total_cents: Math.round(entity.totalAmount * 100),
      currency_code: entity.currency,
      modified_at: new Date().toISOString(),
    };
  }

  async listChangedSince(
    _cursor: string | null,
    _credentials: Record<string, unknown>
  ): Promise<{ items: CloudbedsReservation[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }
}