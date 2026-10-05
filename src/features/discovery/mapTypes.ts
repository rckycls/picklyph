import type { Coordinates } from '@/lib/location';

import type { DemoVenue } from './demoVenues';

export type MapRegion = Coordinates & { latitudeDelta: number; longitudeDelta: number };

export type CourtMapProps = {
  venues: readonly DemoVenue[];
  selectedId?: string;
  focusRegion: MapRegion;
  showUserLocation: boolean;
  onSelect: (venue: DemoVenue) => void;
  onReadyChange: (ready: boolean) => void;
};
