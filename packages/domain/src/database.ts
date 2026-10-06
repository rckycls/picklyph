import type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory';

// Schema-maintained PostgREST contract for migration 20261006030000_directory.
// Only the exposed public schema belongs in mobile code. PostGIS geometry is
// opaque transport data; callers use latitude/longitude instead.
type VenueRow = Venue & { location: unknown };
type VenueInsert = Pick<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'> &
  Partial<Omit<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'>> & { location?: never };
type CourtInsert = Pick<Court, 'venue_id' | 'name'> & Partial<Omit<Court, 'venue_id' | 'name'>>;

export interface Database {
  public: {
    Tables: {
      venues: {
        Row: VenueRow;
        Insert: VenueInsert;
        Update: Partial<VenueInsert>;
        Relationships: [];
      };
      courts: {
        Row: Court;
        Insert: CourtInsert;
        Update: Partial<CourtInsert>;
        Relationships: [{
          foreignKeyName: 'courts_venue_id_fkey';
          columns: ['venue_id'];
          isOneToOne: false;
          referencedRelation: 'venues';
          referencedColumns: ['id'];
        }];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      venues_in_bounds: { Args: MapBounds; Returns: VenueMapPin[] };
    };
    Enums: {
      venue_publication_status: VenuePublicationStatus;
      venue_claim_status: VenueClaimStatus;
      court_status: CourtStatus;
      court_surface: CourtSurface;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
