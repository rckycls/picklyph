import { readPageConfig } from '@/lib/config';
import { RegisterForm } from '@/components/register-form';
import { Footer, Hero } from '@/components/site';

export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  // Public browser values only, read per request so no setting is baked into the build.
  let page: ReturnType<typeof readPageConfig> | null = null;
  try { page = readPageConfig(process.env); } catch { page = null; }
  return (
    <>
      <Hero eyebrow="For court owners" title="Put your courts on pickly before launch">
        <p>Pin your venue and leave your details. We’ll email you a code to claim it in the pickly app when it launches. No account needed.</p>
      </Hero>
      <main id="main">
        {page ? <RegisterForm mapsKey={page.mapsBrowserKey} turnstileSiteKey={page.turnstileSiteKey} /> : (
          <section className="card" aria-labelledby="closed"><h2 id="closed">Registration opens soon</h2><p className="hint">Please check back in a little while.</p></section>
        )}
      </main>
      <Footer />
    </>
  );
}
