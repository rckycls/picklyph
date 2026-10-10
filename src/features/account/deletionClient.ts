import { ACCOUNT_DELETION_CONFIRMATION, APPLE_DELETION_REJECTIONS, readAccountDeletionRequest, type AccountDeletionResult } from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

// Pure client for the account-deletion Edge function (T47), so Node tests drive it against the real handler.
export const DELETION_REJECTIONS = ['invalid_request', 'privileged_account', ...APPLE_DELETION_REJECTIONS] as const;
export type DeletionFailure = HttpFailure<typeof DELETION_REJECTIONS[number]>;
export type DeletionOutcome = HttpOutcome<AccountDeletionResult, typeof DELETION_REJECTIONS[number]>;

/** The word typed to confirm, ignoring case and surrounding spaces. */
export const CONFIRM_WORD = 'DELETE';
export const confirmationTyped = (text: string) => text.trim().toUpperCase() === CONFIRM_WORD;

/** Retry-safe: the server resumes a partial deletion, and confirms one that finished before a reply was lost. */
export function deleteAccount(transport: OwnerHttpTransport, appleCode?: string): Promise<DeletionOutcome> {
  const body = readAccountDeletionRequest(appleCode === undefined ? { confirm: ACCOUNT_DELETION_CONFIRMATION }
    : { confirm: ACCOUNT_DELETION_CONFIRMATION, apple_authorization_code: appleCode });
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    (raw) => {
      if (raw.status !== 'deleted' || Object.keys(raw).length !== 1) throw new Error('Unexpected deletion response.');
      return { status: 'deleted' as const };
    }, DELETION_REJECTIONS);
}

type SessionUser = { identities?: { provider: string }[] | null; app_metadata?: { provider?: unknown; providers?: unknown } } | null | undefined;
/** T50a: whether this account signs in with Apple, so the phone asks Apple first. The server decides from Auth itself. */
export function usesAppleSignIn(user: SessionUser): boolean {
  if (!user) return false;
  const providers = user.app_metadata?.providers;
  return (user.identities ?? []).some((identity) => identity.provider === 'apple') || user.app_metadata?.provider === 'apple'
    || (Array.isArray(providers) && providers.includes('apple'));
}

/** A fresh Apple authorization code; `null` when the person closes Apple's sheet. */
export type AppleCodeSource = () => Promise<string | null>;
export type AppleStepFailure = { ok: false; apple: 'cancelled' | 'failed' };
export type DeletionAttempt = DeletionOutcome | AppleStepFailure;

/**
 * One tap of Delete (T50a). An Apple-linked account confirms with Apple first. If the server still asks (it found an Apple
 * identity the phone didn't know about, or Apple refused the code as used or expired), Apple is asked once more. The code
 * goes only into this request: it is never saved on the phone.
 */
export async function deleteAccountConfirmed(transport: OwnerHttpTransport, appleLinked: boolean, appleCode: AppleCodeSource): Promise<DeletionAttempt> {
  const ask = async (): Promise<string | AppleStepFailure> => {
    let code: string | null;
    try { code = await appleCode(); } catch { return { ok: false, apple: 'failed' }; }
    if (code === null) return { ok: false, apple: 'cancelled' };
    try { readAccountDeletionRequest({ confirm: ACCOUNT_DELETION_CONFIRMATION, apple_authorization_code: code }); }
    catch { return { ok: false, apple: 'failed' }; }
    return code;
  };
  let code: string | undefined;
  if (appleLinked) {
    const asked = await ask();
    if (typeof asked !== 'string') return asked;
    code = asked;
  }
  const first = await deleteAccount(transport, code);
  if (first.ok || first.failure.kind !== 'rejected' || first.failure.reason !== 'apple_reauthorization_required') return first;
  const again = await ask();
  if (typeof again !== 'string') return again;
  return deleteAccount(transport, again);
}

export function deletionFailureMessage(f: DeletionFailure): string {
  if (f.kind === 'rejected') {
    if (f.reason === 'privileged_account') return 'This account has a pickly console role. Ask another pickly administrator to remove it, then delete your account.';
    if (f.reason === 'apple_reauthorization_required') return 'Apple didn’t confirm this request, so nothing was deleted. Try again and continue with Apple when it asks.';
    if (f.reason === 'apple_account_mismatch') return 'That Apple ID isn’t the one this pickly account uses, so nothing was deleted. Try again with the Apple ID you sign in with.';
    return 'Something went wrong with this request. Close this screen and try again.';
  }
  if (f.kind === 'rate_limited') return `Too many attempts. Try again in ${f.retryAfterSeconds} seconds.`;
  if (f.kind === 'sign_in') return 'Sign in again, then delete your account.';
  if (f.kind === 'not_configured') return 'Account deletion isn’t configured in this build.';
  return 'Couldn’t confirm your account was deleted. Check your connection and try again; trying again is safe.';
}

export function deletionAttemptMessage(attempt: Exclude<DeletionAttempt, { ok: true }>): string {
  if ('apple' in attempt) return attempt.apple === 'cancelled'
    ? 'Nothing was deleted. Your account uses Sign in with Apple, so continue with Apple to delete it.'
    : 'Apple sign-in didn’t complete, so nothing was deleted. Try again.';
  return deletionFailureMessage(attempt.failure);
}
