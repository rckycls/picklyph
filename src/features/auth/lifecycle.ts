import type { Session, SupabaseClient } from '@supabase/supabase-js';

export type AuthState = {
  status: 'restoring' | 'ready' | 'error';
  session: Session | null;
  message: string | null;
  canClear?: boolean;
};
type AuthPort = Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange' | 'startAutoRefresh' | 'stopAutoRefresh'>;
type AppPort = {
  currentState: string | null;
  subscribe: (callback: (state: string) => void) => () => void;
};

/** Subscribe before restoring; an older read must never resurrect a signed-out session. */
export function watchSession(auth: AuthPort, app: AppPort, notify: (state: AuthState) => void, timeoutMs = 12000) {
  let alive = true;
  let revision = 0;
  let foreground = app.currentState === 'active';
  const refresh = () => {
    if (!alive) return;
    void (foreground ? auth.startAutoRefresh() : auth.stopAutoRefresh()).catch(() => undefined);
  };
  const { data: { subscription } } = auth.onAuthStateChange((event, session) => {
    if (!alive || event === 'INITIAL_SESSION') return;
    revision++;
    notify({ status: 'ready', session, message: null });
  });
  const unsubscribeApp = app.subscribe((state) => { foreground = state === 'active'; refresh(); });
  const originalRevision = revision;
  const timer = setTimeout(() => {
    if (alive && revision === originalRevision) {
      notify({ status: 'error', session: null, message: 'Session restoration is taking too long. Retry when connected.' });
    }
  }, timeoutMs);
  refresh();
  void auth.getSession().then(({ data, error }) => {
    if (!alive) return;
    clearTimeout(timer);
    refresh();
    if (revision !== originalRevision) return;
    notify(error
      ? { status: 'error', session: null, canClear: true, message: 'We couldn’t restore your session. Retry or clear the saved sign-in.' }
      : { status: 'ready', session: data.session, message: null });
  }).catch(() => {
    clearTimeout(timer);
    if (alive && revision === originalRevision) {
      notify({ status: 'error', session: null, canClear: true, message: 'We couldn’t restore your session. Retry or clear the saved sign-in.' });
    }
  });
  return () => {
    alive = false;
    clearTimeout(timer);
    unsubscribeApp();
    subscription.unsubscribe();
    void auth.stopAutoRefresh().catch(() => undefined);
  };
}
