export const WELCOME_KEY = 'pickly.welcome.v1';
export type WelcomeChoice = 'player' | 'owner';
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> };

/** Expo launch URLs open the development client; application links retain their destination. */
export function isOrdinaryLaunch(url: string | null) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const expo = parsed.protocol === 'exp:' || parsed.protocol === 'exps:';
    if (expo) return !parsed.pathname || parsed.pathname === '/' || parsed.pathname === '/--/' || parsed.pathname === '/--';
    return parsed.hostname === 'expo-development-client' && (!parsed.pathname || parsed.pathname === '/');
  } catch { return false; }
}

export function welcomeDestination(choice: WelcomeChoice) {
  return choice === 'owner' ? '/account' : '/';
}

export function createWelcomeStore(storage: Storage) {
  let completed = false;
  return {
    async shouldWelcome(url: string | null) {
      if (completed || !isOrdinaryLaunch(url)) return false;
      try { const saved = await storage.getItem(WELCOME_KEY); return !completed && saved !== 'done'; }
      catch { return !completed; }
    },
    complete() {
      completed = true;
      // Navigation never waits on persistence; even a failed write completes this session.
      void storage.setItem(WELCOME_KEY, 'done').catch(() => {});
    },
  };
}
