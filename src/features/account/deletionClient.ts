import { ACCOUNT_DELETION_CONFIRMATION, readAccountDeletionRequest, type AccountDeletionResult } from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

// Pure client for the account-deletion Edge function (T47), so Node tests drive it against the real handler.
export const DELETION_REJECTIONS = ['invalid_request', 'privileged_account'] as const;
export type DeletionFailure = HttpFailure<typeof DELETION_REJECTIONS[number]>;
export type DeletionOutcome = HttpOutcome<AccountDeletionResult, typeof DELETION_REJECTIONS[number]>;

/** The word typed to confirm, ignoring case and surrounding spaces. */
export const CONFIRM_WORD = 'DELETE';
export const confirmationTyped = (text: string) => text.trim().toUpperCase() === CONFIRM_WORD;

/** Retry-safe: the server resumes a partial deletion, and confirms one that finished before a reply was lost. */
export function deleteAccount(transport: OwnerHttpTransport): Promise<DeletionOutcome> {
  const body = readAccountDeletionRequest({ confirm: ACCOUNT_DELETION_CONFIRMATION });
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    (raw) => {
      if (raw.status !== 'deleted' || Object.keys(raw).length !== 1) throw new Error('Unexpected deletion response.');
      return { status: 'deleted' as const };
    }, DELETION_REJECTIONS);
}

export function deletionFailureMessage(f: DeletionFailure): string {
  if (f.kind === 'rejected') return f.reason === 'privileged_account'
    ? 'This account has a pickly console role. Ask another pickly administrator to remove it, then delete your account.'
    : 'Something went wrong with this request. Close this screen and try again.';
  if (f.kind === 'rate_limited') return `Too many attempts. Try again in ${f.retryAfterSeconds} seconds.`;
  if (f.kind === 'sign_in') return 'Sign in again, then delete your account.';
  if (f.kind === 'not_configured') return 'Account deletion isn’t configured in this build.';
  return 'Couldn’t confirm your account was deleted. Check your connection and try again; trying again is safe.';
}
