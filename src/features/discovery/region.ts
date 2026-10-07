import type { MapBounds } from '@picklyph/domain';

import type { MapRegion } from './mapTypes';

export const PHILIPPINES_REGION: MapRegion = {
  latitude: 12.8,
  longitude: 121.8,
  latitudeDelta: 19,
  longitudeDelta: 13,
};

// The API caps each axis at 30 degrees; outward 4-decimal rounding stays below it.
const MAX_SPAN = 29.99;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const down = (value: number) => Math.floor(value * 10_000) / 10_000;
const up = (value: number) => Math.ceil(value * 10_000) / 10_000;

/** Visible map area as T13 bounds. Wider views keep their center; antimeridian views are truncated. */
export function regionToBounds(region: MapRegion): MapBounds | null {
  const values = [region.latitude, region.longitude, region.latitudeDelta, region.longitudeDelta];
  if (!values.every(Number.isFinite)) return null;
  const latitude = clamp(region.latitude, -90, 90);
  const longitude = clamp(region.longitude, -180, 180);
  const latitudeSpan = Math.min(Math.abs(region.latitudeDelta), MAX_SPAN) / 2;
  const longitudeSpan = Math.min(Math.abs(region.longitudeDelta), MAX_SPAN) / 2;
  return {
    south: clamp(down(latitude - latitudeSpan), -90, 90),
    west: clamp(down(longitude - longitudeSpan), -180, 180),
    north: clamp(up(latitude + latitudeSpan), -90, 90),
    east: clamp(up(longitude + longitudeSpan), -180, 180),
  };
}

export function sameBounds(a: MapBounds, b: MapBounds): boolean {
  return a.south === b.south && a.west === b.west && a.north === b.north && a.east === b.east;
}

/**
 * Like venueRegion, but with the camera centre moved south so the selected pin sits in the
 * upper part of the map, clear of the venue card floating over the bottom.
 */
export function selectedVenueRegion(venue: { latitude: number; longitude: number }): MapRegion {
  const region = venueRegion(venue);
  return { ...region, latitude: region.latitude - region.latitudeDelta * 0.22 };
}

export function venueRegion(venue: { latitude: number; longitude: number }): MapRegion {
  return { latitude: venue.latitude, longitude: venue.longitude, latitudeDelta: 0.04, longitudeDelta: 0.04 };
}
