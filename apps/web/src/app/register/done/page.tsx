import type { Metadata } from 'next';
import { Footer, Hero } from '@/components/site';

export const metadata: Metadata = { title: 'pickly · Check your email', robots: { index: false, follow: false } };

export default function DonePage() {
  return (
    <>
      <Hero eyebrow="Registered" title="Check your email" />
      <main id="main">
        <section className="card done" aria-labelledby="done-title">
          <span className="done-mark" aria-hidden="true">✓</span>
          <h2 id="done-title" className="sr-only">Registration received</h2>
          <p>We’ve sent your claim code to the email address you entered. It can take a few minutes; check your spam folder too.</p>
          <ol>
            <li>Keep the email. The code works once, only for this venue.</li>
            <li>When pickly launches, get the app on your iPhone and sign in.</li>
            <li>Open Account and enter the code to claim your venue. After a quick review, it goes live and you can set up hours, prices and bookings.</li>
          </ol>
          <p className="hint" style={{ marginTop: 18 }}>Nothing is published yet. Have another venue? <a href="/register">Register it too</a>.</p>
        </section>
      </main>
      <Footer />
    </>
  );
}
