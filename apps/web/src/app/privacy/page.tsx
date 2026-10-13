import type { Metadata } from 'next';
import { CLAIMED_REGISTRATION_RETENTION_DAYS, MAX_OPEN_REGISTRATIONS_PER_EMAIL, REGISTRATION_RETENTION_DAYS } from '@picklyph/domain';
import { readContactAddress } from '@/lib/config';
import { Footer, Hero } from '@/components/site';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'pickly · Privacy notice for court registration' };

export default function PrivacyPage() {
  let contact: string | null = null;
  try { contact = readContactAddress(process.env); } catch { contact = null; }
  const email = contact ? <a href={`mailto:${contact}`}>{contact}</a> : 'the address in your claim-code email';
  return (
    <>
      <Hero eyebrow="Privacy notice" title="How we handle your registration" />
      <main id="main">
        <article className="card prose">
          <p className="hint">Pre-launch court registration · Last updated 13 October 2026</p>
          <p>pickly (PicklyPH) processes the personal information you give on this page in line with the Data Privacy Act of 2012
            (Republic Act No. 10173), its implementing rules and the issuances of the National Privacy Commission.</p>

          <h2>What we collect</h2>
          <ul>
            <li>About you: your name, email address, mobile number if you give one, and your role at the venue (owner, manager or staff).</li>
            <li>About the venue: its name, address, city, province, the map pin you place, the number of courts and whether they are indoor, covered or of a particular surface.</li>
            <li>Your optional note, and the time you agreed to this notice.</li>
            <li>To stop abuse, we check your connection with Cloudflare Turnstile and count requests per IP address and per email address. These counts use keyed codes, not your IP or email, and expire within an hour. We don’t store your IP address with your registration.</li>
          </ul>

          <h2>Why we use it</h2>
          <p>With your consent, we use it to set up a private draft listing of your venue, email you a single-use claim code, contact you about
            your registration and, when the app launches, let you claim the venue in the pickly app. We use the abuse checks to keep the page
            available and free of spam. You can withdraw your consent at any time by asking us to delete your registration.</p>

          <h2>Who can see it</h2>
          <p>Your registration is not public. Players see nothing about it, and the venue appears in the app only after you claim it, show that
            you run it, and we review it. pickly administrators can see your details. Service providers process them for us under their own
            security terms: our database host (Supabase), this page’s host (Vercel), our email provider, Cloudflare (Turnstile), Google (the map
            and address search) and Upstash (request counts). We don’t sell your information. When someone claims the venue in the app with
            your code, the pickly reviewers who check the claim see your role at the venue and whether the claiming account uses the same email
            address; only administrators see your name, email, mobile number and note.</p>

          <h2>How long we keep it</h2>
          <p>Until you claim your venue in the app and we review the claim. The claim code stops working once it is used. We erase your name,
            email, mobile number and note {CLAIMED_REGISTRATION_RETENTION_DAYS} days after we decide the claim, or straight away if the account
            that claimed it is deleted before then. If it is still unclaimed {REGISTRATION_RETENTION_DAYS} days after we email your claim code, we
            erase your name, email, mobile number, note and the claim code, and retire the draft listing. The venue details may remain in a
            retired listing without anything about you. One email address can hold up to {MAX_OPEN_REGISTRATIONS_PER_EMAIL} unclaimed registrations.</p>

          <h2>How we protect it</h2>
          <p>Registrations are kept in a private database that only our servers can reach. We store the claim code only as a keyed hash, so
            even we can’t read it back. This page sets no cookies and uses no tracking. Cloudflare and Google handle the data they receive
            under their own privacy policies.</p>

          <h2>Your rights and how to ask for removal</h2>
          <p>Under the Data Privacy Act you have the right to be informed, to access, to object, to correct, to have your information erased or
            blocked, to data portability, and to damages. To see, correct or delete your registration, email {email} from the address you
            registered with and name the venue. If you believe we have mishandled your information, you can complain
            to the National Privacy Commission (privacy.gov.ph).</p>

          <p className="hint" style={{ marginTop: 22 }}><a href="/register">Back to registration</a></p>
        </article>
      </main>
      <Footer />
    </>
  );
}
