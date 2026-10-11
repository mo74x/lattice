import { z } from 'zod';

export const BookingStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED',
]);
export type CanonicalBookingStatus = z.infer<typeof BookingStatusSchema>;

export const CanonicalBookingSchema = z.object({
  id: z.string().uuid().optional(),
  tenantId: z.string(),
  propertyId: z.string(),
  unitId: z.string(),
  guestName: z.string().min(1),
  guestEmail: z.string().email().nullable().optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  status: BookingStatusSchema,
  totalAmount: z.number().positive(),
  currency: z.string().length(3),
});
export type CanonicalBooking = z.infer<typeof CanonicalBookingSchema>;

export interface CanonicalEnvelope<T = unknown> {
  entityType: 'booking' | 'property' | 'transaction';
  externalId: string;
  externalUpdatedAt: Date;
  rawHash: string;
  data: T;
}

export type FieldAuthorityConfig = Record<
  string,
  'internal' | 'partner' | 'latest'
>;