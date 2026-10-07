export type OwnerModeState = { identity: string | null; generation: number; count: number | null; mode: 'player' | 'owner'; error: boolean };
export const initialMode = (identity: string | null): OwnerModeState => ({ identity, generation: 0, count: null, mode: 'player', error: false });
export function checkingMode(state: OwnerModeState): OwnerModeState { return { ...state, generation: state.generation + 1, count: null, error: false }; }
export function checkedMode(state: OwnerModeState, identity: string | null, generation: number, count: number | null): OwnerModeState {
  if (identity !== state.identity || generation !== state.generation) return state;
  return { ...state, count, error: count === null, mode: count && count > 0 ? state.mode : 'player' };
}
export function chooseMode(state: OwnerModeState, mode: 'player' | 'owner'): OwnerModeState {
  return { ...state, mode: mode === 'owner' && !(state.count && state.count > 0) ? 'player' : mode };
}
