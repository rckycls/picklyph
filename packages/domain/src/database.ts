import type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory';
import type { AccountAccess, PrivilegedRole, Profile } from './authorization';

// Schema-maintained PostgREST contract for directory + T08 authorization migrations.
// Only the exposed public schema belongs in mobile code. PostGIS geometry is
// opaque transport data; callers use latitude/longitude instead.
type VenueRow = Venue & { location: unknown };
type VenueInsert = Pick<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'> &
  Partial<Omit<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'>> & { location?: never };
type CourtInsert = Pick<Court, 'venue_id' | 'name'> & Partial<Omit<Court, 'venue_id' | 'name'>>;

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Pick<Profile, 'id'> & Partial<Omit<Profile, 'id'>>;
        Update: Partial<Omit<Profile, 'id'>>;
        Relationships: [];
      };
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
      my_account_access: { Args: Record<PropertyKey, never>; Returns: AccountAccess[] };
      // Server-only execute grants. Having a type does not grant mobile access.
      set_account_role: {
        Args: { actor_user_id: string; target_user_id: string; assigned_role: PrivilegedRole; enabled: boolean };
        Returns: undefined;
      };
      set_verified_venue_owner: {
        Args: { actor_user_id: string; target_venue_id: string; owner_user_id: string; enabled: boolean };
        Returns: undefined;
      };
      authorize_venue_management: {
        Args: { actor_user_id: string; target_venue_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      privileged_role: PrivilegedRole;
      venue_publication_status: VenuePublicationStatus;
      venue_claim_status: VenueClaimStatus;
      court_status: CourtStatus;
      court_surface: CourtSurface;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
