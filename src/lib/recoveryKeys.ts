/**
 * Device-only recovery journals (T25 rentals, T27 sessions, T29 walk-ins, T30 groups, T31 outside rentals) live under
 * a backend + verified-account namespace. Sign-out keeps them so an uncertain request stays retryable; account
 * deletion (T47) removes every one of them once the server confirms the account is gone.
 */
export const ACCOUNT_RECOVERY_SUFFIXES = ['rental-attempt', 'group-attempt', 'session-attempt', 'walk-in-attempt', 'owner-entry-attempt'] as const;

/** Rental recovery keeps its original first-label form, so recoveries saved by earlier builds stay readable. */
export function rentalRecoveryNamespace(backendUrl: string, actor: string): string {
  return `pickly.${new URL(backendUrl).hostname.split('.')[0]}.${actor}`;
}

export function recoveryNamespace(backendUrl: string, actor: string): string {
  return `pickly.${new URL(backendUrl).host.replace(/[^a-z0-9.-]/gi, '_')}.${actor}`;
}

/** Every key the account's journals could have written on this device (both namespace forms, every journal). */
export function accountRecoveryKeys(backendUrl: string, actor: string): string[] {
  const spaces = [...new Set([rentalRecoveryNamespace(backendUrl, actor), recoveryNamespace(backendUrl, actor)])];
  return spaces.flatMap((space) => ACCOUNT_RECOVERY_SUFFIXES.map((suffix) => `${space}.${suffix}`));
}

/** Removes them all; throws after trying every key if any removal failed. */
export async function clearAccountRecovery(store: { remove: (key: string) => Promise<void> }, backendUrl: string, actor: string): Promise<void> {
  const results = await Promise.allSettled(accountRecoveryKeys(backendUrl, actor).map((key) => store.remove(key)));
  if (results.some((result) => result.status === 'rejected')) throw new Error('Some saved requests could not be removed from this phone.');
}
