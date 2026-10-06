export type VenuePublicationStatus = 'draft' | 'approved' | 'suspended';
export type VenueClaimStatus = 'unclaimed' | 'pending' | 'verified';
export type CourtStatus = 'active' | 'inactive';
export type CourtSurface = 'hard' | 'synthetic' | 'other';

/** Public directory data; a verified claim alone never implies bookability. */
export type Venue = {
  id: string;
  name: string;
  address_line: string;
  city: string;
  province: string;
  country_code: 'PH';
  latitude: number;
  longitude: number;
  publication_status: VenuePublicationStatus;
  claim_status: VenueClaimStatus;
  created_at: string;
  updated_at: string;
};

export type Court = {
  id: string;
  venue_id: string;
  name: string;
  surface: CourtSurface | null;
  is_indoor: boolean;
  is_covered: boolean;
  status: CourtStatus;
  created_at: string;
  updated_at: string;
};

export type MapBounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type VenueMapPin = Pick<Venue, 'id' | 'name' | 'city' | 'province' | 'latitude' | 'longitude' | 'claim_status'>;
