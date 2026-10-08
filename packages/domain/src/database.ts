import type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory.ts';
import type { AccountAccess, PrivilegedRole, Profile } from './authorization.ts';
import type { VenueInput, CourtInput, DirectoryPage, DirectoryListing, DirectoryImportEntry, DirectoryImportResult } from './curation.ts';
import type { DirectoryAuditPage } from './audit.ts';
import type { VenueSearch, VenueSearchPage } from './search.ts';
import type { OwnerDuplicate, OwnerSubmission, OwnerSubmitResult, OwnerVenueInput } from './owner.ts';
import type { OwnershipDecisionResult, OwnershipQueuePage, OwnershipReview, ReviewRejectionReason } from './review.ts';
import type { ModerationQueuePage, ModerationResult, ModerationVenue, ReportReason, RevocationReason, VenueReportRequest, VenueReportResult } from './moderation.ts';
import type { OwnedVenueSummary, OwnerPhotoAddResult, OwnerPhotoRemoveResult, OwnerVenue, OwnerVenueDetails, OwnerVenuePhoto } from './ownerVenues.ts';
import type { ScheduleView, VenueSchedule } from './schedule.ts';
import type { VenuePolicy, VenuePolicyView } from './policy.ts';
import type { SessionCreate, SessionResult, SessionPage } from './session.ts';
import type { SessionBooking, SessionBookingPage, SessionBookingResult, SessionOffer, SessionOfferPage } from './sessionBooking.ts';
import type { AllocationRange, AllocationResult } from './allocation.ts';
import type { CalendarView, CourtHours, CourtHoursView } from './calendar.ts';
import type { RentalBooking, RentalBookingPage, RentalBookingResult, RentalQuote, RentalQuoteVersion } from './rentalBooking.ts';

// Schema-maintained PostgREST contract for the directory, authorization, owner-submission, ownership-review and owner-venue migrations.
// Only the exposed public schema belongs in mobile code. PostGIS geometry is
// opaque transport data; callers use latitude/longitude instead.
type VenueRow = Venue & { location: unknown };
type VenueInsert = Pick<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'> &
  Partial<Omit<Venue, 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'>> & { location?: never };
type CourtInsert = Pick<Court, 'venue_id' | 'name'> & Partial<Omit<Court, 'venue_id' | 'name'>>;
type VenuePhotoRow = OwnerVenuePhoto & { venue_id: string };

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
      // Read-only to every API role (approved venues only); writes go through owner commands.
      venue_photos: {
        Row: VenuePhotoRow;
        Insert: never;
        Update: never;
        Relationships: [{
          foreignKeyName: 'venue_photos_venue_id_fkey';
          columns: ['venue_id'];
          isOneToOne: false;
          referencedRelation: 'venues';
          referencedColumns: ['id'];
        }];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      owner_session_create: { Args: { actor_user_id: string; session_input: SessionCreate }; Returns: SessionResult };
      owner_session_cancel: { Args: { actor_user_id: string; target_session_id: string }; Returns: SessionResult };
      owner_session_read: { Args: { actor_user_id: string; target_venue_id: string; after_id?: string | null }; Returns: SessionPage };
      session_booking_request: { Args: { actor_user_id: string; booking_input: { session_id: string; request_id: string; participants: string[]; expected_total_centavos: number } }; Returns: SessionBookingResult };
      session_walk_in: { Args: { actor_user_id: string; walk_in_input: { session_id: string; request_id: string; participants: string[]; expected_total_centavos: number } }; Returns: SessionBookingResult };
      session_booking_change: { Args: { actor_user_id: string; target_booking_id: string; command: string }; Returns: SessionBookingResult };
      session_booking_read: { Args: { actor_user_id: string; section: string; target_id?: string | null; after_id?: string | null };
        Returns: SessionOfferPage | { at: string; session: SessionOffer } | { booking: SessionBooking } | SessionBookingPage };
      rental_booking_quote: { Args: { actor_user_id: string; target_court_id: string; starts: string; ends: string }; Returns: RentalQuote };
      rental_booking_request: { Args: { actor_user_id: string; target_court_id: string; request_id: string; starts: string; ends: string; expected_quote: RentalQuoteVersion }; Returns: RentalBookingResult };
      rental_booking_owner_entry: { Args: { actor_user_id: string; target_court_id: string; request_id: string; starts: string; ends: string; guest_name: string; expected_quote: RentalQuoteVersion }; Returns: RentalBookingResult };
      booking_operation: { Args: { actor_user_id: string; target_kind: 'rental' | 'session'; target_booking_id: string; command: string; method?: string | null; amount?: number | null };
        Returns: RentalBookingResult | SessionBookingResult };
      booking_operations_read: { Args: { actor_user_id: string; target_kind: 'rental' | 'session'; target_venue_id: string; target_day: string; after_id?: string | null };
        Returns: { venue_id: string; date: string; at: string; bookings: RentalBooking[] | SessionBooking[]; next_cursor: string | null } };
      rental_booking_change: { Args: { actor_user_id: string; target_booking_id: string; command: string }; Returns: RentalBookingResult };
      rental_booking_read: { Args: { actor_user_id: string; target_booking_id?: string | null; target_venue_id?: string | null; after_id?: string | null }; Returns: RentalBookingPage | { booking: RentalBooking } };
      venues_in_bounds: { Args: MapBounds; Returns: VenueMapPin[] };
      directory_search: { Args: { search: VenueSearch }; Returns: VenueSearchPage };
      my_account_access: { Args: Record<PropertyKey, never>; Returns: AccountAccess[] };
      directory_admin_read: { Args: { actor_user_id: string; target_venue_id?: string | null; after_id?: string | null }; Returns: DirectoryPage };
      directory_admin_save: { Args: { actor_user_id: string; target_venue_id: string | null; expected_updated_at: string | null; venue_input: VenueInput; court_inputs: CourtInput[] }; Returns: DirectoryListing };
      directory_admin_publish: { Args: { actor_user_id: string; target_venue_id: string; expected_updated_at: string; new_status: VenuePublicationStatus }; Returns: DirectoryListing };
      directory_admin_import: { Args: { actor_user_id: string; listings: DirectoryImportEntry[] }; Returns: DirectoryImportResult[] };
      directory_admin_audit_read: { Args: { actor_user_id: string; target_venue_id?: string | null; after_id?: string | null }; Returns: DirectoryAuditPage };
      my_owner_submissions: { Args: Record<PropertyKey, never>; Returns: OwnerSubmission[] };
      // Server-only execute grants. Having a type does not grant mobile access.
      owner_duplicate_candidates: {
        Args: { actor_user_id: string; latitude: number; longitude: number; proposed_name: string | null };
        Returns: OwnerDuplicate[];
      };
      owner_submit_claim: {
        Args: { actor_user_id: string; submission_request_id: string; target_venue_id: string; evidence_ref: string; claim_note: string | null };
        Returns: OwnerSubmitResult;
      };
      owner_submit_venue: {
        Args: { actor_user_id: string; submission_request_id: string; venue_input: OwnerVenueInput; evidence_ref: string; submission_note: string | null; acknowledge_duplicates: boolean };
        Returns: OwnerSubmitResult;
      };
      ownership_review_queue: {
        Args: { actor_user_id: string; after_created_at?: string | null; after_id?: string | null };
        Returns: OwnershipQueuePage;
      };
      ownership_review_read: { Args: { actor_user_id: string; subject_id: string }; Returns: OwnershipReview };
      ownership_review_evidence: { Args: { actor_user_id: string; subject_id: string }; Returns: string };
      ownership_review_decide: {
        Args: { actor_user_id: string; subject_id: string; decision: string; target_venue_id: string | null; rejection_reason: ReviewRejectionReason | null };
        Returns: OwnershipDecisionResult;
      };
      owner_venue_list: { Args: { actor_user_id: string }; Returns: OwnedVenueSummary[] };
      owner_venue_policy_read: { Args: { actor_user_id: string; target_venue_id: string }; Returns: VenuePolicyView };
      owner_venue_policy_save: { Args: { actor_user_id: string; target_venue_id: string; expected_revision: string; policy_input: VenuePolicy }; Returns: VenuePolicyView };
      venue_schedule_read: { Args: { actor_user_id: string; target_venue_id: string; start_date: string; days: number }; Returns: ScheduleView };
      venue_schedule_save: { Args: { actor_user_id: string; target_venue_id: string; expected_revision: string | null; schedule_input: VenueSchedule }; Returns: ScheduleView };
      court_allocation_block: {
        Args: { actor_user_id: string; target_court_id: string; block_request_id: string; block_starts_at: string; block_ends_at: string };
        Returns: AllocationResult;
      };
      court_allocation_release: { Args: { actor_user_id: string; target_allocation_id: string }; Returns: AllocationResult };
      court_allocation_read: { Args: { actor_user_id: string; target_venue_id: string; range_start: string; range_end: string }; Returns: AllocationRange };
      court_hours_save: { Args: { actor_user_id: string; target_court_id: string; expected_revision: string | null; hours_input: CourtHours }; Returns: CourtHoursView };
      owner_calendar_read: { Args: { actor_user_id: string; target_venue_id: string; start_date: string; days: number }; Returns: CalendarView };
      owner_venue_read: { Args: { actor_user_id: string; target_venue_id: string }; Returns: OwnerVenue };
      owner_venue_save: {
        Args: { actor_user_id: string; target_venue_id: string; expected_updated_at: string; venue_input: OwnerVenueDetails; court_inputs: CourtInput[] };
        Returns: OwnerVenue;
      };
      owner_venue_photo_add: {
        Args: { actor_user_id: string; target_venue_id: string; photo_request_id: string; storage_ref: string; photo_width: number; photo_height: number };
        Returns: OwnerPhotoAddResult;
      };
      owner_venue_photo_remove: {
        Args: { actor_user_id: string; target_venue_id: string; target_photo_id: string };
        Returns: OwnerPhotoRemoveResult;
      };
      set_account_role: {
        Args: { actor_user_id: string; target_user_id: string; assigned_role: PrivilegedRole; enabled: boolean };
        Returns: undefined;
      };
      // T46 moderation: reports from verified players; queue/read/decide/revoke for current admins/moderators.
      venue_report_submit: { Args: { actor_user_id: string; report_input: VenueReportRequest }; Returns: VenueReportResult };
      moderation_queue: {
        Args: { actor_user_id: string; after_created_at?: string | null; after_id?: string | null };
        Returns: ModerationQueuePage;
      };
      moderation_venue_read: { Args: { actor_user_id: string; target_venue_id: string }; Returns: ModerationVenue };
      moderation_decide: {
        Args: { actor_user_id: string; target_venue_id: string; decision: string; reason: ReportReason | null; report_ids: string[] };
        Returns: ModerationResult;
      };
      ownership_revoke: {
        Args: { actor_user_id: string; target_venue_id: string; owner_user_id: string; reason: RevocationReason };
        Returns: ModerationResult;
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
