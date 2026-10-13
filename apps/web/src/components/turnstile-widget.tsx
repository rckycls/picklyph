'use client';

import { useEffect, useRef, useState } from 'react';

// Cloudflare Turnstile, rendered explicitly. Each token works once, so the form bumps `resetKey` after every
// answer from the server and the widget issues a fresh one.
type TurnstileApi = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};
type TurnstileWindow = Window & { turnstile?: TurnstileApi };

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const scope = window as TurnstileWindow;
  if (scope.turnstile) return Promise.resolve(scope.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = () => (scope.turnstile ? resolve(scope.turnstile) : reject(new Error('Turnstile unavailable')));
    script.onerror = () => { loading = null; script.remove(); reject(new Error('Turnstile unavailable')); };
    document.head.appendChild(script);
  });
  return loading;
}

export function TurnstileWidget({ siteKey, resetKey, onToken }: { siteKey: string; resetKey: number; onToken: (token: string | null) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const report = useRef(onToken);
  const [failed, setFailed] = useState(false);

  useEffect(() => { report.current = onToken; });

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then((turnstile) => {
      if (cancelled || !element.current) return;
      widget.current = turnstile.render(element.current, {
        sitekey: siteKey, action: 'register', theme: 'light', size: 'flexible', appearance: 'always',
        callback: (token: string) => report.current(token),
        'expired-callback': () => report.current(null),
        'error-callback': () => { report.current(null); },
      });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      const scope = window as TurnstileWindow;
      if (widget.current && scope.turnstile) scope.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    const scope = window as TurnstileWindow;
    if (resetKey === 0 || !widget.current || !scope.turnstile) return;
    report.current(null);
    scope.turnstile.reset(widget.current);
  }, [resetKey]);

  return (
    <div className="turnstile">
      <div ref={element} />
      {failed && <p className="alert" role="alert">The security check couldn’t load. Check your connection and reload the page.</p>}
    </div>
  );
}
