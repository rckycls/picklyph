import type { CourtSurface, VenueClaimStatus } from '@picklyph/domain';

import type { ResultsState } from './resultsState';
import type { SearchFailure } from './searchClient';

type Notice = { badge: string; tone: 'neutral' | 'pending' | 'success'; text: string };

// A verified claim permits a rental selection; only the booking server decides eligibility and inventory.
export function listingNotice(claim: VenueClaimStatus): Notice {
  switch (claim) {
    case 'unclaimed':
      return { badge: 'Unclaimed listing', tone: 'neutral', text: 'This venue hasn’t been claimed by its owner, so it can’t be booked in pickly. Contact the venue directly before you go.' };
    case 'pending':
      return { badge: 'Ownership under review', tone: 'pending', text: 'An ownership claim is being reviewed. Booking isn’t available in pickly yet. Contact the venue directly before you go.' };
    case 'verified':
      return { badge: 'Verified owner', tone: 'success', text: 'The owner has verified this listing. Choose a court and time to check the rental price and policy. Availability is checked when you reserve.' };
  }
}

/** Unverified listings remain contact-only. */
export const NOT_BOOKABLE_CAPTION = 'Not bookable in pickly yet. Contact the venue directly before you go.';

export function markerDescription(claim: VenueClaimStatus): string {
  return `${listingNotice(claim).badge}. ${claim === 'verified' ? 'Rental eligibility and availability checked by the server.' : 'Not bookable in pickly.'}`;
}

export function courtCount(count: number): string {
  return count === 1 ? '1 court' : `${count} courts`;
}

const surfaces: Record<CourtSurface, string> = { hard: 'Hard surface', synthetic: 'Synthetic surface', other: 'Other surface' };

export function courtSummary(court: { surface: CourtSurface | null; is_indoor: boolean; is_covered: boolean }): string {
  const parts = [court.is_indoor ? 'Indoor' : 'Outdoor'];
  if (!court.is_indoor) parts.push(court.is_covered ? 'Covered' : 'Uncovered');
  if (court.surface) parts.push(surfaces[court.surface]);
  return parts.join(' · ');
}

/** Hands navigation to the Maps app; the player's location is never sent by pickly. */
export function directionsLinks(latitude: number, longitude: number): { apple: string; google: string } {
  const destination = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  return {
    apple: `https://maps.apple.com/?${new URLSearchParams({ daddr: destination, dirflg: 'd' }).toString()}`,
    google: `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination }).toString()}`,
  };
}

export function resultsSummary(results: ResultsState): string {
  const count = results.venues.length;
  if (results.status === 'error' && results.failure) return failureMessage(results.failure);
  if (results.status === 'loading') return count === 0 ? 'Searching approved venues in this area…' : 'Updating venues for this area…';
  if (count === 0) return 'No approved venues match this area and filters yet. Move the map or change filters.';
  const found = `${count} approved ${count === 1 ? 'venue' : 'venues'} in this area`;
  if (results.capped) return `${found}. Showing the first ${count}; zoom in to see others.`;
  return results.nextCursor ? `${found} so far. More are available.` : `${found}.`;
}

export function failureMessage(failure: SearchFailure): string {
  switch (failure.kind) {
    case 'network':
      return 'Couldn’t reach the court directory. Check your connection and try again.';
    case 'rate_limited':
      return `Too many searches right now. Try again in ${failure.retryAfterSeconds ?? 1} seconds.`;
    case 'rejected':
      return 'This search couldn’t be completed. Move the map, zoom in or clear filters.';
    case 'not_configured':
      return 'The court directory isn’t set up in this build.';
    case 'unavailable':
      return 'The court directory is unavailable right now. Try again shortly.';
  }
}
