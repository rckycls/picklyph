/** Shared market identity; booking contracts will be added with their features. */
export const market = {
  country: 'Philippines',
  countryCode: 'PH',
} as const;

export type { Database } from './database';
export type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory';
