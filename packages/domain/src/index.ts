/** Shared market identity; booking contracts will be added with their features. */
export const market = {
  country: 'Philippines',
  countryCode: 'PH',
} as const;

export type { Database } from './database';
export { DirectoryInputError, MAX_DIRECTORY_COURTS, MAX_DIRECTORY_IMPORT, directoryUuid, readVenueInput, readCourtInputs, readDirectorySave, readDirectoryPublication, readDirectoryImport } from './curation';
export type { VenueInput, CourtInput, DirectoryListing, DirectoryPage, DirectorySave, DirectoryImportEntry, DirectoryImportResult } from './curation';
export type { AccountAccess, PrivilegedRole, Profile } from './authorization';
export { PHP_CURRENCY, CENTAVOS_PER_PESO, isPhpCentavos, assertPhpCentavos, pesosToCentavos, formatPhpCentavos } from './money';
export { MANILA_TIME_ZONE, RENTAL_INCREMENT_MINUTES, MINIMUM_RENTAL_MINUTES, BOOKING_HORIZON_DAYS, toUtcIso, toManilaDateTime, fromManilaDateTime, formatManilaDateTime, validateRentalWindow } from './booking';
export type { Instant, ManilaDateTime, RentalValidation } from './booking';
export type { Court, CourtStatus, CourtSurface, MapBounds, Venue, VenueClaimStatus, VenueMapPin, VenuePublicationStatus } from './directory';
