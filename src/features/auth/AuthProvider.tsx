import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { clearSavedSession, getSupabase } from '@/lib/supabase';

import { requestEmailCode, signInApple, verifyEmailCode } from './actions';
import { applePort } from './apple';
import { watchSession, type AuthState } from './lifecycle';

type AuthContextValue = AuthState & {
  busy: boolean;
  retry: () => void;
  clearSaved: () => Promise<void>;
  requestCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signInApple: () => Promise<void>;
  signOut: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'restoring', session: null, message: null });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        cleanup = watchSession(getSupabase().auth, {
          currentState: AppState.currentState,
          subscribe: (callback) => {
            const listener = AppState.addEventListener('change', callback);
            return () => listener.remove();
          },
        }, setState);
      } catch {
        setState({ status: 'error', session: null, message: 'Sign-in is unavailable right now. You can still discover courts.' });
      }
    });
    return () => { active = false; cleanup?.(); };
  }, [revision]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (operation.current) throw new Error('Please wait for the current sign-in request.');
    operation.current = true;
    setBusy(true);
    try { await action(); }
    finally { operation.current = false; setBusy(false); }
  }, []);
  const retry = () => {
    if (!operation.current) {
      setState({ status: 'restoring', session: null, message: null });
      setRevision((value) => value + 1);
    }
  };
  const requireReady = () => {
    if (state.status !== 'ready') throw new Error('Please wait for sign-in to become available.');
    return getSupabase().auth;
  };

  return <AuthContext.Provider value={{
    ...state, busy, retry,
    clearSaved: () => run(async () => {
      await clearSavedSession();
      setState({ status: 'restoring', session: null, message: null });
      setRevision((value) => value + 1);
    }),
    requestCode: (email) => run(() => requestEmailCode(requireReady(), email)),
    verifyCode: (email, code) => run(() => verifyEmailCode(requireReady(), email, code)),
    signInApple: () => run(() => signInApple(requireReady(), applePort)),
    signOut: () => run(async () => {
      const auth = requireReady();
      const { error } = await auth.signOut({ scope: 'local' });
      // SDK removes the local session even if remote revocation fails offline.
      if (error) {
        const result = await auth.getSession();
        if (result.error || result.data.session) throw new Error('We couldn’t sign out. Please try again.');
      }
    }),
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication context is unavailable.');
  return value;
}
