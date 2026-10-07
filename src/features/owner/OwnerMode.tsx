import { Redirect, usePathname } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/colors';

import { loadManagedVenueCount } from './liveOwner';
import { checkedMode, checkingMode, chooseMode, initialMode } from './modeState';

type ModeContext = { count: number | null; mode: 'player' | 'owner'; error: boolean; setMode: (mode: 'player' | 'owner') => void; refresh: () => void };
const Context = createContext<ModeContext | null>(null);

export function OwnerModeProvider({ children }: { children: ReactNode }) {
  const { session, status } = useAuth();
  const identity = status === 'ready' ? session?.user.id ?? null : null;
  // A fresh provider discards mode and pending callbacks at every identity change.
  return <AccountMode key={identity ?? 'guest'} identity={identity}>{children}</AccountMode>;
}

function AccountMode({ identity, children }: { identity: string | null; children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState(() => initialMode(identity));
  const current = useRef(state);
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    const next = checkingMode(current.current); current.current = next; setState(next); setCheckedPath(null);
    if (!identity || AppState.currentState !== 'active') return;
    const requestedPath = pathname;
    void loadManagedVenueCount().then((count) => {
      if (!alive.current) return;
      const updated = checkedMode(current.current, identity, next.generation, count);
      if (updated === current.current) return;
      current.current = updated; setState(updated); setCheckedPath(requestedPath);
    });
  }, [identity, pathname]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current = checkingMode(current.current); }; }, []);
  useEffect(() => { let active = true; void Promise.resolve().then(() => { if (active) refresh(); }); return () => { active = false; }; }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', () => refresh());
    return () => listener.remove();
  }, [refresh]);
  const count = checkedPath === pathname ? state.count : null;
  return <Context.Provider value={{ count, mode: state.mode, error: checkedPath === pathname && state.error,
    refresh, setMode: (mode) => { const next = chooseMode(current.current, mode); current.current = next; setState(next); } }}>
    {children}
  </Context.Provider>;
}

export function useOwnerMode() {
  const context = useContext(Context);
  if (!context) throw new Error('Owner mode is unavailable');
  return context;
}

export function OwnerModeSwitch() {
  const { session, status } = useAuth();
  const { count, mode, setMode, error, refresh } = useOwnerMode();
  if (status !== 'ready' || !session) return null;
  if (count === null) return <Card>
    <Text style={screenText.body} accessibilityLiveRegion="polite">{error ? 'Couldn’t check your venue access.' : 'Checking your venue access…'}</Text>
    {error && <Button label="Retry venue access" variant="secondary" onPress={refresh} />}
  </Card>;
  if (!count || count < 1) return null;
  return <Card>
    <Text accessibilityRole="header" style={screenText.title}>Your context</Text>
    <Text style={screenText.body}>{mode === 'owner' ? 'Owner mode: manage your verified venues from the Venues tab.' : 'Player mode: discover courts and follow your bookings.'}</Text>
    <View style={styles.row}>
      <Button label="Player mode" variant={mode === 'player' ? 'primary' : 'secondary'} onPress={() => setMode('player')} />
      <Button label="Owner mode" variant={mode === 'owner' ? 'primary' : 'secondary'} onPress={() => setMode('owner')} />
    </View>
  </Card>;
}

/** Inventory screens need current verified links and owner context. Submission/claim gates stay auth-only. */
export function VerifiedOwnerGate({ children }: { children: ReactNode }) {
  const { session, status } = useAuth();
  const { count, mode, error, refresh } = useOwnerMode();
  const checking = status === 'restoring' || (session && count === null && !error);
  if (checking) return <View style={styles.container}>
    {/* Keep the editor/picker state mounted while foreground access is checked. */}
    {session && mode === 'owner' && <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{children}</View>}
    <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Checking venue access" /></View>
  </View>;
  if (session && error) return <View style={styles.loading}>
    <Text style={screenText.body}>Couldn’t confirm your venue access.</Text><Button label="Try again" onPress={refresh} />
  </View>;
  if (!session || !count || mode !== 'owner') return <Redirect href="/account" />;
  return <View style={styles.container}><View style={styles.container}>{children}</View></View>;
}

const styles = StyleSheet.create({
  row: { gap: 8 },
  container: { flex: 1 }, hidden: { display: 'none' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 20, backgroundColor: colors.background },
});
