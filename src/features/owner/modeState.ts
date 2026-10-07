export type OwnerModeState = { identity: string | null; generation: number; count: number | null; mode: 'player' | 'owner'; error: boolean };
export const initialMode = (identity: string | null): OwnerModeState => ({ identity, generation: 0, count: null, mode: 'player', error: false });
export function checkingMode(state: OwnerModeState): OwnerModeState { return { ...state, generation: state.generation + 1, count: null, error: false }; }
/** Any signed-in account may use Owner mode (to add or claim a venue); a failed access check falls back to Player. */
export function checkedMode(state: OwnerModeState, identity: string | null, generation: number, count: number | null): OwnerModeState {
  if (identity !== state.identity || generation !== state.generation) return state;
  return { ...state, count, error: count === null, mode: count === null ? 'player' : state.mode };
}
export function chooseMode(state: OwnerModeState, mode: 'player' | 'owner'): OwnerModeState {
  return { ...state, mode: mode === 'owner' && state.count === null ? 'player' : mode };
}
