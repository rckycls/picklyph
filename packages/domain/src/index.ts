/** Shared market identity; booking contracts will be added with their features. */
export const market = {
  country: 'Philippines',
  countryCode: 'PH',
} as const;

export type { Database } from './database';
export { readPolicySave } from './policy';
export type { VenuePolicy, VenuePolicyView, VenuePolicySave } from './policy';
export { MAX_SEARCH_PAGE, SearchInputError, readVenueSearch } from './search';
export type { VenueSearch, VenueSearchItem, VenueSearchPage } from './search';
export type { DirectoryAuditAction, DirectoryAuditEvent, DirectoryAuditPage } from './audit';
export { DirectoryInputError, MAX_DIRECTORY_COURTS, MAX_DIRECTORY_IMPORT, directoryUuid, readVenueInput, readCourtInputs, readDirectorySave, readDirectoryPublication, readDirectoryImport } from './curation';
export type { VenueInput, CourtInput, DirectoryListing, DirectoryPage, DirectorySave, DirectoryImportEntry, DirectoryImportResult } from './curation';
export type { AccountAccess, PrivilegedRole, Profile } from './authorization';
export { DUPLICATE_RADIUS_METERS, MAX_EVIDENCE_BYTES, MAX_OWNER_NOTE, MAX_PENDING_OWNER_SUBMISSIONS, MAX_SUBMISSION_COURTS, OwnerInputError, SUBMISSION_BOUNDS, inSubmissionBounds, isUuid, readOwnerLookup, readOwnerNote, readOwnerSubmission, readOwnerVenueInput, sniffEvidence } from './owner';
export type { AddressCandidate, EvidenceType, OwnerClaimRequest, OwnerDuplicate, OwnerLookup, OwnerSubmission, OwnerSubmissionRequest, OwnerSubmissionStatus, OwnerSubmitResult, OwnerVenueInput, OwnerVenueRequest } from './owner';
export { MAX_OWNER_COURTS, MAX_PHOTO_BYTES, MAX_PHOTO_PIXELS, MAX_PHOTO_SIDE, MAX_VENUE_PHOTOS, MIN_PHOTO_SIDE, VENUE_PHOTO_BUCKET, VenueInputError, photoDimensionsAllowed, readOwnerCourts, readOwnerPhotoAdd, readOwnerText, readOwnerVenueCommand, readOwnerVenueDetails, readOwnerVenueQuery } from './ownerVenues';
export type { OwnedVenueSummary, OwnerPhotoAdd, OwnerPhotoAddResult, OwnerPhotoRemove, OwnerPhotoRemoveResult, OwnerVenue, OwnerVenueCommand, OwnerVenueDetails, OwnerVenuePhoto, OwnerVenueSave, PhotoType } from './ownerVenues';
export { REVIEW_REASON_LABELS, REVIEW_REJECTION_REASONS, ReviewInputError, formatReviewCursor, readOwnershipDecision, readReviewCursor } from './review';
export type { ClaimReview, OwnershipDecision, OwnershipDecisionResult, OwnershipQueueItem, OwnershipQueuePage, OwnershipReview, ReviewCursor, ReviewOutcome, ReviewRejectionReason, ReviewSubmitter, VenueSubmissionReview } from './review';
export { PHP_CURRENCY, CENTAVOS_PER_PESO, isPhpCentavos, assertPhpCentavos, pesosToCentavos, formatPhpCentavos } from './money';
export { MANILA_TIME_ZONE, RENTAL_INCREMENT_MINUTES, MINIMUM_RENTAL_MINUTES, BOOKING_HORIZON_DAYS, toUtcIso, toManilaDateTime, fromManilaDateTime, formatManilaDateTime, validateRentalWindow } from './booking';
export type { Instant, ManilaDateTime, RentalValidation } from './booking';
export { ScheduleInputError, scheduleDate, readVenueSchedule, resolveVenueSchedule, readScheduleSave, readScheduleQuery } from './schedule';
export type { RateBand, OpeningWindow, ScheduleException, VenueSchedule, ScheduleInterval, ScheduleView, ScheduleSave } from './schedule';
export { ALLOCATION_INCREMENT_MINUTES, MAX_ALLOCATION_MINUTES, MAX_HOLD_MINUTES, MAX_ALLOCATION_RANGE_DAYS, AllocationInputError, readAllocationBlock, readAllocationRangeQuery, allocationsOverlap, isLiveAllocation, holdUntil } from './allocation';
export type { AllocationKind, AllocationState, CourtAllocation, AllocationOutcome, AllocationResult, AllocationRange, AllocationBlock, AllocationRangeQuery, AllocationRejection } from './allocation';
export type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory';
