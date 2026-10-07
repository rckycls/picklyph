import { useEffect, useState } from 'react';
import { discoveryMascotPose } from './presentation';

export function useDiscoveryMascot(status: 'loading' | 'ready' | 'error', count: number, requestId: number) {
  const [slowRequest, setSlowRequest] = useState<number | null>(null);
  const initialLoad = status === 'loading' && count === 0;
  useEffect(() => {
    if (!initialLoad) return;
    const timer = setTimeout(() => setSlowRequest(requestId), 600);
    return () => clearTimeout(timer);
  }, [initialLoad, requestId]);
  return discoveryMascotPose(status, count, slowRequest === requestId);
}
