import { REGISTRATION_RETENTION_DAYS, formatClaimCode } from './prelaunch.ts';

// Server-only email through the provider's HTTP API (Resend's request shape), shared by the registration page
// (T53) and the console (T54b). Import it by path, never through the package index, so the app bundle stays
// without it. The claim code appears in the message body only: never in a log line, an error or the provider's
// idempotency key.

export type EmailSettings = { apiUrl: string; apiKey: string; from: string; replyTo: string };
export type OutgoingEmail = { to: string; subject: string; text: string; html: string; idempotencyKey: string };
export type EmailSender = (email: OutgoingEmail) => Promise<void>;

export class EmailUnavailable extends Error {
  constructor() { super('Email unavailable'); this.name = 'EmailUnavailable'; }
}

export function createEmailSender(settings: EmailSettings | null, fetcher: typeof fetch = fetch, timeoutMs = 8000): EmailSender {
  return async (email) => {
    if (!settings) throw new EmailUnavailable();
    try {
      const response = await fetcher(settings.apiUrl, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': email.idempotencyKey },
        body: JSON.stringify({ from: settings.from, to: [email.to], reply_to: settings.replyTo, subject: email.subject, text: email.text, html: email.html }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new EmailUnavailable();
    } catch { throw new EmailUnavailable(); }
  };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function page(paragraphs: string[]): string {
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#182b48">`
    + `<div style="max-width:520px;margin:0 auto;padding:28px 22px;background:#ffffff">`
    + `<p style="font-size:28px;font-weight:800;color:#1e3f7c;margin:0 0 18px">pickly</p>${paragraphs.join('')}</div></body></html>`;
}
const p = (html: string) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${html}</p>`;

/** The one email with a claim code: the venue, the code, the next steps and how to ask for removal. */
export function registrationEmail(input: { ownerName: string; venueName: string; code: string; contactEmail: string; origin: string }) {
  const code = formatClaimCode(input.code);
  const subject = `Your pickly claim code for ${input.venueName}`;
  const text = [
    `Hi ${input.ownerName},`,
    '',
    `Thanks for registering ${input.venueName} on pickly before launch. Your registration is private: nothing is published yet.`,
    '',
    `Your claim code: ${code}`,
    '',
    'What happens next',
    '1. When pickly launches, get the pickly app on your iPhone.',
    '2. Sign in with Apple or your email address.',
    '3. Open Account and enter this code to claim the venue. You will add a photo that shows you run it, and we will review it before your venue goes live.',
    '',
    `Keep this code private. It works once, and only for ${input.venueName}.`,
    '',
    `Didn't register, or want your details removed? Email ${input.contactEmail} and we will delete them. We erase registrations that are still unclaimed ${REGISTRATION_RETENTION_DAYS} days after this email.`,
    '',
    `Privacy notice: ${input.origin}/privacy`,
    '',
    'pickly',
  ].join('\n');
  const html = page([
    p(`Hi ${escape(input.ownerName)},`),
    p(`Thanks for registering <strong>${escape(input.venueName)}</strong> on pickly before launch. Your registration is private: nothing is published yet.`),
    p('Your claim code:'),
    `<p style="font-size:26px;font-weight:700;letter-spacing:3px;font-family:Menlo,Consolas,monospace;background:#eef4fd;color:#1e3f7c;padding:14px 18px;border-radius:8px;margin:0 0 18px;text-align:center">${escape(code)}</p>`,
    p('<strong>What happens next</strong>'),
    `<ol style="font-size:15px;line-height:1.6;margin:0 0 14px;padding-left:22px"><li>When pickly launches, get the pickly app on your iPhone.</li>`
      + '<li>Sign in with Apple or your email address.</li>'
      + '<li>Open Account and enter this code to claim the venue. You will add a photo that shows you run it, and we will review it before your venue goes live.</li></ol>',
    p(`Keep this code private. It works once, and only for ${escape(input.venueName)}.`),
    p(`Didn't register, or want your details removed? Email <a href="mailto:${escape(input.contactEmail)}">${escape(input.contactEmail)}</a> and we will delete them. We erase registrations that are still unclaimed ${REGISTRATION_RETENTION_DAYS} days after this email.`),
    p(`<a href="${escape(input.origin)}/privacy">Privacy notice</a>`),
  ]);
  return { subject, text, html };
}

/** A fresh code from the console (T54b), usually at launch: the earlier code no longer works. With the App Store link
 * (`appUrl`, set once the app is out) the first step points to it; without it, the owner waits for the launch. */
export function newCodeEmail(input: { ownerName: string; venueName: string; code: string; contactEmail: string; origin: string; appUrl: string | null }) {
  const code = formatClaimCode(input.code);
  const subject = `Your new pickly claim code for ${input.venueName}`;
  const claimStep = 'Open Account, choose Claim with a code and enter this code. You will add a photo that shows you run the venue, and we will review it before your venue goes live.';
  const text = [
    `Hi ${input.ownerName},`,
    '',
    `Here is a new claim code for ${input.venueName}, which you registered on pickly before launch. Your earlier code no longer works.`,
    '',
    `Your claim code: ${code}`,
    '',
    'How to claim your venue',
    `1. ${input.appUrl ? `Get the pickly app on your iPhone: ${input.appUrl}` : 'When pickly launches, get the pickly app on your iPhone.'}`,
    '2. Sign in with Apple or your email address.',
    `3. ${claimStep}`,
    '',
    `Keep this code private. It works once, and only for ${input.venueName}.`,
    '',
    `Didn't register, or want your details removed? Email ${input.contactEmail} and we will delete them. We erase registrations that are still unclaimed ${REGISTRATION_RETENTION_DAYS} days after this email.`,
    '',
    `Privacy notice: ${input.origin}/privacy`,
    '',
    'pickly',
  ].join('\n');
  const html = page([
    p(`Hi ${escape(input.ownerName)},`),
    p(`Here is a new claim code for <strong>${escape(input.venueName)}</strong>, which you registered on pickly before launch. Your earlier code no longer works.`),
    p('Your claim code:'),
    `<p style="font-size:26px;font-weight:700;letter-spacing:3px;font-family:Menlo,Consolas,monospace;background:#eef4fd;color:#1e3f7c;padding:14px 18px;border-radius:8px;margin:0 0 18px;text-align:center">${escape(code)}</p>`,
    p('<strong>How to claim your venue</strong>'),
    `<ol style="font-size:15px;line-height:1.6;margin:0 0 14px;padding-left:22px"><li>${input.appUrl
      ? `<a href="${escape(input.appUrl)}">Get the pickly app</a> on your iPhone.` : 'When pickly launches, get the pickly app on your iPhone.'}</li>`
      + `<li>Sign in with Apple or your email address.</li><li>${claimStep}</li></ol>`,
    p(`Keep this code private. It works once, and only for ${escape(input.venueName)}.`),
    p(`Didn't register, or want your details removed? Email <a href="mailto:${escape(input.contactEmail)}">${escape(input.contactEmail)}</a> and we will delete them. We erase registrations that are still unclaimed ${REGISTRATION_RETENTION_DAYS} days after this email.`),
    p(`<a href="${escape(input.origin)}/privacy">Privacy notice</a>`),
  ]);
  return { subject, text, html };
}

/** Sent instead of a code when the address already has its maximum of open registrations (the page answers the same). */
export function limitEmail(input: { venueName: string; contactEmail: string; origin: string; max: number }) {
  const subject = `We couldn't add ${input.venueName} to pickly`;
  const text = [
    'Hi,',
    '',
    `Someone tried to register ${input.venueName} on pickly with this email address, but it already has ${input.max} registrations waiting to be claimed, so we didn't add another.`,
    '',
    `Claim your venues in the pickly app when it launches, or email ${input.contactEmail} if you need more or want some removed. If this wasn't you, you can ignore this email.`,
    '',
    `Privacy notice: ${input.origin}/privacy`,
    '',
    'pickly',
  ].join('\n');
  const html = page([
    p('Hi,'),
    p(`Someone tried to register <strong>${escape(input.venueName)}</strong> on pickly with this email address, but it already has ${input.max} registrations waiting to be claimed, so we didn't add another.`),
    p(`Claim your venues in the pickly app when it launches, or email <a href="mailto:${escape(input.contactEmail)}">${escape(input.contactEmail)}</a> if you need more or want some removed. If this wasn't you, you can ignore this email.`),
    p(`<a href="${escape(input.origin)}/privacy">Privacy notice</a>`),
  ]);
  return { subject, text, html };
}
