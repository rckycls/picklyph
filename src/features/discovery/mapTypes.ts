import type { VenueSearchItem } from '@picklyph/domain';

import type { Coordinates } from '@/lib/location';

export type MapRegion = Coordinates & { latitudeDelta: number; longitudeDelta: number };

export type CourtMapProps = {
  venues: readonly VenueSearchItem[];
  selectedId?: string;
  focusRegion: MapRegion;
  showUserLocation: boolean;
  onSelect: (venue: VenueSearchItem) => void;
  /** Settled camera region after a gesture or animation. */
  onRegionChange: (region: MapRegion) => void;
  onReadyChange: (ready: boolean) => void;
};
