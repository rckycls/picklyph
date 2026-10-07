import type { MascotPose } from './motion';

/** Only an initial, empty load gets a mascot; pagination and retained rows remain readable. */
export function discoveryMascotPose(status: 'loading' | 'ready' | 'error', count: number, slow: boolean): MascotPose | null {
  if (count > 0) return null;
  if (status === 'error') return 'oops';
  if (status === 'ready') return 'idle';
  return slow ? 'thinking' : null;
}
