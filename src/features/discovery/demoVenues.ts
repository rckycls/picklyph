import type { Coordinates } from '@/lib/location';

export type DemoVenue = {
  id: string;
  name: string;
  city: string;
  coordinates: Coordinates;
};

// UI fixtures only: illustrative city-area positions, never verified courts or database seed data.
const demoVenues: readonly DemoVenue[] = [
  { id: 'demo-manila', name: 'Demo · Manila', city: 'Metro Manila', coordinates: { latitude: 14.5995, longitude: 120.9842 } },
  { id: 'demo-cebu', name: 'Demo · Cebu', city: 'Cebu City', coordinates: { latitude: 10.3157, longitude: 123.8854 } },
  { id: 'demo-davao', name: 'Demo · Davao', city: 'Davao City', coordinates: { latitude: 7.1907, longitude: 125.4553 } },
];

/** Release bundles never present these fixtures as a directory. */
export function getDemoVenues(development: boolean): readonly DemoVenue[] {
  return development ? demoVenues : [];
}

export const PHILIPPINES_REGION = {
  latitude: 12.8,
  longitude: 121.8,
  latitudeDelta: 19,
  longitudeDelta: 13,
};
