/* eslint-disable @next/next/no-img-element */
// Shared header and footer for the public pages (Concept C: court blue, ball yellow, lowercase wordmark).
export function Hero({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="hero">
      <span className="hero-ball" aria-hidden="true" />
      <div className="hero-inner">
        <a className="wordmark" href="/register" aria-label="pickly, register your courts"><img src="/mark-white.svg" alt="" /><span>pickly</span></a>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children}
      </div>
    </header>
  );
}

export function Footer() {
  return <footer className="footer"><a href="/privacy">Privacy notice</a> · pickly, pickleball courts across the Philippines</footer>;
}
