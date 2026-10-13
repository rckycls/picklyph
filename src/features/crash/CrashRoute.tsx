import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { setCrashRoute } from './crashLive';

/** Keeps the current screen's path for crash reports (T51d); renders nothing. */
export function CrashRoute() {
  const pathname = usePathname();
  useEffect(() => {
    setCrashRoute(pathname);
  }, [pathname]);
  return null;
}
