import { readRentalCommand, type RentalBookingResult, type RentalRequest } from '@picklyph/domain';
import { canForgetAttempt } from './model';
import type { RentalOutcome } from './client';

export type AttemptStore = { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void>; remove: (key: string) => Promise<void> };
/** Namespace by backend AND verified account. Contains no session token, price bands or personal names. */
export function createAttemptJournal(store: AttemptStore, namespace: string) {
  let busy = false;
  const key = `${namespace}.rental-attempt`;
  const read = async (): Promise<RentalRequest | null> => {
    const raw = await store.get(key);
    if (raw === null) return null;
    const command = readRentalCommand(JSON.parse(raw));
    if (command.kind !== 'request') throw new Error('Unreadable reservation recovery.');
    return command;
  };
  return {
    read,
    async run(command: RentalRequest, send: (command: RentalRequest) => Promise<RentalOutcome<RentalBookingResult>>) {
      if (busy) throw new Error('A reservation request is already running.');
      busy = true;
      try {
        const saved = await read();
        if (saved && JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Resolve your original reservation before starting another.');
        const original = saved ?? command;
        // Durability BEFORE dispatch; a storage failure must not create an untraceable hold.
        if (!saved) await store.set(key, JSON.stringify(original));
        const result = await send(original);
        if (result.ok || canForgetAttempt(result.failure)) await store.remove(key);
        return result;
      } finally { busy = false; }
    },
  };
}
